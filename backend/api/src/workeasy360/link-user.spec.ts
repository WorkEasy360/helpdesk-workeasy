import type { PrismaClient } from '@digisoft/db';
import { LINKED_ACTION, LinkUserError, linkUser, type LinkUserRequest } from './link-user';

const W360 = '3F1F6A3E-1F0E-4D6A-9C50-4C0A1C1E0B11';
const ISSUER = 'https://accounts.workeasy360.test';

type Identity = { issuer: string; subject: string; userId: string; organizationId: string };
type UserRow = {
  id: string;
  organizationId: string;
  email: string;
  type: 'AGENT' | 'CUSTOMER';
  isActive: boolean;
  deletedAt: Date | null;
};

function build(options: { users?: UserRow[]; identities?: Identity[]; orgLinked?: boolean } = {}) {
  const users = options.users ?? [agentRow()];
  const identities = [...(options.identities ?? [])];
  const audits: Array<Record<string, unknown>> = [];
  const revoked: unknown[] = [];
  const org = { id: 'org1', name: 'Acme', deletedAt: null, workeasy360OrganizationId: W360.toLowerCase() };
  const prisma = {
    organization: {
      findUnique: async ({ where }: { where: { workeasy360OrganizationId: string } }) =>
        options.orgLinked === false || where.workeasy360OrganizationId !== org.workeasy360OrganizationId ? null : org,
    },
    user: {
      findUnique: async ({ where }: { where: { organizationId_email: { organizationId: string; email: string } } }) => {
        const row = users.find(
          (u) => u.organizationId === where.organizationId_email.organizationId && u.email === where.organizationId_email.email,
        );
        return row
          ? { ...row, externalIdentities: identities.filter((i) => i.userId === row.id).map(({ issuer, subject }) => ({ issuer, subject })) }
          : null;
      },
    },
    externalIdentity: {
      findUnique: async ({ where }: { where: { issuer_subject_organizationId: Omit<Identity, 'userId'> } }) => {
        const key = where.issuer_subject_organizationId;
        const found = identities.find(
          (i) => i.issuer === key.issuer && i.subject === key.subject && i.organizationId === key.organizationId,
        );
        if (!found) return null;
        const user = users.find((u) => u.id === found.userId)!;
        return { user: { id: user.id, email: user.email } };
      },
      create: ({ data }: { data: Identity }) => ({ kind: 'identity', data }),
    },
    refreshToken: {
      updateMany: (args: unknown) => ({ kind: 'revoke', args }),
    },
    auditLog: {
      create: ({ data }: { data: Record<string, unknown> }) => ({ kind: 'audit', data }),
    },
    $transaction: async (ops: Array<{ kind: string; data?: unknown; args?: unknown }>) =>
      ops.map((op) => {
        if (op.kind === 'identity') identities.push(op.data as Identity);
        if (op.kind === 'revoke') {
          revoked.push(op.args);
          return { count: 2 };
        }
        if (op.kind === 'audit') audits.push(op.data as Record<string, unknown>);
        return op;
      }),
  } as unknown as PrismaClient;
  return { prisma, identities, audits, revoked };
}

function agentRow(extra: Partial<UserRow> = {}): UserRow {
  return { id: 'u1', organizationId: 'org1', email: 'ada@acme.example', type: 'AGENT', isActive: true, deletedAt: null, ...extra };
}

const request = (extra: Partial<LinkUserRequest> = {}): LinkUserRequest => ({
  email: 'Ada@Acme.example',
  subject: 'sub-ada',
  workeasy360OrganizationId: W360,
  issuer: ISSUER,
  actor: 'ops@workeasy360.example',
  reason: 'ticket OPS-12: confirmed by phone',
  ...extra,
});

describe('linkUser (the operator-vouched link)', () => {
  it('links the account, ends its sessions and writes who, when, which accounts and why to the audit log', async () => {
    const t = build();
    const result = await linkUser(t.prisma, request());
    expect(result).toMatchObject({ changed: true, userId: 'u1', subject: 'sub-ada', sessionsEnded: 2 });
    expect(t.identities).toEqual([
      { organizationId: 'org1', userId: 'u1', issuer: ISSUER, subject: 'sub-ada', email: 'ada@acme.example' },
    ]);
    expect(t.revoked).toHaveLength(1);
    expect(t.audits).toHaveLength(1);
    const audit = t.audits[0]!;
    expect(audit).toMatchObject({ organizationId: 'org1', actorType: 'SYSTEM', action: LINKED_ACTION, entity: 'User', entityId: 'u1' });
    expect(audit['newValue']).toMatchObject({
      method: 'operator',
      operator: 'ops@workeasy360.example',
      reason: 'ticket OPS-12: confirmed by phone',
      issuer: ISSUER,
      subject: 'sub-ada',
      workeasy360OrganizationId: W360.toLowerCase(),
      email: 'ada@acme.example',
    });
    expect(typeof (audit['newValue'] as Record<string, unknown>)['linkedAt']).toBe('string');
  });

  it('is a no-op, with no second audit entry, when exactly that link exists', async () => {
    const t = build({ identities: [{ issuer: ISSUER, subject: 'sub-ada', userId: 'u1', organizationId: 'org1' }] });
    expect((await linkUser(t.prisma, request())).changed).toBe(false);
    expect(t.audits).toHaveLength(0);
    expect(t.revoked).toHaveLength(0);
  });

  it.each([
    ['actor', { actor: '  ' }, /--actor/],
    ['reason', { reason: '' }, /--reason/],
    ['subject', { subject: '' }, /subject/],
    ['issuer', { issuer: '' }, /issuer/],
    ['organization', { workeasy360OrganizationId: 'acme' }, /UUID/],
  ])('requires the %s', async (_name, extra, message) => {
    const t = build();
    await expect(linkUser(t.prisma, request(extra))).rejects.toThrow(message);
    expect(t.identities).toHaveLength(0);
  });

  it('refuses a Workeasy360 organization no Help Desk organization is linked to', async () => {
    const t = build({ orgLinked: false });
    await expect(linkUser(t.prisma, request())).rejects.toThrow(/link-workeasy360-organization/);
  });

  it('refuses an account outside the organization bound to that Workeasy360 organization', async () => {
    const t = build({ users: [agentRow({ organizationId: 'org2' })] });
    await expect(linkUser(t.prisma, request())).rejects.toThrow(/has no account/);
    expect(t.audits).toHaveLength(0);
  });

  it('refuses a customer, and a deactivated account', async () => {
    await expect(linkUser(build({ users: [agentRow({ type: 'CUSTOMER' })] }).prisma, request())).rejects.toThrow(/customer/);
    await expect(linkUser(build({ users: [agentRow({ isActive: false })] }).prisma, request())).rejects.toThrow(/deactivated/);
  });

  it('refuses an account already linked to another Workeasy360 account', async () => {
    const t = build({ identities: [{ issuer: ISSUER, subject: 'sub-other', userId: 'u1', organizationId: 'org1' }] });
    await expect(linkUser(t.prisma, request())).rejects.toThrow(LinkUserError);
    await expect(linkUser(t.prisma, request())).rejects.toThrow(/sub-other/);
    expect(t.identities).toHaveLength(1);
  });

  it('refuses a Workeasy360 account already linked to someone else in the organization', async () => {
    const t = build({
      users: [agentRow(), agentRow({ id: 'u2', email: 'bob@acme.example' })],
      identities: [{ issuer: ISSUER, subject: 'sub-ada', userId: 'u2', organizationId: 'org1' }],
    });
    await expect(linkUser(t.prisma, request())).rejects.toThrow(/bob@acme.example/);
    expect(t.audits).toHaveLength(0);
  });

  it('after an issuer move, relinks the same subject under the new issuer, never another subject', async () => {
    const moved = build({ identities: [{ issuer: 'https://auth.old.test', subject: 'sub-ada', userId: 'u1', organizationId: 'org1' }] });
    expect((await linkUser(moved.prisma, request())).changed).toBe(true);

    const other = build({ identities: [{ issuer: 'https://auth.old.test', subject: 'sub-x', userId: 'u1', organizationId: 'org1' }] });
    await expect(linkUser(other.prisma, request())).rejects.toThrow(/sub-x/);
  });
});

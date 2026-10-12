import type { PrismaClient } from '@digisoft/db';
import { LinkOrganizationError, linkOrganization } from './link-organization';

const W360 = '3F1F6A3E-1F0E-4D6A-9C50-4C0A1C1E0B11';

type Row = { id: string; name: string; deletedAt: Date | null; workeasy360OrganizationId: string | null };

function build(rows: Row[]) {
  const updates: { id: string; value: string }[] = [];
  const revoked: unknown[] = [];
  const prisma = {
    organization: {
      findUnique: async ({ where }: { where: { id?: string; workeasy360OrganizationId?: string } }) =>
        rows.find((row) =>
          where.id !== undefined ? row.id === where.id : row.workeasy360OrganizationId === where.workeasy360OrganizationId,
        ) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: { workeasy360OrganizationId: string } }) => {
        updates.push({ id: where.id, value: data.workeasy360OrganizationId });
      },
    },
    refreshToken: {
      updateMany: async (args: unknown) => {
        revoked.push(args);
        return { count: 1 };
      },
    },
  } as unknown as Pick<PrismaClient, 'organization' | 'refreshToken'>;
  return { prisma, updates, revoked };
}

const org = (extra: Partial<Row> = {}): Row => ({
  id: 'org1',
  name: 'Acme',
  deletedAt: null,
  workeasy360OrganizationId: null,
  ...extra,
});

describe('linkOrganization', () => {
  it('binds an unlinked organization, normalising the UUID to lower case', async () => {
    const t = build([org()]);
    const result = await linkOrganization(t.prisma, 'org1', W360);
    expect(result).toMatchObject({ changed: true, workeasy360OrganizationId: W360.toLowerCase() });
    expect(t.updates).toEqual([{ id: 'org1', value: W360.toLowerCase() }]);
  });

  it('ends the organization\'s agent sessions, and only those, when it links', async () => {
    const t = build([org()]);
    await linkOrganization(t.prisma, 'org1', W360);
    expect(t.revoked).toHaveLength(1);
    const args = t.revoked[0] as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect(args.where).toMatchObject({ organizationId: 'org1', revokedAt: null, user: { type: 'AGENT' } });
    expect(args.data['revokedAt']).toBeInstanceOf(Date);
  });

  it('revokes nothing when nothing changed or the link was refused', async () => {
    const same = build([org({ workeasy360OrganizationId: W360.toLowerCase() })]);
    await linkOrganization(same.prisma, 'org1', W360);
    const refused = build([org({ workeasy360OrganizationId: '11111111-1111-4111-8111-111111111111' })]);
    await expect(linkOrganization(refused.prisma, 'org1', W360)).rejects.toThrow();
    expect(same.revoked).toHaveLength(0);
    expect(refused.revoked).toHaveLength(0);
  });

  it('is a no-op when it is already linked to exactly that organization', async () => {
    const t = build([org({ workeasy360OrganizationId: W360.toLowerCase() })]);
    expect((await linkOrganization(t.prisma, 'org1', W360)).changed).toBe(false);
    expect(t.updates).toHaveLength(0);
  });

  it('refuses to move an organization to a different Workeasy360 organization', async () => {
    const t = build([org({ workeasy360OrganizationId: '11111111-1111-4111-8111-111111111111' })]);
    await expect(linkOrganization(t.prisma, 'org1', W360)).rejects.toThrow(/already linked/);
    expect(t.updates).toHaveLength(0);
  });

  it('refuses when another Help Desk organization already holds the Workeasy360 organization', async () => {
    const t = build([org(), org({ id: 'org2', name: 'Ghost', workeasy360OrganizationId: W360.toLowerCase() })]);
    await expect(linkOrganization(t.prisma, 'org1', W360)).rejects.toThrow(/Ghost/);
    expect(t.updates).toHaveLength(0);
  });

  it('refuses an unknown or deleted organization and a malformed id', async () => {
    const t = build([org({ id: 'gone', deletedAt: new Date() })]);
    await expect(linkOrganization(t.prisma, 'nope', W360)).rejects.toBeInstanceOf(LinkOrganizationError);
    await expect(linkOrganization(t.prisma, 'gone', W360)).rejects.toBeInstanceOf(LinkOrganizationError);
    await expect(linkOrganization(t.prisma, 'org1', 'not-a-uuid')).rejects.toThrow(/UUID/);
    await expect(linkOrganization(t.prisma, ' ', W360)).rejects.toThrow(/required/);
  });
});

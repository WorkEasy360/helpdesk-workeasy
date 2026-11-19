import { BackgroundGate, type OrganizationLinkSource } from './background-gate';
import type { EntitlementAccess, EntitlementCache, EntitlementLogger } from './entitlement';

const LINKED = '3f1f6a3e-1f0e-4d6a-9c50-4c0a1c1e0b11';

function build(options: { configured?: boolean; links?: Record<string, string | null> } = {}) {
  let now = 1_700_000_000_000;
  const lookups: string[] = [];
  const prisma: OrganizationLinkSource = {
    organization: {
      findUnique: async ({ where }) => {
        lookups.push(where.id);
        const links = options.links ?? { linked: LINKED, plain: null };
        return where.id in links ? { workeasy360OrganizationId: links[where.id] ?? null } : null;
      },
    },
  };
  const asked: { id: string; subject: string | undefined }[] = [];
  let answer: EntitlementAccess = { allowed: true, writeAllowed: true, reason: 'entitled', status: 'allow' };
  const entitlements = {
    check: async (id: string, opts?: { subject?: string }) => {
      asked.push({ id, subject: opts?.subject });
      return answer;
    },
  } as unknown as EntitlementCache;
  const logs: { message: string; meta: Record<string, unknown> }[] = [];
  const logger: EntitlementLogger = {
    info: () => undefined,
    error: () => undefined,
    warn: (meta, message) => logs.push({ meta, message }),
  };
  const gate = new BackgroundGate({
    prisma,
    entitlements: options.configured === false ? null : entitlements,
    logger,
    now: () => now,
  });
  return {
    gate,
    asked,
    lookups,
    logs,
    setAnswer: (next: EntitlementAccess) => {
      answer = next;
    },
    advance: (seconds: number) => {
      now += seconds * 1000;
    },
  };
}

const denied: EntitlementAccess = { allowed: false, writeAllowed: false, reason: 'expired', status: 'deny' };

describe('BackgroundGate', () => {
  it('never asks about an organization that is not bound to Workeasy360', async () => {
    const t = build();
    expect(await t.gate.check('plain')).toEqual({ allowed: true });
    expect(t.asked).toHaveLength(0);
  });

  it('allows an unknown organization row (nothing to lose)', async () => {
    const t = build();
    expect((await t.gate.check('missing')).allowed).toBe(true);
    expect(t.asked).toHaveLength(0);
  });

  it('asks at the organization level, with no subject', async () => {
    const t = build();
    expect((await t.gate.check('linked')).allowed).toBe(true);
    expect(t.asked).toEqual([{ id: LINKED, subject: undefined }]);
  });

  it('denies and logs workeasy360.background_skipped when access ended', async () => {
    const t = build();
    t.setAnswer(denied);
    expect(await t.gate.allows('linked', 'automation', { jobId: 'j1' })).toBe(false);
    expect(t.logs).toEqual([
      {
        message: 'workeasy360.background_skipped',
        meta: { organizationId: 'linked', job: 'automation', reason: 'expired', jobId: 'j1' },
      },
    ]);
  });

  it('requires writes: a read-only organization produces no business effect', async () => {
    const t = build();
    t.setAnswer({ allowed: true, writeAllowed: false, reason: 'read_only', status: 'allow' });
    expect(await t.gate.allows('linked', 'webhook')).toBe(false);
    expect(t.logs[0]!.meta['reason']).toBe('read_only');
  });

  it('fails closed when Workeasy360 refused our own client', async () => {
    const t = build();
    t.setAnswer({ allowed: false, writeAllowed: false, reason: 'refused', status: 'refused' });
    expect(await t.gate.allows('linked', 'ai')).toBe(false);
  });

  it('lets work continue when no answer was ever available (an outage is never a denial)', async () => {
    const t = build();
    t.setAnswer({ allowed: true, writeAllowed: true, reason: 'unchecked', status: 'unchecked' });
    expect(await t.gate.allows('linked', 'ai')).toBe(true);
  });

  it('checks nothing when Workeasy360 is not configured in this process', async () => {
    const t = build({ configured: false });
    expect(await t.gate.allows('linked', 'automation')).toBe(true);
    expect(t.lookups).toHaveLength(0);
  });

  it('remembers an organization binding for a minute', async () => {
    const t = build();
    await t.gate.check('linked');
    await t.gate.check('linked');
    expect(t.lookups).toHaveLength(1);
    t.advance(61);
    await t.gate.check('linked');
    expect(t.lookups).toHaveLength(2);
  });

  it('a sweep checks each distinct organization once, however many tickets it has', async () => {
    const t = build({ links: { a: LINKED, b: null, c: '11111111-1111-4111-8111-111111111111' } });
    t.setAnswer(denied);
    const allowed = t.gate.sweep('sla-scan');
    const verdicts = await Promise.all(['a', 'a', 'b', 'a', 'c', 'c', 'b'].map((id) => allowed(id)));
    expect(verdicts).toEqual([false, false, true, false, false, false, true]);
    expect(t.asked.map((q) => q.id).sort()).toEqual([LINKED, '11111111-1111-4111-8111-111111111111'].sort());
    expect(t.logs.filter((l) => l.message === 'workeasy360.background_skipped')).toHaveLength(2);
  });
});

describe('BackgroundGate denial bookkeeping', () => {
  it('knows which organizations are denied right now, and forgets them when the denial is due to be asked again', async () => {
    const t = build();
    t.setAnswer(denied);
    await t.gate.check('linked');
    expect(t.gate.deniedOrganizations()).toEqual(['linked']);
    t.advance(899);
    expect(t.gate.deniedOrganizations()).toEqual(['linked']);
    t.advance(2);
    expect(t.gate.deniedOrganizations()).toEqual([]);
  });

  it('forgets a denial as soon as the organization is allowed again', async () => {
    const t = build();
    t.setAnswer(denied);
    await t.gate.check('linked');
    t.setAnswer({ allowed: true, writeAllowed: true, reason: 'entitled', status: 'allow' });
    await t.gate.check('linked');
    expect(t.gate.deniedOrganizations()).toEqual([]);
  });

  it('re-asks a refused organization after a minute, not fifteen', async () => {
    const t = build();
    t.setAnswer({ allowed: false, writeAllowed: false, reason: 'refused', status: 'refused' });
    await t.gate.check('linked');
    t.advance(61);
    expect(t.gate.deniedOrganizations()).toEqual([]);
  });

  it('logs a sweep skip once per denial, not on every sweep, and again when the reason changes', async () => {
    const t = build();
    t.setAnswer(denied);
    for (let sweep = 0; sweep < 4; sweep += 1) await t.gate.sweep('sla-scan')('linked');
    expect(t.logs.filter((l) => l.message === 'workeasy360.background_skipped')).toHaveLength(1);

    t.setAnswer({ ...denied, reason: 'suspended' });
    await t.gate.sweep('sla-scan')('linked');
    expect(t.logs.filter((l) => l.message === 'workeasy360.background_skipped')).toHaveLength(2);

    t.setAnswer({ allowed: true, writeAllowed: true, reason: 'entitled', status: 'allow' });
    await t.gate.sweep('sla-scan')('linked');
    t.setAnswer(denied);
    await t.gate.sweep('sla-scan')('linked');
    expect(t.logs.filter((l) => l.message === 'workeasy360.background_skipped')).toHaveLength(3);
  });
});

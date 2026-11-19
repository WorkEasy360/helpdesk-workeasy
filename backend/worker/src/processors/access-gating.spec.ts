import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Job } from 'bullmq';
import {
  BackgroundGate,
  type EntitlementAccess,
  type EntitlementCache,
  type EntitlementLogger,
} from '@digisoft/workeasy360';
import { OPEN_GATE, type AccessGate } from '../access-gate';
import { handleAutomation } from './automation.processor';
import { handleChannelSend } from './channel-send.processor';
import { handleDeliverNotification } from './deliver-notification.processor';
import { handleAiAnalyse } from './ai.processor';
import { handleSendEmail } from './send-email.processor';
import { handleSlaScan } from './sla.processor';
import { handleWebhookDelivery } from './webhook.processor';

/**
 * Class A background work (completion design section 5) re-checks the organization's
 * Workeasy360 entitlement right before producing a business effect. A denied organization's
 * job is skipped - logged as workeasy360.background_skipped, never thrown, so it is not
 * retried in a loop - and an allowed or unbound organization's job runs as before.
 */

const LINKED = '3f1f6a3e-1f0e-4d6a-9c50-4c0a1c1e0b11';
const OTHER_LINKED = '9a8c7d6e-5f4e-4d3c-8b2a-1a0b9c8d7e6f';

const allow: EntitlementAccess = { allowed: true, writeAllowed: true, reason: 'entitled', status: 'allow' };
const deny: EntitlementAccess = { allowed: false, writeAllowed: false, reason: 'expired', status: 'deny' };

const job = <T>(data: T, id = 'job-1'): Job<T> => ({ id, data }) as unknown as Job<T>;

/** A Prisma stand-in that records every model call and answers with nothing. */
function recordingPrisma(answers: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const prisma = new Proxy(
    {},
    {
      get: (_target, model: string) =>
        new Proxy(
          {},
          {
            get: (_t, method: string) => async () => {
              calls.push(`${model}.${method}`);
              const answer = answers[`${model}.${method}`];
              return typeof answer === 'function' ? (answer as () => unknown)() : (answer ?? null);
            },
          },
        ),
    },
  );
  return { prisma: prisma as never, calls };
}

interface Built {
  gate: BackgroundGate;
  asked: string[];
  logs: { message: string; meta: Record<string, unknown> }[];
  setAnswer: (answer: EntitlementAccess) => void;
}

/** The real gate over a fake entitlement answer and a fake organization table. */
function realGate(links: Record<string, string | null>): Built {
  let answer = deny;
  const asked: string[] = [];
  const logs: Built['logs'] = [];
  const logger: EntitlementLogger = {
    info: () => undefined,
    error: () => undefined,
    warn: (meta, message) => logs.push({ message, meta }),
  };
  const gate = new BackgroundGate({
    prisma: {
      organization: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          where.id in links ? { workeasy360OrganizationId: links[where.id] ?? null } : null,
      },
    },
    entitlements: {
      check: async (id: string, options?: { subject?: string }) => {
        expect(options?.subject).toBeUndefined();
        asked.push(id);
        return answer;
      },
    } as unknown as EntitlementCache,
    logger,
  });
  return { gate, asked, logs, setAnswer: (next) => (answer = next) };
}

const denied = (): Built => realGate({ 'org-ended': LINKED, 'org-plain': null });

const skippedLog = (built: Built, job: string) =>
  built.logs.filter((l) => l.message === 'workeasy360.background_skipped' && l.meta['job'] === job);

describe('automation (class A)', () => {
  const engine = (prisma: never) => ({ prisma, redis: {}, emailQueue: { add: async () => undefined }, log: () => undefined }) as never;

  it('skips an organization whose access ended, logs it, and does not touch its rules', async () => {
    const built = denied();
    const { prisma, calls } = recordingPrisma();
    const result = await handleAutomation(
      job({ organizationId: 'org-ended', ticketId: 't1', trigger: 'TICKET_CREATED' as never }),
      engine(prisma),
      built.gate,
    );
    expect(result).toEqual({ evaluated: 0, fired: 0, skipped: true });
    expect(calls).toEqual([]);
    expect(skippedLog(built, 'automation')).toHaveLength(1);
    expect(skippedLog(built, 'automation')[0]!.meta).toMatchObject({ organizationId: 'org-ended', reason: 'expired', jobId: 'job-1' });
  });

  it('runs for an organization that is entitled', async () => {
    const built = denied();
    built.setAnswer(allow);
    const { prisma, calls } = recordingPrisma({ 'automationRule.findMany': [] });
    const result = await handleAutomation(
      job({ organizationId: 'org-ended', ticketId: 't1', trigger: 'TICKET_CREATED' as never }),
      engine(prisma),
      built.gate,
    );
    expect(result).toMatchObject({ evaluated: 0, fired: 0 });
    expect(calls).toContain('automationRule.findMany');
  });

  it('runs for an organization that is not bound to Workeasy360, without asking', async () => {
    const built = denied();
    const { prisma, calls } = recordingPrisma({ 'automationRule.findMany': [] });
    await handleAutomation(job({ organizationId: 'org-plain', ticketId: 't1', trigger: 'TICKET_CREATED' as never }), engine(prisma), built.gate);
    expect(calls).toContain('automationRule.findMany');
    expect(built.asked).toHaveLength(0);
  });

  it('never throws for a denied organization, so the queue does not retry it', async () => {
    const built = denied();
    const { prisma } = recordingPrisma();
    await expect(
      handleAutomation(job({ organizationId: 'org-ended', ticketId: 't1', trigger: 'TICKET_CREATED' as never }), engine(prisma), built.gate),
    ).resolves.toBeDefined();
  });
});

describe('channel send (class A)', () => {
  const data = { organizationId: 'org-ended', channelId: 'c1', ticketId: 't1', messageId: 'm1', to: 'x@y.example' };
  const deps = (prisma: never, gate: AccessGate) => ({
    prisma,
    gate,
    logger: { warn: () => undefined, info: () => undefined } as never,
    sendEmail: async () => {
      throw new Error('must not be sent');
    },
  });

  it('does not deliver a reply for an organization whose access ended', async () => {
    const built = denied();
    const { prisma, calls } = recordingPrisma();
    expect(await handleChannelSend(job(data), deps(prisma, built.gate))).toEqual({ delivered: false, externalId: null });
    expect(calls).toEqual([]);
    expect(skippedLog(built, 'channel-send')).toHaveLength(1);
  });

  it('goes ahead for an entitled organization', async () => {
    const built = denied();
    built.setAnswer(allow);
    const { prisma, calls } = recordingPrisma();
    await handleChannelSend(job(data), deps(prisma, built.gate));
    expect(calls).toContain('channel.findFirst');
  });
});

describe('outbound webhooks (class A)', () => {
  const data = { organizationId: 'org-ended', deliveryId: 'd1' };
  const deps = (prisma: never, gate: AccessGate) => ({
    prisma,
    gate,
    maxAttempts: 5,
    logger: { warn: () => undefined } as never,
  });

  it('does not call a customer endpoint for an organization whose access ended, and leaves the delivery for a replay', async () => {
    const built = denied();
    const { prisma, calls } = recordingPrisma();
    expect(await handleWebhookDelivery(job(data), deps(prisma, built.gate))).toEqual({ delivered: false, status: null });
    expect(calls).toEqual([]);
    expect(skippedLog(built, 'webhook')[0]!.meta).toMatchObject({ deliveryId: 'd1' });
  });

  it('loads the delivery for an entitled organization', async () => {
    const built = denied();
    built.setAnswer(allow);
    const { prisma, calls } = recordingPrisma();
    await handleWebhookDelivery(job(data), deps(prisma, built.gate));
    expect(calls).toContain('webhookDelivery.findFirst');
  });
});

describe('AI analysis (class A)', () => {
  const data = { organizationId: 'org-ended', ticketId: 't1', reason: 'TICKET_CREATED' as const };
  const deps = (prisma: never, gate: AccessGate) =>
    ({ prisma, gate, logger: { info: () => undefined } as never, log: () => undefined }) as never;

  it('spends nothing for an organization whose access ended', async () => {
    const built = denied();
    const { prisma, calls } = recordingPrisma();
    const result = await handleAiAnalyse(job(data), deps(prisma, built.gate));
    expect(result.generated).toEqual([]);
    expect(calls).toEqual([]);
    expect(skippedLog(built, 'ai')).toHaveLength(1);
  });

  it('reads the organization\'s settings when it is entitled', async () => {
    const built = denied();
    built.setAnswer(allow);
    const { prisma, calls } = recordingPrisma();
    await handleAiAnalyse(job(data), deps(prisma, built.gate)).catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('notifications (class A)', () => {
  const data = { organizationId: 'org-ended', userId: 'u1', type: 'sla.warning', title: 'Due soon' };
  const deps = (prisma: never, gate: AccessGate, published: string[]) => ({
    prisma,
    gate,
    redis: { publish: async (channel: string) => published.push(channel) } as never,
    logger: { debug: () => undefined } as never,
  });

  it('creates and publishes nothing for an organization whose access ended', async () => {
    const built = denied();
    const { prisma, calls } = recordingPrisma();
    const published: string[] = [];
    expect(await handleDeliverNotification(job(data), deps(prisma, built.gate, published))).toEqual({ notificationId: null });
    expect(calls).toEqual([]);
    expect(published).toEqual([]);
    expect(skippedLog(built, 'notification')).toHaveLength(1);
  });

  it('delivers for an entitled organization', async () => {
    const built = denied();
    built.setAnswer(allow);
    const { prisma, calls } = recordingPrisma({ 'notification.create': { id: 'n1' } });
    const published: string[] = [];
    expect(await handleDeliverNotification(job(data), deps(prisma, built.gate, published))).toEqual({ notificationId: 'n1' });
    expect(calls).toContain('notification.create');
    expect(published).toHaveLength(1);
  });
});

describe('email (class A for what the business produces, never for account security)', () => {
  const email = (extra: Record<string, unknown> = {}) =>
    job({ organizationId: 'org-ended', to: 'c@x.example', subject: 's', html: '<p>h</p>', text: 't', ...extra });
  const deps = (gate: AccessGate, sent: string[]) => ({
    gate,
    logger: { info: () => undefined } as never,
    emailProvider: { name: 'fake', send: async (m: { to: string }) => (sent.push(m.to), 'id-1') } as never,
  });

  it('holds back an automation\'s or a survey\'s email when access ended', async () => {
    const built = denied();
    const sent: string[] = [];
    expect(await handleSendEmail(email({ requiresAccess: true }), deps(built.gate, sent))).toEqual({ providerMessageId: null });
    expect(sent).toEqual([]);
    expect(skippedLog(built, 'email')).toHaveLength(1);
  });

  it('sends it when the organization is entitled', async () => {
    const built = denied();
    built.setAnswer(allow);
    const sent: string[] = [];
    await handleSendEmail(email({ requiresAccess: true }), deps(built.gate, sent));
    expect(sent).toEqual(['c@x.example']);
  });

  it('never holds back account-security mail (reset, verification, invitation), whatever the organization\'s state', async () => {
    const built = denied();
    const sent: string[] = [];
    await handleSendEmail(email(), deps(built.gate, sent));
    expect(sent).toEqual(['c@x.example']);
    expect(built.asked).toHaveLength(0);
  });

  it('sends mail that belongs to no organization', async () => {
    const built = denied();
    const sent: string[] = [];
    await handleSendEmail(email({ organizationId: null, requiresAccess: true }), deps(built.gate, sent));
    expect(sent).toHaveLength(1);
  });
});

describe('the SLA scan (class A, global)', () => {
  interface Row {
    id: string;
    organizationId: string;
  }

  function scan(links: Record<string, string | null>, tickets: Row[]) {
    const built = realGate(links);
    const stamped: string[] = [];
    const queued: { organizationId: string; ticketId: string }[] = [];
    const published: string[] = [];
    const prisma = {
      ticket: {
        // The sweep asks, in order: first-response breaches, resolution breaches, warnings.
        findMany: (() => {
          let call = 0;
          return async () => (call++ === 0 ? tickets : []);
        })(),
        update: async ({ where }: { where: { id: string } }) => {
          stamped.push(where.id);
        },
        findFirst: async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          ticketNumber: 1,
          subject: 'Printer',
          departmentId: null,
          assignedAgentId: 'agent-1',
          followers: [],
        }),
      },
      notification: { create: async () => ({ id: 'n1' }) },
      auditLog: { create: async () => ({}) },
    } as never;
    const deps = {
      prisma,
      redis: { publish: async (channel: string) => published.push(channel) },
      emailQueue: { add: async () => undefined },
      log: () => undefined,
    } as never;
    const queue = { add: async (_name: string, data: { organizationId: string; ticketId: string }) => queued.push(data) } as never;
    return { built, stamped, queued, published, run: () => handleSlaScan(deps, queue, built.gate) };
  }

  const tickets: Row[] = [
    { id: 'a1', organizationId: 'org-ended' },
    { id: 'b1', organizationId: 'org-plain' },
    { id: 'a2', organizationId: 'org-ended' },
    { id: 'a3', organizationId: 'org-ended' },
  ];

  it('leaves a denied organization\'s tickets untouched - not stamped, so they are raised after renewal', async () => {
    const t = scan({ 'org-ended': LINKED, 'org-plain': null }, tickets);
    const result = await t.run();
    expect(result).toEqual({ events: 1 });
    expect(t.stamped).toEqual(['b1']);
    expect(t.queued.map((q) => q.organizationId)).toEqual(['org-plain']);
  });

  it('checks each distinct organization once per sweep, however many tickets it has', async () => {
    const t = scan({ 'org-ended': LINKED, 'org-plain': null }, tickets);
    await t.run();
    expect(t.built.asked).toEqual([LINKED]);
    expect(skippedLog(t.built, 'sla-scan')).toHaveLength(1);
  });

  it('raises everything for an entitled organization', async () => {
    const t = scan({ 'org-ended': LINKED, 'org-plain': null }, tickets);
    t.built.setAnswer(allow);
    const result = await t.run();
    expect(result).toEqual({ events: 4 });
    expect(t.stamped.sort()).toEqual(['a1', 'a2', 'a3', 'b1']);
  });

  it('asks about every bound organization separately', async () => {
    const t = scan(
      { 'org-ended': LINKED, 'org-other': OTHER_LINKED },
      [
        { id: 'a1', organizationId: 'org-ended' },
        { id: 'o1', organizationId: 'org-other' },
        { id: 'o2', organizationId: 'org-other' },
      ],
    );
    await t.run();
    expect([...t.built.asked].sort()).toEqual([LINKED, OTHER_LINKED].sort());
    expect(t.stamped).toEqual([]);
  });

  it('does not gate anything when Workeasy360 is not configured', async () => {
    const stamped: string[] = [];
    const prisma = {
      ticket: {
        findMany: (() => {
          let call = 0;
          return async () => (call++ === 0 ? [{ id: 'x', organizationId: 'org-ended' }] : []);
        })(),
        update: async ({ where }: { where: { id: string } }) => {
          stamped.push(where.id);
        },
        findFirst: async () => null,
      },
    } as never;
    await handleSlaScan(
      { prisma, redis: {}, emailQueue: { add: async () => undefined }, log: () => undefined } as never,
      { add: async () => undefined } as never,
      OPEN_GATE,
    );
    expect(stamped).toEqual(['x']);
  });
});

describe('which processors are gated (the classification table in docs/workeasy360-sso.md)', () => {
  const source = (file: string): string => readFileSync(join(__dirname, file), 'utf8');

  it.each([
    ['automation.processor.ts'],
    ['channel-send.processor.ts'],
    ['webhook.processor.ts'],
    ['ai.processor.ts'],
    ['sla.processor.ts'],
    ['deliver-notification.processor.ts'],
    ['send-email.processor.ts'],
  ])('%s checks the gate (class A)', (file) => {
    expect(source(file)).toMatch(/gate\.(allows|sweep)\(/);
    expect(source(file)).toContain('Class A');
  });

  it('the analytics processors never do (class B export, class C rollup)', () => {
    const analytics = source('analytics.processor.ts');
    expect(analytics).not.toMatch(/gate\./);
    expect(analytics).toContain('Class B');
    expect(analytics).toContain('Class C');
  });
});

describe('the SLA scan does not keep reloading a denied organization', () => {
  function run(built: Built, tickets: { id: string; organizationId: string }[]) {
    const queries: Record<string, unknown>[] = [];
    const prisma = {
      ticket: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          queries.push(args.where);
          const excluded = (args.where['organizationId'] as { notIn?: string[] } | undefined)?.notIn ?? [];
          return queries.length === 1 ? tickets.filter((t) => !excluded.includes(t.organizationId)) : [];
        },
        update: async () => undefined,
        findFirst: async () => null,
      },
    } as never;
    const deps = { prisma, redis: {}, emailQueue: { add: async () => undefined }, log: () => undefined } as never;
    return { queries, sweep: () => handleSlaScan(deps, { add: async () => undefined } as never, built.gate) };
  }

  it('leaves a known-denied organization out of the next sweep\'s queries, and logs its denial once', async () => {
    const built = denied();
    const tickets = [{ id: 'a1', organizationId: 'org-ended' }, { id: 'b1', organizationId: 'org-plain' }];

    const first = run(built, tickets);
    await first.sweep();
    // The first sweep did not know yet: nothing excluded.
    expect(first.queries[0]).not.toHaveProperty('organizationId');

    const second = run(built, tickets);
    await second.sweep();
    expect(second.queries[0]).toMatchObject({ organizationId: { notIn: ['org-ended'] } });
    // ...and the denial was announced once, not once per sweep.
    expect(skippedLog(built, 'sla-scan')).toHaveLength(1);
  });

  it('asks about the organization again when its denial is due, and resumes after renewal', async () => {
    jest.useFakeTimers({ now: Date.now() });
    try {
      const built = denied();
      const tickets = [{ id: 'a1', organizationId: 'org-ended' }];
      await run(built, tickets).sweep();
      expect(built.gate.deniedOrganizations()).toEqual(['org-ended']);
      jest.advanceTimersByTime(901_000);
      expect(built.gate.deniedOrganizations()).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });
});

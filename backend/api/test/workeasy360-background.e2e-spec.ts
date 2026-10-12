import request from 'supertest';
import type { Server } from 'node:http';
import type { Queue } from 'bullmq';
import { runTrigger, scanSla, type EngineDeps } from '@digisoft/engine';
import { apiPath, createHarness, registerOrg, resetDatabase, type Harness } from './app.harness';
import { MailerService } from '../src/email/mailer.service';
import { EngineService } from '../src/engine/engine.service';
import { EMAIL_QUEUE } from '../src/queue/queue.module';
import type { SendEmailJob } from '../src/queue/queue.constants';

/**
 * Background work against the real database (completion design section 5): the SLA scan
 * leaves a denied organization's tickets untouched, and every enqueue site marks what the
 * worker must re-check (class A) and what it must not (account-security mail). The
 * processors themselves are tested in the worker package.
 */
describe('Background work and Workeasy360 access (e2e)', () => {
  let harness: Harness;
  let http: Server;
  let emailQueue: Queue<SendEmailJob>;

  beforeAll(async () => {
    harness = await createHarness();
    http = harness.app.getHttpServer() as Server;
    emailQueue = harness.app.get<Queue<SendEmailJob>>(EMAIL_QUEUE);
  });

  beforeEach(async () => {
    await resetDatabase(harness.prisma, harness.redis);
    await emailQueue.obliterate({ force: true });
  });

  afterAll(async () => {
    await emailQueue.obliterate({ force: true }).catch(() => undefined);
    await harness.close();
  });

  async function organizationWithTicket(slug: string) {
    const org = await registerOrg(http, slug);
    const auth = { Authorization: `Bearer ${org.token}` };
    const ticket = await request(http)
      .post(apiPath('/tickets'))
      .set(auth)
      .send({ subject: `Printer in ${slug}`, description: 'It jams.' })
      .expect(201);
    const ticketId = ticket.body.data.id as string;
    // Past due on both targets, with no response yet.
    await harness.prisma.ticket.update({
      where: { id: ticketId },
      data: { firstResponseDueAt: new Date(Date.now() - 60_000), resolutionDueAt: new Date(Date.now() - 30_000) },
    });
    return { ...org, auth, ticketId };
  }

  describe('the SLA scan', () => {
    it('skips a denied organization\'s tickets, leaves them unstamped, and raises them once access is back', async () => {
      const ended = await organizationWithTicket('sla-ended');
      const active = await organizationWithTicket('sla-active');
      const asked: string[] = [];

      const events = await scanSla(harness.prisma, new Date(), {
        isOrganizationAllowed: async (organizationId) => {
          asked.push(organizationId);
          return organizationId === active.organizationId;
        },
      });

      expect(events.map((e) => e.organizationId)).toEqual([active.organizationId, active.organizationId]);
      expect(new Set(events.map((e) => e.ticketId))).toEqual(new Set([active.ticketId]));
      const untouched = await harness.prisma.ticket.findUniqueOrThrow({ where: { id: ended.ticketId } });
      expect(untouched.firstResponseBreachedAt).toBeNull();
      expect(untouched.resolutionBreachedAt).toBeNull();
      expect(untouched.firstResponseWarnedAt).toBeNull();
      const stamped = await harness.prisma.ticket.findUniqueOrThrow({ where: { id: active.ticketId } });
      expect(stamped.firstResponseBreachedAt).not.toBeNull();
      expect(stamped.resolutionBreachedAt).not.toBeNull();

      // Renewal: the same sweep, now allowed, raises what was waiting.
      const resumed = await scanSla(harness.prisma, new Date(), { isOrganizationAllowed: async () => true });
      expect(resumed.map((e) => e.ticketId)).toEqual([ended.ticketId, ended.ticketId]);
      expect(asked.length).toBeGreaterThan(0);
    });

    it('behaves exactly as before without a filter', async () => {
      const first = await organizationWithTicket('sla-one');
      const second = await organizationWithTicket('sla-two');
      const events = await scanSla(harness.prisma);
      expect(new Set(events.map((e) => e.ticketId))).toEqual(new Set([first.ticketId, second.ticketId]));
    });
  });

  describe('what the worker is told to re-check (SendEmailJob.requiresAccess)', () => {
    const jobs = async (): Promise<SendEmailJob[]> =>
      (await emailQueue.getJobs(['waiting', 'delayed', 'active', 'completed'])).map((job) => job.data);

    it('marks nothing on account-security mail: reset, verification and invitations are never held back', async () => {
      const mailer = harness.app.get(MailerService);
      await mailer.send('org', 'a@b.example', { kind: 'reset-password', firstName: 'A', url: 'https://x/y', expiresInMinutes: 60 });
      await mailer.send('org', 'a@b.example', { kind: 'password-changed', firstName: 'A' });
      const queued = await jobs();
      expect(queued).toHaveLength(2);
      for (const job of queued) expect(job.requiresAccess).toBeUndefined();
    });

    it('marks it when the caller says the email is the organization\'s business', async () => {
      const mailer = harness.app.get(MailerService);
      await mailer.send(
        'org',
        'c@d.example',
        { kind: 'reset-password', firstName: 'A', url: 'https://x/y', expiresInMinutes: 60 },
        0,
        { requiresAccess: true },
      );
      expect((await jobs())[0]!.requiresAccess).toBe(true);
    });

    it('marks the registration verification email as account security (not gated)', async () => {
      await registerOrg(http, 'verify');
      const queued = await jobs();
      expect(queued.length).toBeGreaterThan(0);
      for (const job of queued) expect(job.requiresAccess).toBeUndefined();
    });

    it('marks a satisfaction survey (class A: it is sent minutes after the resolution, by the worker)', async () => {
      const org = await registerOrg(http, 'csat');
      const auth = { Authorization: `Bearer ${org.token}` };
      await emailQueue.obliterate({ force: true });
      await request(http).patch(apiPath('/csat/settings')).set(auth).send({ isEnabled: true, delayMinutes: 5 }).expect(200);
      const contact = await request(http)
        .post(apiPath('/contacts'))
        .set(auth)
        .send({ firstName: 'Casey', lastName: 'Customer', email: 'casey@csat.example' })
        .expect(201);
      const ticket = await request(http)
        .post(apiPath('/tickets'))
        .set(auth)
        .send({ subject: 'Survey me', description: 'please', contactId: contact.body.data.id })
        .expect(201);
      await request(http)
        .post(apiPath(`/tickets/${ticket.body.data.id as string}/resolve`))
        .set(auth)
        .send({ resolutionNote: 'done' })
        .expect(200);

      const survey = (await jobs()).find((job) => job.to === 'casey@csat.example');
      expect(survey).toBeDefined();
      expect(survey!.requiresAccess).toBe(true);
      expect(survey!.organizationId).toBe(org.organizationId);
    });

    it('marks an automation\'s email action (class A)', async () => {
      const org = await registerOrg(http, 'auto');
      const auth = { Authorization: `Bearer ${org.token}` };
      const contact = await request(http)
        .post(apiPath('/contacts'))
        .set(auth)
        .send({ firstName: 'Casey', lastName: 'Customer', email: 'casey@auto.example' })
        .expect(201);
      await request(http)
        .post(apiPath('/automation-rules'))
        .set(auth)
        .send({
          name: 'Acknowledge',
          trigger: 'TICKET_CREATED',
          actions: [{ type: 'send_email', to: 'contact', subject: 'We got it', body: 'Thanks {{contact.name}}' }],
        })
        .expect(201);
      const ticket = await request(http)
        .post(apiPath('/tickets'))
        .set(auth)
        .send({ subject: 'Hello', description: 'body', contactId: contact.body.data.id })
        .expect(201);

      const sent: SendEmailJob[] = [];
      const base = harness.app.get(EngineService).deps as EngineDeps;
      const deps: EngineDeps = { ...base, emailQueue: { add: async (_name: string, data: unknown) => void sent.push(data as SendEmailJob) } as never };
      await runTrigger(deps, { organizationId: org.organizationId, ticketId: ticket.body.data.id as string, trigger: 'TICKET_CREATED' });

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ to: 'casey@auto.example', subject: 'We got it', requiresAccess: true });
    });
  });
});

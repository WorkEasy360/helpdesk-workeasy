import request from 'supertest';
import type { Server } from 'node:http';
import { apiPath, createHarness, registerOrg, resetDatabase, type Harness } from './app.harness';

/** Outbound webhooks and API keys — the two ways another system talks to this one. */
describe('Integrations (e2e)', () => {
  let harness: Harness;
  let http: Server;
  let auth: { Authorization: string };
  let agentRoleId: string;

  beforeAll(async () => {
    harness = await createHarness();
    http = harness.app.getHttpServer() as Server;
  });

  beforeEach(async () => {
    await resetDatabase(harness.prisma, harness.redis);
    const org = await registerOrg(http, 'integrations');
    auth = { Authorization: `Bearer ${org.token}` };

    const roles = await request(http).get(apiPath('/roles')).set(auth).expect(200);
    agentRoleId = (roles.body.data as { id: string; systemKey: string }[]).find(
      (role) => role.systemKey === 'AGENT',
    )!.id;
  });

  afterAll(async () => {
    await harness.close();
  });

  const createEndpoint = (overrides: Record<string, unknown> = {}) =>
    request(http)
      .post(apiPath('/webhook-endpoints'))
      .set(auth)
      .send({
        name: 'Ops receiver',
        // Internal addresses are refused outright; `.invalid` never resolves, so nothing
        // is ever actually delivered.
        url: 'https://receiver.invalid/never-answers',
        events: ['ticket.created'],
        ...overrides,
      });

  it('refuses webhook URLs that point inside the network', async () => {
    for (const url of [
      'http://127.0.0.1:9/hook',
      'http://localhost/hook',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/hook',
    ]) {
      await createEndpoint({ url }).expect(400);
    }
  });

  it('shows the signing secret once and never again', async () => {
    const created = await createEndpoint().expect(201);
    expect(created.body.data.secret).toMatch(/^whsec_/);

    const list = await request(http).get(apiPath('/webhook-endpoints')).set(auth).expect(200);
    expect(list.body.data[0].secret).toBeUndefined();

    const rotated = await request(http)
      .post(apiPath(`/webhook-endpoints/${created.body.data.id as string}/rotate-secret`))
      .set(auth)
      .expect(201);
    expect(rotated.body.data.secret).not.toBe(created.body.data.secret);
  });

  it('queues a delivery for a subscribed event and not for one that is not subscribed', async () => {
    await createEndpoint({ events: ['ticket.created'] }).expect(201);

    await request(http)
      .post(apiPath('/tickets'))
      .set(auth)
      .send({ subject: 'Webhook check', description: 'body' })
      .expect(201);

    const deliveries = await request(http).get(apiPath('/webhook-deliveries')).set(auth).expect(200);
    const events = (deliveries.body.data as { event: string }[]).map((delivery) => delivery.event);
    expect(events).toContain('ticket.created');
    expect(events).not.toContain('contact.created');
  });

  it('sends every event to an endpoint that subscribed to none', async () => {
    await createEndpoint({ name: 'Everything', events: [] }).expect(201);

    await request(http)
      .post(apiPath('/contacts'))
      .set(auth)
      .send({ firstName: 'Rhea', lastName: 'Kapoor', email: 'rhea@example.test' })
      .expect(201);

    const deliveries = await request(http).get(apiPath('/webhook-deliveries')).set(auth).expect(200);
    expect((deliveries.body.data as { event: string }[]).map((d) => d.event)).toContain(
      'contact.created',
    );
  });

  it('carries the ticket itself in a ticket event', async () => {
    await createEndpoint({ events: [] }).expect(201);
    const ticket = await request(http)
      .post(apiPath('/tickets'))
      .set(auth)
      .send({ subject: 'Payload check', description: 'body' })
      .expect(201);

    const stored = await harness.prisma.webhookDelivery.findFirst({
      where: { event: 'ticket.created' },
      select: { payload: true },
    });
    const payload = stored?.payload as { ticket?: { ticketNumber: number } };
    expect(payload.ticket?.ticketNumber).toBe(ticket.body.data.ticketNumber);
  });

  it('re-queues a delivery on replay', async () => {
    await createEndpoint({ events: [] }).expect(201);
    await request(http)
      .post(apiPath('/tickets'))
      .set(auth)
      .send({ subject: 'Replay me', description: 'body' })
      .expect(201);

    const deliveries = await request(http).get(apiPath('/webhook-deliveries')).set(auth).expect(200);
    const deliveryId = deliveries.body.data[0].id as string;

    await request(http)
      .post(apiPath(`/webhook-deliveries/${deliveryId}/replay`))
      .set(auth)
      .expect(201);

    const after = await harness.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      select: { status: true },
    });
    expect(after?.status).toBe('PENDING');
  });

  it('authenticates a machine caller with its key and honours the role on it', async () => {
    const created = await request(http)
      .post(apiPath('/api-keys'))
      .set(auth)
      .send({ name: 'CRM integration', roleId: agentRoleId })
      .expect(201);

    const key = created.body.data.key as string;
    expect(key).toMatch(/^dsk_/);

    const list = await request(http).get(apiPath('/api-keys')).set(auth).expect(200);
    expect(list.body.data[0].key).toBeUndefined();
    expect(list.body.data[0].prefix).toBe(key.slice(0, 12));

    // The key can do what an agent can do …
    const raised = await request(http)
      .post(apiPath('/tickets'))
      .set({ 'X-Api-Key': key })
      .send({ subject: 'Raised by integration', description: 'from the CRM' })
      .expect(201);
    expect(raised.body.data.createdBy.lastName).toBe('API key');

    // … and nothing an agent cannot.
    await request(http).get(apiPath('/api-keys')).set({ 'X-Api-Key': key }).expect(403);
  });

  it('refuses an unknown key and a revoked one', async () => {
    const created = await request(http)
      .post(apiPath('/api-keys'))
      .set(auth)
      .send({ name: 'Short lived', roleId: agentRoleId })
      .expect(201);
    const key = created.body.data.key as string;

    await request(http).get(apiPath('/tickets')).set({ 'X-Api-Key': key }).expect(200);
    await request(http).get(apiPath('/tickets')).set({ 'X-Api-Key': 'dsk_not-a-real-key' }).expect(401);

    await request(http)
      .delete(apiPath(`/api-keys/${created.body.data.id as string}`))
      .set(auth)
      .expect(200);

    await request(http).get(apiPath('/tickets')).set({ 'X-Api-Key': key }).expect(401);
  });

  it('keeps a key inside its own organization', async () => {
    const created = await request(http)
      .post(apiPath('/api-keys'))
      .set(auth)
      .send({ name: 'Tenant bound', roleId: agentRoleId })
      .expect(201);
    const key = created.body.data.key as string;

    const other = await registerOrg(http, 'integrations-two', 'owner@integrations-two.example');
    await request(http)
      .post(apiPath('/tickets'))
      .set({ Authorization: `Bearer ${other.token}` })
      .send({ subject: 'Theirs', description: 'body' })
      .expect(201);

    const seen = await request(http).get(apiPath('/tickets')).set({ 'X-Api-Key': key }).expect(200);
    expect((seen.body.data as { subject: string }[]).map((t) => t.subject)).not.toContain('Theirs');
  });
});

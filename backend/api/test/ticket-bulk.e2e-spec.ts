import request from 'supertest';
import type { Server } from 'node:http';
import { apiPath, createHarness, registerOrg, resetDatabase, type Harness } from './app.harness';

interface BulkResult {
  id: string;
  ok: boolean;
  error?: { code: string; message: string };
}

/** Bulk ticket actions and the list filters the agent workspace builds its views from. */
describe('Ticket bulk actions and list filters (e2e)', () => {
  let harness: Harness;
  let http: Server;
  let auth: { Authorization: string };
  let statuses: { id: string; name: string; isResolved: boolean; isClosed: boolean }[];
  let priorities: { id: string; name: string }[];

  const statusId = (name: string) => statuses.find((status) => status.name === name)!.id;
  const priorityId = (name: string) => priorities.find((priority) => priority.name === name)!.id;

  const createTicket = async (subject: string, headers = auth): Promise<string> => {
    const response = await request(http)
      .post(apiPath('/tickets'))
      .set(headers)
      .send({ subject, description: `${subject} — details.` })
      .expect(201);
    return response.body.data.id as string;
  };

  const bulk = (body: Record<string, unknown>, headers = auth) =>
    request(http).post(apiPath('/tickets/bulk')).set(headers).send(body);

  const listIds = async (query: Record<string, string>): Promise<string[]> => {
    const response = await request(http).get(apiPath('/tickets')).query(query).set(auth).expect(200);
    return (response.body.data as { id: string }[]).map((ticket) => ticket.id).sort();
  };

  beforeAll(async () => {
    harness = await createHarness();
    http = harness.app.getHttpServer() as Server;
  });

  beforeEach(async () => {
    await resetDatabase(harness.prisma);
    const org = await registerOrg(http, 'bulk');
    auth = { Authorization: `Bearer ${org.token}` };

    statuses = (await request(http).get(apiPath('/ticket-statuses')).set(auth).expect(200)).body.data;
    priorities = (await request(http).get(apiPath('/ticket-priorities')).set(auth).expect(200)).body
      .data;
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('POST /tickets/bulk', () => {
    it('changes priority on every ticket and records each change in its history', async () => {
      const ids = [await createTicket('First'), await createTicket('Second')];

      const response = await bulk({
        ticketIds: ids,
        action: 'priority',
        payload: { priorityId: priorityId('High') },
      }).expect(200);

      expect(response.body.data).toMatchObject({ action: 'priority', succeeded: 2, failed: 0 });
      expect(response.body.data.results).toEqual(ids.map((id) => ({ id, ok: true })));

      for (const id of ids) {
        const ticket = await request(http).get(apiPath(`/tickets/${id}`)).set(auth).expect(200);
        expect(ticket.body.data.priority.name).toBe('High');
        const history = await request(http).get(apiPath(`/tickets/${id}/history`)).set(auth).expect(200);
        expect((history.body.data as { action: string }[]).map((entry) => entry.action)).toContain(
          'ticket.priority_changed',
        );
      }
    });

    it('fails only the tickets a resolving status would leave without a resolution note', async () => {
      const withoutNote = await createTicket('No note yet');
      const withNote = await createTicket('Already explained');
      await harness.prisma.ticket.update({
        where: { id: withNote },
        data: { resolutionNote: 'Explained on the call' },
      });

      const response = await bulk({
        ticketIds: [withoutNote, withNote],
        action: 'status',
        payload: { statusId: statusId('Resolved') },
      }).expect(200);

      expect(response.body.data).toMatchObject({ succeeded: 1, failed: 1 });
      const results = response.body.data.results as BulkResult[];
      expect(results.find((result) => result.id === withNote)).toEqual({ id: withNote, ok: true });
      expect(results.find((result) => result.id === withoutNote)).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: expect.stringMatching(/resolution note/i) },
      });

      // With a note supplied, the same move succeeds for the one that failed.
      const retry = await bulk({
        ticketIds: [withoutNote],
        action: 'status',
        payload: { statusId: statusId('Resolved'), resolutionNote: 'Fixed in 2.4.1' },
      }).expect(200);
      expect(retry.body.data.succeeded).toBe(1);
      const ticket = await harness.prisma.ticket.findUniqueOrThrow({ where: { id: withoutNote } });
      expect(ticket.resolutionNote).toBe('Fixed in 2.4.1');
      expect(ticket.resolvedAt).not.toBeNull();
    });

    it('resolves, closes and reopens in bulk', async () => {
      const ids = [await createTicket('One'), await createTicket('Two')];

      await bulk({ ticketIds: ids, action: 'resolve', payload: { resolutionNote: 'Done' } }).expect(200);
      expect(await listIds({ statusCategory: 'resolved' })).toEqual([...ids].sort());

      const closed = await bulk({ ticketIds: ids, action: 'close' }).expect(200);
      expect(closed.body.data.succeeded).toBe(2);
      expect(await listIds({ statusCategory: 'closed' })).toEqual([...ids].sort());

      const reopened = await bulk({ ticketIds: ids, action: 'reopen' }).expect(200);
      expect(reopened.body.data.succeeded).toBe(2);
      expect(await listIds({ statusCategory: 'open' })).toEqual([...ids].sort());
    });

    it('assigns and unassigns, reporting tickets outside the tenant as not found', async () => {
      const mine = await createTicket('Mine');
      const me = await request(http).get(apiPath('/auth/me')).set(auth).expect(200);

      const other = await registerOrg(http, 'bulk-other');
      const foreign = await createTicket('Theirs', { Authorization: `Bearer ${other.token}` });

      const assigned = await bulk({
        ticketIds: [mine, foreign, 'does-not-exist'],
        action: 'assign',
        payload: { assignedAgentId: me.body.data.id },
      }).expect(200);

      expect(assigned.body.data).toMatchObject({ succeeded: 1, failed: 2 });
      const results = assigned.body.data.results as BulkResult[];
      expect(results[0]).toEqual({ id: mine, ok: true });
      expect(results[1]).toMatchObject({ id: foreign, ok: false, error: { code: 'TICKET_NOT_FOUND' } });
      expect(results[2]).toMatchObject({ ok: false, error: { code: 'TICKET_NOT_FOUND' } });

      // The other organization's ticket is untouched.
      const theirs = await harness.prisma.ticket.findUniqueOrThrow({ where: { id: foreign } });
      expect(theirs.assignedAgentId).toBeNull();

      await bulk({ ticketIds: [mine], action: 'unassign' }).expect(200);
      expect(await listIds({ unassigned: 'true' })).toEqual([mine]);
    });

    it('adds and removes tags without disturbing the others', async () => {
      const ids = [await createTicket('Tagged'), await createTicket('Also tagged')];
      const tag = async (name: string) =>
        (await request(http).post(apiPath('/tags')).set(auth).send({ name }).expect(201)).body.data
          .id as string;
      const billing = await tag('billing');
      const vip = await tag('vip');

      await bulk({ ticketIds: ids, action: 'addTags', payload: { tagIds: [billing, vip] } }).expect(200);
      await bulk({ ticketIds: ids, action: 'removeTags', payload: { tagIds: [billing] } }).expect(200);

      for (const id of ids) {
        const ticket = await request(http).get(apiPath(`/tickets/${id}`)).set(auth).expect(200);
        expect((ticket.body.data.tags as { tag: { name: string } }[]).map((t) => t.tag.name)).toEqual([
          'vip',
        ]);
      }
    });

    it('validates the request as a whole', async () => {
      const tooMany = Array.from({ length: 101 }, (_, index) => `ticket-${index}`);
      await bulk({ ticketIds: tooMany, action: 'close' }).expect(400);
      await bulk({ ticketIds: [], action: 'close' }).expect(400);
      await bulk({ ticketIds: ['x'], action: 'explode' }).expect(400);
      await bulk({ ticketIds: ['x'], action: 'priority', payload: {} }).expect(400);
    });

    it('requires ticket.update, and ticket.assign for assignment actions', async () => {
      const ticket = await createTicket('Permissions');
      const makeUser = async (email: string, permissionKeys: string[]) => {
        const role = await request(http)
          .post(apiPath('/roles'))
          .set(auth)
          .send({ name: `Role ${email}`, permissionKeys })
          .expect(201);
        await request(http)
          .post(apiPath('/users'))
          .set(auth)
          .send({
            firstName: 'Limited',
            lastName: 'Agent',
            email,
            password: 'Str0ngPassword1',
            roleIds: [role.body.data.id],
          })
          .expect(201);
        const login = await request(http)
          .post(apiPath('/auth/login'))
          .send({ email, password: 'Str0ngPassword1', organizationSlug: 'bulk' })
          .expect(200);
        return { Authorization: `Bearer ${login.body.data.accessToken as string}` };
      };

      const reader = await makeUser('reader@bulk.example', ['ticket.read', 'ticket.read.all']);
      await bulk({ ticketIds: [ticket], action: 'close' }, reader).expect(403);

      const updater = await makeUser('updater@bulk.example', [
        'ticket.read',
        'ticket.read.all',
        'ticket.update',
      ]);
      const denied = await bulk({ ticketIds: [ticket], action: 'unassign' }, updater).expect(403);
      expect(denied.body.error.code).toBe('PERMISSION_DENIED');
      const allowed = await bulk(
        { ticketIds: [ticket], action: 'priority', payload: { priorityId: priorityId('Low') } },
        updater,
      ).expect(200);
      expect(allowed.body.data.succeeded).toBe(1);
    });
  });

  describe('GET /tickets filters', () => {
    it('filters by creation window, with a bare date covering the whole day', async () => {
      const early = await createTicket('Early');
      const middle = await createTicket('Middle');
      const late = await createTicket('Late');
      const setCreated = (id: string, iso: string) =>
        harness.prisma.ticket.update({ where: { id }, data: { createdAt: new Date(iso) } });
      await setCreated(early, '2026-01-05T10:00:00.000Z');
      await setCreated(middle, '2026-01-20T23:30:00.000Z');
      await setCreated(late, '2026-02-10T08:00:00.000Z');

      expect(await listIds({ createdFrom: '2026-01-01', createdTo: '2026-01-20' })).toEqual(
        [early, middle].sort(),
      );
      expect(await listIds({ createdFrom: '2026-01-10T00:00:00Z' })).toEqual([middle, late].sort());
      expect(await listIds({ createdTo: '2026-01-20T12:00:00Z' })).toEqual([early]);

      await request(http).get(apiPath('/tickets')).query({ createdFrom: 'last tuesday' }).set(auth).expect(400);
    });

    it('lists only open tickets past their due time as overdue', async () => {
      const overdue = await createTicket('Overdue');
      const notYet = await createTicket('Due tomorrow');
      const resolvedLate = await createTicket('Resolved but late');
      const past = new Date(Date.now() - 60 * 60 * 1000);
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await harness.prisma.ticket.update({ where: { id: overdue }, data: { dueAt: past } });
      await harness.prisma.ticket.update({ where: { id: notYet }, data: { dueAt: future } });
      await harness.prisma.ticket.update({
        where: { id: resolvedLate },
        data: { dueAt: past, statusId: statusId('Resolved'), resolutionNote: 'Done' },
      });

      expect(await listIds({ overdue: 'true' })).toEqual([overdue]);
      // Existing parameters still combine with the new ones.
      expect(await listIds({ overdue: 'true', open: 'true', q: 'Overdue' })).toEqual([overdue]);
      expect((await listIds({ overdue: 'false' })).length).toBe(3);
    });

    it('buckets by status category using the status flags', async () => {
      const open = await createTicket('Open one');
      const resolved = await createTicket('Resolved one');
      const closed = await createTicket('Closed one');
      await harness.prisma.ticket.update({ where: { id: resolved }, data: { statusId: statusId('Resolved') } });
      await harness.prisma.ticket.update({ where: { id: closed }, data: { statusId: statusId('Closed') } });

      expect(await listIds({ statusCategory: 'open' })).toEqual([open]);
      expect(await listIds({ statusCategory: 'resolved' })).toEqual([resolved]);
      expect(await listIds({ statusCategory: 'closed' })).toEqual([closed]);
      await request(http).get(apiPath('/tickets')).query({ statusCategory: 'pending' }).set(auth).expect(400);
    });
  });
});

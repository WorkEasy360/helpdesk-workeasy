import {
  assignTicketSchema,
  bulkUpdateTicketsSchema,
  createTicketSchema,
  listTicketsQuerySchema,
  updateTicketSchema,
} from '@digisoft/shared';

/**
 * PATCH payloads must only carry the fields the caller actually sent. An earlier
 * version of `optionalField` applied its transform outside `.optional()`, so parsing
 * `{ subject }` produced `{ subject, contactId: null, departmentId: null, ... }` and a
 * single-field edit silently detached the ticket from its contact and department.
 */
describe('ticket payload schemas', () => {
  describe('updateTicketSchema', () => {
    it('leaves untouched fields out of the parsed payload', () => {
      expect(updateTicketSchema.parse({})).toEqual({});
      expect(updateTicketSchema.parse({ subject: 'New subject' })).toEqual({
        subject: 'New subject',
      });
    });

    it('still lets a caller clear a field on purpose', () => {
      expect(updateTicketSchema.parse({ contactId: null })).toEqual({ contactId: null });
      expect(updateTicketSchema.parse({ contactId: '' })).toEqual({ contactId: null });
    });
  });

  describe('assignTicketSchema', () => {
    it('does not invent a department when only an agent is given', () => {
      expect(assignTicketSchema.parse({ assignedAgentId: 'agent-1' })).toEqual({
        assignedAgentId: 'agent-1',
      });
    });

    it('accepts an explicit unassignment', () => {
      expect(assignTicketSchema.parse({ assignedAgentId: null })).toEqual({
        assignedAgentId: null,
      });
    });

    it('rejects a payload that changes nothing', () => {
      expect(assignTicketSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('createTicketSchema', () => {
    it('applies defaults and normalises blank optional fields to null', () => {
      expect(
        createTicketSchema.parse({ subject: 'Subject', description: 'Body', contactId: '' }),
      ).toEqual({
        subject: 'Subject',
        description: 'Body',
        contactId: null,
        source: 'AGENT',
        tagIds: [],
      });
    });

    it('requires a subject and a description', () => {
      expect(createTicketSchema.safeParse({ subject: '', description: 'x' }).success).toBe(false);
      expect(createTicketSchema.safeParse({ subject: 'x' }).success).toBe(false);
    });
  });

  describe('bulkUpdateTicketsSchema', () => {
    it('checks the payload against the chosen action', () => {
      expect(
        bulkUpdateTicketsSchema.safeParse({ ticketIds: ['a'], action: 'priority', payload: { priorityId: 'p' } })
          .success,
      ).toBe(true);
      expect(bulkUpdateTicketsSchema.safeParse({ ticketIds: ['a'], action: 'priority' }).success).toBe(false);
      expect(bulkUpdateTicketsSchema.safeParse({ ticketIds: ['a'], action: 'close' }).success).toBe(true);
      expect(
        bulkUpdateTicketsSchema.safeParse({ ticketIds: ['a'], action: 'assign', payload: {} }).success,
      ).toBe(false);
    });

    it('caps a request at 100 tickets', () => {
      const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
      expect(bulkUpdateTicketsSchema.safeParse({ ticketIds: ids(100), action: 'close' }).success).toBe(true);
      expect(bulkUpdateTicketsSchema.safeParse({ ticketIds: ids(101), action: 'close' }).success).toBe(false);
      expect(bulkUpdateTicketsSchema.safeParse({ ticketIds: [], action: 'close' }).success).toBe(false);
    });
  });

  describe('listTicketsQuerySchema', () => {
    it('accepts dates and ISO timestamps for the creation window', () => {
      expect(listTicketsQuerySchema.parse({ createdFrom: '2026-01-01' }).createdFrom).toBe('2026-01-01');
      expect(listTicketsQuerySchema.safeParse({ createdTo: '2026-01-01T10:00:00Z' }).success).toBe(true);
      expect(listTicketsQuerySchema.safeParse({ createdTo: '2026-01-01T10:00:00+05:30' }).success).toBe(true);
      expect(listTicketsQuerySchema.safeParse({ createdFrom: 'yesterday' }).success).toBe(false);
    });

    it('parses overdue and statusCategory', () => {
      expect(listTicketsQuerySchema.parse({ overdue: 'false', statusCategory: 'closed' })).toMatchObject({
        overdue: false,
        statusCategory: 'closed',
      });
      expect(listTicketsQuerySchema.safeParse({ statusCategory: 'pending' }).success).toBe(false);
    });
  });
});

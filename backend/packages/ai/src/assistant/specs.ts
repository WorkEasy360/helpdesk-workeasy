import { PERMISSIONS } from '@digisoft/shared';
import type { AssistantActionSpec, AssistantPageSpec, AssistantToolSpec } from './types';

/**
 * What the Helpdesk assistant can look up, propose and link to.
 *
 * This is the whole product-specific surface: the loop, the prompt scaffolding and the
 * safety rules in the sibling files are the same in every WorkEasy360 product. See
 * backend/docs/AI-ASSISTANT.md.
 */

export const ASSISTANT_TOOLS: AssistantToolSpec[] = [
  {
    name: 'helpdesk_overview',
    description:
      'Always call this first. The organization, its timezone and today, plus the ticket counts this member can see.',
    args: '{}',
    permission: null,
  },
  {
    name: 'search_tickets',
    description:
      'Find tickets. Returns number, subject, status, priority, assignee, requester, SLA state and when each was updated.',
    args:
      '{"query"?: string, "view"?: "open"|"mine"|"unassigned"|"overdue"|"all", ' +
      '"statusCategory"?: "open"|"pending"|"resolved"|"closed", "limit"?: 1-20}',
    permission: [PERMISSIONS.TICKET_READ],
  },
  {
    name: 'get_ticket',
    description:
      'One ticket in full: its state, SLA targets, requester, assignee, tags and the last few messages. Use the number from search_tickets.',
    args: '{"ticketNumber": number}',
    permission: [PERMISSIONS.TICKET_READ],
  },
  {
    name: 'list_ticket_options',
    description:
      'The statuses, priorities, categories and tags this organization has configured, with their ids. Call this before proposing any change that names one.',
    args: '{}',
    permission: [PERMISSIONS.TICKET_READ],
  },
  {
    name: 'list_agents',
    description:
      'Agents and departments a ticket can be assigned to, with their ids and how many open tickets each agent has.',
    args: '{"query"?: string, "limit"?: 1-20}',
    permission: [PERMISSIONS.USER_READ],
  },
  {
    name: 'search_contacts',
    description:
      'Find the people who raise requests, with their account and how many open tickets they have.',
    args: '{"query"?: string, "limit"?: 1-20}',
    permission: [PERMISSIONS.CONTACT_READ],
  },
  {
    name: 'search_articles',
    description:
      'Search the knowledge base. Returns title, a short extract and whether the article is published.',
    args: '{"query": string, "limit"?: 1-10}',
    permission: [PERMISSIONS.KB_READ],
  },
  {
    name: 'ticket_metrics',
    description:
      'Volume, SLA compliance and satisfaction over a range. Use for "how are we doing" questions rather than counting tickets by hand.',
    args: '{"range"?: "today"|"7d"|"30d"|"90d"}',
    permission: [PERMISSIONS.REPORT_READ],
  },
];

/**
 * Every action maps onto an endpoint the product's own screens already use. The
 * assistant has no write path of its own.
 *
 * Deliberately absent, and the prompt says so: replying to a customer, merging and
 * deleting. A public reply is a message leaving the business in the organization's
 * name, and a merge or delete cannot be undone — for those the assistant explains the
 * steps and links to the page.
 */
export const ASSISTANT_ACTIONS: AssistantActionSpec[] = [
  {
    kind: 'assign_ticket',
    description: 'Assign a ticket to an agent, a department, or both.',
    args: '{"ticketNumber": number, "agentId"?: string, "departmentId"?: string}',
    permission: [PERMISSIONS.TICKET_ASSIGN],
  },
  {
    kind: 'set_ticket_status',
    description: 'Move a ticket to one of the organization’s statuses.',
    args: '{"ticketNumber": number, "statusId": string, "resolutionNote"?: string}',
    permission: [PERMISSIONS.TICKET_UPDATE],
  },
  {
    kind: 'set_ticket_priority',
    description: 'Change a ticket’s priority.',
    args: '{"ticketNumber": number, "priorityId": string}',
    permission: [PERMISSIONS.TICKET_UPDATE],
  },
  {
    kind: 'resolve_ticket',
    description: 'Resolve a ticket. A resolution note is required.',
    args: '{"ticketNumber": number, "resolutionNote": string}',
    permission: [PERMISSIONS.TICKET_UPDATE],
  },
  {
    kind: 'reopen_ticket',
    description: 'Reopen a resolved or closed ticket.',
    args: '{"ticketNumber": number}',
    permission: [PERMISSIONS.TICKET_UPDATE],
  },
  {
    kind: 'add_internal_note',
    description:
      'Add an internal comment to a ticket. Only agents see it; the customer never does.',
    args: '{"ticketNumber": number, "body": string}',
    permission: [PERMISSIONS.TICKET_COMMENT],
  },
];

/** Keep in step with `frontend/lib/modules.tsx` — the same modules, the same paths. */
export const ASSISTANT_PAGES: AssistantPageSpec[] = [
  { key: 'dashboard', label: 'Dashboard', path: '/dashboard', permission: null },
  { key: 'tickets', label: 'Tickets', path: '/tickets', permission: [PERMISSIONS.TICKET_READ] },
  { key: 'tickets_unassigned', label: 'Unassigned tickets', path: '/tickets?view=unassigned', permission: [PERMISSIONS.TICKET_READ] },
  { key: 'tickets_overdue', label: 'Overdue tickets', path: '/tickets?view=all&overdue=true', permission: [PERMISSIONS.TICKET_READ] },
  { key: 'chat', label: 'Live chat', path: '/chat', permission: [PERMISSIONS.CHAT_HANDLE] },
  { key: 'activities', label: 'Activities', path: '/activities', permission: [PERMISSIONS.ACTIVITY_READ] },
  { key: 'customers', label: 'Customers', path: '/customers', permission: [PERMISSIONS.CONTACT_READ] },
  { key: 'accounts', label: 'Accounts', path: '/accounts', permission: [PERMISSIONS.ACCOUNT_READ] },
  { key: 'knowledge_base', label: 'Knowledge base', path: '/knowledge-base', permission: [PERMISSIONS.KB_READ] },
  { key: 'community', label: 'Community', path: '/community', permission: [PERMISSIONS.COMMUNITY_MODERATE] },
  { key: 'automation', label: 'Automation', path: '/automation/rules', permission: [PERMISSIONS.OPERATIONS_READ] },
  { key: 'sla_policies', label: 'SLA policies', path: '/automation/sla', permission: [PERMISSIONS.OPERATIONS_READ] },
  { key: 'reports', label: 'Reports', path: '/reports', permission: [PERMISSIONS.REPORT_READ] },
  { key: 'settings_agents', label: 'Agents', path: '/settings/users', permission: [PERMISSIONS.USER_READ] },
  { key: 'settings_channels', label: 'Channels', path: '/settings/channels', permission: [PERMISSIONS.CHANNEL_READ] },
];

/** Records the assistant may link to directly, as `<record>:<id>`. */
export const ASSISTANT_RECORDS = {
  ticket: { path: (id: string) => `/tickets/${id}`, permission: [PERMISSIONS.TICKET_READ] },
  contact: { path: (id: string) => `/customers/${id}`, permission: [PERMISSIONS.CONTACT_READ] },
  account: { path: (id: string) => `/accounts/${id}`, permission: [PERMISSIONS.ACCOUNT_READ] },
  article: { path: (id: string) => `/knowledge-base/${id}`, permission: [PERMISSIONS.KB_READ] },
} as const;

export type AssistantRecordKind = keyof typeof ASSISTANT_RECORDS;

/**
 * Narrows the whole surface to what one member's role may use. The model is only ever
 * told about tools, actions and pages it can actually reach, so it cannot offer the
 * member something the API would then refuse.
 *
 * This is a courtesy, not the control: every tool and every endpoint checks the
 * permission again when it runs.
 */
export function assistantCapabilities(can: (permission: string) => boolean) {
  const allowed = (permission: string[] | null) =>
    permission === null || permission.every((entry) => can(entry));

  return {
    tools: ASSISTANT_TOOLS.filter((tool) => allowed(tool.permission)),
    actions: ASSISTANT_ACTIONS.filter((action) => allowed(action.permission)),
    pages: ASSISTANT_PAGES.filter((page) => allowed(page.permission)),
  };
}

/** What the chat offers before the first question. */
export function assistantSuggestions(can: (permission: string) => boolean): string[] {
  const suggestions: string[] = [];
  if (can(PERMISSIONS.TICKET_READ)) {
    suggestions.push('What needs my attention today?');
    suggestions.push('Which tickets are about to breach their SLA?');
  }
  if (can(PERMISSIONS.REPORT_READ)) suggestions.push('How did we do over the last 7 days?');
  if (can(PERMISSIONS.TICKET_READ) && can(PERMISSIONS.TICKET_ASSIGN)) {
    suggestions.push('Who should take the unassigned tickets?');
  }
  if (can(PERMISSIONS.KB_READ)) suggestions.push('Is there an article about password resets?');
  return suggestions.slice(0, 4);
}

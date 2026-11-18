import {
  BarChart3,
  BookOpen,
  Building2,
  ClipboardList,
  LayoutDashboard,
  MessageCircle,
  MessagesSquare,
  Settings,
  Ticket,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { PERMISSIONS } from '@digisoft/shared';

/**
 * Every module in the product, declared once. The sidebar, the top-bar search and the
 * module pages all read this list, so a module's name, icon or path cannot drift
 * between the places it appears. See docs/DESIGN-SYSTEM.md.
 *
 * `permission` is presentation only — it decides whether a row is shown. The API
 * enforces the same permission on every request; this list is never the authority.
 */

export type ModuleGroup = 'work' | 'customers' | 'self-service' | 'operations' | 'admin';

export interface AppModule {
  /** Stable key, also the search match target. */
  key: string;
  label: string;
  path: string;
  group: ModuleGroup;
  icon: LucideIcon;
  permission?: string;
  /** One line explaining what the module is for. Used by search and empty states. */
  summary: string;
  /**
   * The module's primary action. `path` is where the action is taken — for the
   * modules whose "new" action is a dialog, that is the module page itself.
   */
  primaryAction?: { label: string; path: string };
  /** What the module can do — shown in search results and on overview screens. */
  features: string[];
  /** Pinned to the bottom of the sidebar, below a rule. */
  pinned?: boolean;
}

/** Group labels and their order in the sidebar. */
export const MODULE_GROUPS: { id: ModuleGroup; label: string }[] = [
  { id: 'work', label: 'Work' },
  { id: 'customers', label: 'Customers' },
  { id: 'self-service', label: 'Self-service' },
  { id: 'operations', label: 'Operations' },
  { id: 'admin', label: 'Admin' },
];

export const MODULES: AppModule[] = [
  {
    key: 'dashboard',
    label: 'Dashboard',
    path: '/dashboard',
    group: 'work',
    icon: LayoutDashboard,
    summary: 'How the team and the SLA are doing, at a glance.',
    features: ['Ticket volume', 'SLA compliance', 'CSAT', 'Top agents'],
  },
  {
    key: 'tickets',
    label: 'Tickets',
    path: '/tickets',
    group: 'work',
    icon: Ticket,
    permission: PERMISSIONS.TICKET_READ,
    summary: 'Every request, from first reply to resolution.',
    primaryAction: { label: 'New ticket', path: '/tickets' },
    features: ['Queues and views', 'Conversations and internal notes', 'Attachments', 'Merge and history'],
  },
  {
    key: 'chat',
    label: 'Live chat',
    path: '/chat',
    group: 'work',
    icon: MessageCircle,
    permission: PERMISSIONS.CHAT_HANDLE,
    summary: 'Answer visitors in real time and turn a chat into a ticket.',
    features: ['Waiting queue', 'Live conversation', 'Convert to ticket'],
  },
  {
    key: 'activities',
    label: 'Activities',
    path: '/activities',
    group: 'work',
    icon: ClipboardList,
    permission: PERMISSIONS.ACTIVITY_READ,
    summary: 'Calls, tasks and events logged against a ticket or a contact.',
    primaryAction: { label: 'Log activity', path: '/activities' },
    features: ['Calls and tasks', 'Due dates', 'Linked to tickets and contacts'],
  },

  {
    key: 'customers',
    label: 'Customers',
    path: '/customers',
    group: 'customers',
    icon: Users,
    permission: PERMISSIONS.CONTACT_READ,
    summary: 'The people who raise requests, and everything they have asked.',
    primaryAction: { label: 'New contact', path: '/customers' },
    features: ['Contact details', 'Ticket history', 'Linked account'],
  },
  {
    key: 'accounts',
    label: 'Accounts',
    path: '/accounts',
    group: 'customers',
    icon: Building2,
    permission: PERMISSIONS.ACCOUNT_READ,
    summary: 'The companies behind your contacts.',
    primaryAction: { label: 'New account', path: '/accounts' },
    features: ['Company details', 'Contacts', 'Open tickets'],
  },

  {
    key: 'knowledge-base',
    label: 'Knowledge base',
    path: '/knowledge-base',
    group: 'self-service',
    icon: BookOpen,
    permission: PERMISSIONS.KB_READ,
    summary: 'Articles that answer a question before it becomes a ticket.',
    primaryAction: { label: 'New article', path: '/knowledge-base/new' },
    features: ['Categories', 'Drafts and publishing', 'Grounds the assistant’s replies'],
  },
  {
    key: 'community',
    label: 'Community',
    path: '/community',
    group: 'self-service',
    icon: MessagesSquare,
    permission: PERMISSIONS.COMMUNITY_MODERATE,
    summary: 'Moderate the questions and answers customers post to each other.',
    features: ['Approve and reject', 'Pin and lock', 'Categories'],
  },

  {
    key: 'automation',
    label: 'Automation',
    path: '/automation/rules',
    group: 'operations',
    icon: Workflow,
    permission: PERMISSIONS.OPERATIONS_READ,
    summary: 'Rules that route, escalate, time and govern tickets without an agent lifting a finger.',
    features: ['Workflow rules', 'Escalations', 'Assignment', 'SLA policies', 'Blueprints'],
  },
  {
    key: 'reports',
    label: 'Reports',
    path: '/reports',
    group: 'operations',
    icon: BarChart3,
    permission: PERMISSIONS.REPORT_READ,
    summary: 'Tickets, agents, SLA and satisfaction — on screen or exported.',
    features: ['Ticket and agent reports', 'SLA and CSAT', 'Saved reports', 'CSV exports'],
  },

  {
    key: 'settings',
    label: 'Settings',
    path: '/settings/organization',
    group: 'admin',
    icon: Settings,
    permission: PERMISSIONS.ORGANIZATION_READ,
    summary: 'This organization, the people in it, and how every channel is wired up.',
    features: ['Agents, roles and teams', 'Ticket fields', 'Help center and web forms', 'Channels, webhooks and API keys'],
    pinned: true,
  },
];

/** The pages search can jump to that are not modules in their own right. */
export interface AppDestination {
  label: string;
  path: string;
  /** The module this page belongs under, for the "Tickets › …" prefix in results. */
  moduleKey: string;
  permission?: string;
  keywords?: string[];
}

export const DESTINATIONS: AppDestination[] = [
  { label: 'Workflow rules', path: '/automation/rules', moduleKey: 'automation', permission: PERMISSIONS.OPERATIONS_READ },
  { label: 'Escalations', path: '/automation/escalations', moduleKey: 'automation', permission: PERMISSIONS.OPERATIONS_READ },
  { label: 'Assignment', path: '/automation/assignment', moduleKey: 'automation', permission: PERMISSIONS.OPERATIONS_READ },
  { label: 'SLA policies', path: '/automation/sla', moduleKey: 'automation', permission: PERMISSIONS.OPERATIONS_READ, keywords: ['service level'] },
  { label: 'Blueprints', path: '/automation/blueprints', moduleKey: 'automation', permission: PERMISSIONS.OPERATIONS_READ },

  { label: 'Your profile', path: '/settings/profile', moduleKey: 'settings', keywords: ['account', 'password'] },
  { label: 'Organization', path: '/settings/organization', moduleKey: 'settings', permission: PERMISSIONS.ORGANIZATION_READ },
  { label: 'Agents', path: '/settings/users', moduleKey: 'settings', permission: PERMISSIONS.USER_READ, keywords: ['users', 'staff'] },
  { label: 'Roles', path: '/settings/roles', moduleKey: 'settings', permission: PERMISSIONS.ROLE_READ, keywords: ['permissions'] },
  { label: 'Departments', path: '/settings/departments', moduleKey: 'settings', permission: PERMISSIONS.DEPARTMENT_READ },
  { label: 'Teams', path: '/settings/teams', moduleKey: 'settings', permission: PERMISSIONS.TEAM_READ },
  { label: 'Ticket fields', path: '/settings/ticket-fields', moduleKey: 'settings', permission: PERMISSIONS.TICKET_READ, keywords: ['statuses', 'priorities', 'tags'] },
  { label: 'Help center', path: '/settings/help-center', moduleKey: 'settings', permission: PERMISSIONS.PORTAL_READ, keywords: ['portal', 'branding'] },
  { label: 'Web forms', path: '/settings/web-forms', moduleKey: 'settings', permission: PERMISSIONS.PORTAL_READ },
  { label: 'Channels', path: '/settings/channels', moduleKey: 'settings', permission: PERMISSIONS.CHANNEL_READ, keywords: ['email', 'whatsapp', 'telegram', 'instagram', 'messenger', 'telephony'] },
  { label: 'Webhooks', path: '/settings/webhooks', moduleKey: 'settings', permission: PERMISSIONS.WEBHOOK_READ },
  { label: 'API keys', path: '/settings/api-keys', moduleKey: 'settings', permission: PERMISSIONS.APIKEY_MANAGE },
  { label: 'Assistant', path: '/settings/ai', moduleKey: 'settings', permission: PERMISSIONS.AI_USE, keywords: ['ai'] },
  { label: 'Satisfaction surveys', path: '/settings/csat', moduleKey: 'settings', permission: PERMISSIONS.REPORT_MANAGE, keywords: ['csat'] },
];

/** The module a path belongs to, longest path first so `/automation/sla` beats `/`. */
export function moduleForPath(pathname: string): AppModule | undefined {
  return [...MODULES]
    .sort((a, b) => b.path.length - a.path.length)
    .find((module) => {
      const base = module.path.split('?')[0] ?? module.path;
      // `/settings/organization` is the Settings landing page, but any `/settings/*`
      // page belongs to Settings too.
      const root = `/${base.split('/')[1] ?? ''}`;
      return pathname === base || pathname.startsWith(`${base}/`) || pathname.startsWith(`${root}/`) || pathname === root;
    });
}

export interface SearchHit {
  label: string;
  path: string;
  /** "Tickets", or "Settings › Roles". */
  context: string;
  icon: LucideIcon;
  summary?: string;
}

/**
 * Everything the role can open, filtered by a query. Modules rank above the pages
 * inside them, and a prefix match ranks above a match in the middle of a word.
 */
export function searchDestinations(
  query: string,
  can: (permission: string) => boolean,
  limit = 8,
): SearchHit[] {
  const q = query.trim().toLowerCase();
  const allowed = (permission?: string) => !permission || can(permission);

  const moduleHits: (SearchHit & { score: number })[] = MODULES.filter((m) =>
    allowed(m.permission),
  ).flatMap((module) => {
    const score = rank(q, [module.label, module.key, ...module.features]);
    if (score === null) return [];
    return [
      {
        label: module.label,
        path: module.path,
        context: 'Module',
        icon: module.icon,
        summary: module.summary,
        score: score - 10, // modules first
      },
    ];
  });

  const byKey = new Map(MODULES.map((module) => [module.key, module]));
  const pageHits: (SearchHit & { score: number })[] = DESTINATIONS.filter((d) =>
    allowed(d.permission),
  ).flatMap((destination) => {
    const parent = byKey.get(destination.moduleKey);
    if (parent && !allowed(parent.permission)) return [];
    const score = rank(q, [destination.label, ...(destination.keywords ?? [])]);
    if (score === null) return [];
    return [
      {
        label: destination.label,
        path: destination.path,
        context: parent ? parent.label : 'Page',
        icon: parent?.icon ?? Settings,
        score,
      },
    ];
  });

  return [...moduleHits, ...pageHits]
    .sort((a, b) => a.score - b.score || a.label.localeCompare(b.label))
    .slice(0, limit)
    .map((hit): SearchHit => ({
      label: hit.label,
      path: hit.path,
      context: hit.context,
      icon: hit.icon,
      summary: hit.summary,
    }));
}

/** Lower is better; `null` means no match. An empty query matches everything. */
function rank(query: string, haystack: string[]): number | null {
  if (query === '') return 0;
  let best: number | null = null;
  for (const candidate of haystack) {
    const index = candidate.toLowerCase().indexOf(query);
    if (index === -1) continue;
    const score = index === 0 ? 0 : 1 + index;
    if (best === null || score < best) best = score;
  }
  return best;
}

import type { ContactStatus } from '@digisoft/shared';

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  domain: string | null;
  timezone: string;
  locale: string;
  currency: string;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessHours {
  id: string;
  name: string;
  timezone: string;
  isDefault: boolean;
  weeklySchedule: { day: number; start: string; end: string }[];
  holidays: { id: string; name: string; date: string }[];
}

export interface RoleRef {
  id: string;
  name: string;
  systemKey: string | null;
}

export interface DepartmentRef {
  id: string;
  name: string;
}

export interface UserSummary {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  avatarUrl: string | null;
  type: 'AGENT' | 'CUSTOMER';
  isActive: boolean;
  emailVerifiedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  roles: { role: RoleRef }[];
  departments: { department: DepartmentRef }[];
}

export interface Role extends RoleRef {
  description: string | null;
  isSystem: boolean;
  permissions: { permission: { key: string } }[];
  _count: { users: number };
}

export interface Permission {
  key: string;
  resource: string;
  action: string;
  description: string | null;
}

export interface Department {
  id: string;
  name: string;
  description: string | null;
  email: string | null;
  isDefault: boolean;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
  _count: { members: number; teams: number };
}

export interface Team {
  id: string;
  name: string;
  description: string | null;
  departmentId: string | null;
  department: DepartmentRef | null;
  members: { user: { id: string; firstName: string; lastName: string; email: string } }[];
}

export interface AccountSummary {
  id: string;
  name: string;
  website: string | null;
  industry: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  country: string | null;
  createdAt: string;
  updatedAt: string;
  _count: { contacts: number };
}

export interface AccountDetail extends Omit<AccountSummary, '_count'> {
  addressLine1: string | null;
  addressLine2: string | null;
  state: string | null;
  postalCode: string | null;
  description: string | null;
}

export interface ContactSummary {
  id: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  jobTitle: string | null;
  status: ContactStatus;
  isVip: boolean;
  createdAt: string;
  updatedAt: string;
  account: { id: string; name: string } | null;
}

export interface ContactDetail extends ContactSummary {
  avatarUrl: string | null;
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface TicketStatusRef {
  id: string;
  name: string;
  color: string;
  isResolved: boolean;
  isClosed: boolean;
}

export interface TicketStatusConfig extends TicketStatusRef {
  systemKey: string | null;
  position: number;
  isDefault: boolean;
  pausesSla: boolean;
  isSystem: boolean;
}

export interface TicketPriorityRef {
  id: string;
  name: string;
  color: string;
  weight: number;
}

export interface TicketPriorityConfig extends TicketPriorityRef {
  systemKey: string | null;
  position: number;
  isDefault: boolean;
  isSystem: boolean;
}

export interface TicketCategory {
  id: string;
  name: string;
  description: string | null;
  parentId: string | null;
}

export interface TagRef {
  id: string;
  name: string;
  color: string;
}

export interface TagWithCount extends TagRef {
  _count: { tickets: number };
}

export interface TicketSummary extends SlaFields {
  id: string;
  ticketNumber: number;
  subject: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  dueAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  status: TicketStatusRef;
  priority: TicketPriorityRef;
  category: { id: string; name: string } | null;
  department: DepartmentRef | null;
  assignedAgent: { id: string; firstName: string; lastName: string; email: string } | null;
  contact: { id: string; firstName: string; lastName: string | null; email: string | null } | null;
  account: { id: string; name: string } | null;
  tags: { tag: TagRef }[];
  _count: { messages: number; attachments: number };
}

export interface TicketDetail extends Omit<TicketSummary, 'contact'> {
  description: string;
  resolutionNote: string | null;
  customFields: Record<string, unknown> | null;
  mergedIntoTicketId: string | null;
  createdBy: { id: string; firstName: string; lastName: string } | null;
  contact:
    | {
        id: string;
        firstName: string;
        lastName: string | null;
        email: string | null;
        phone: string | null;
        jobTitle: string | null;
        isVip: boolean;
        account: { id: string; name: string } | null;
      }
    | null;
  followers: { userId: string }[];
  links: {
    id: string;
    type: string;
    linkedTicket: {
      id: string;
      ticketNumber: number;
      subject: string;
      status: { name: string; color: string };
    };
  }[];
}

export interface TicketAttachment {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  messageId: string | null;
  createdAt: string;
  uploadedBy?: { id: string; firstName: string; lastName: string } | null;
}

export interface TicketMessage {
  id: string;
  ticketId: string;
  type: 'PUBLIC_REPLY' | 'INTERNAL_COMMENT' | 'SYSTEM_NOTE';
  direction: 'INBOUND' | 'OUTBOUND';
  bodyText: string;
  bodyHtml: string | null;
  channel: string;
  createdAt: string;
  authorUser: { id: string; firstName: string; lastName: string; email: string } | null;
  authorContact: { id: string; firstName: string; lastName: string | null; email: string | null } | null;
  attachments: TicketAttachment[];
}

export interface TicketHistoryEntry {
  id: string;
  action: string;
  actorId: string | null;
  actorType: string;
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  createdAt: string;
  actor: { id: string; firstName: string; lastName: string } | null;
}

export interface TicketQueueSummary {
  total: number;
  open: number;
  unassigned: number;
  assignedToMe: number;
  resolved: number;
  byStatus: { statusId: string; _count: { _all: number } }[];
}

// ---------------------------------------------------------------------------
// Phase 3 — support operations
// ---------------------------------------------------------------------------

export interface SlaFields {
  firstResponseAt: string | null;
  firstResponseDueAt: string | null;
  resolutionDueAt: string | null;
  firstResponseBreachedAt: string | null;
  resolutionBreachedAt: string | null;
  slaPausedAt: string | null;
  slaPolicy: { id: string; name: string } | null;
}

export interface Activity {
  id: string;
  type: 'TASK' | 'CALL' | 'EVENT';
  status: 'OPEN' | 'COMPLETED' | 'CANCELLED';
  subject: string;
  description: string | null;
  dueAt: string | null;
  startAt: string | null;
  endAt: string | null;
  completedAt: string | null;
  callDirection: 'INBOUND' | 'OUTBOUND' | null;
  callDurationSeconds: number | null;
  callOutcome: string | null;
  location: string | null;
  createdAt: string;
  updatedAt: string;
  ticket: { id: string; ticketNumber: number; subject: string } | null;
  contact: { id: string; firstName: string; lastName: string | null } | null;
  account: { id: string; name: string } | null;
  assignedTo: { id: string; firstName: string; lastName: string } | null;
  createdBy: { id: string; firstName: string; lastName: string } | null;
}

export interface ConditionLeafDto {
  field: string;
  op: string;
  value?: string | number | boolean | string[] | null;
}
export interface ConditionTreeDto {
  all: ConditionLeafDto[];
  any: ConditionLeafDto[];
}

export interface AssignmentRule {
  id: string;
  name: string;
  isActive: boolean;
  position: number;
  conditions: ConditionTreeDto;
  strategy: 'SPECIFIC_AGENT' | 'DEPARTMENT' | 'ROUND_ROBIN' | 'LEAST_LOADED';
  departmentId: string | null;
  teamId: string | null;
  agentId: string | null;
  department: { id: string; name: string } | null;
  team: { id: string; name: string } | null;
  agent: { id: string; firstName: string; lastName: string } | null;
}

export interface AutomationRule {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  position: number;
  trigger: string;
  conditions: ConditionTreeDto;
  actions: Record<string, unknown>[];
  runCount: number;
  lastRunAt: string | null;
  createdAt: string;
}

export interface AutomationRun {
  id: string;
  trigger: string;
  matched: boolean;
  actionsApplied: { outcomes?: { type: string; ok: boolean; detail?: string }[] } | null;
  error: string | null;
  createdAt: string;
  rule: { id: string; name: string };
  ticket: { id: string; ticketNumber: number; subject: string } | null;
}

export interface SlaPolicy {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  isDefault: boolean;
  position: number;
  conditions: ConditionTreeDto;
  businessHoursId: string | null;
  warningMinutesBefore: number;
  businessHours: { id: string; name: string; timezone: string } | null;
  targets: {
    id: string;
    priorityId: string | null;
    firstResponseMinutes: number;
    resolutionMinutes: number;
    useBusinessHours: boolean;
    priority: { id: string; name: string } | null;
  }[];
  _count: { tickets: number };
}

export interface Blueprint {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  position: number;
  conditions: ConditionTreeDto;
  transitions: {
    id: string;
    name: string;
    fromStatusId: string | null;
    toStatusId: string;
    requiredFields: string[];
    allowedRoleIds: string[];
    fromStatus: { id: string; name: string; color: string } | null;
    toStatus: { id: string; name: string; color: string };
  }[];
}

export interface TicketTransitions {
  governed: boolean;
  blueprint?: { id: string; name: string };
  transitions: {
    transitionId: string;
    name: string;
    toStatusId: string;
    requiredFields: string[];
  }[];
}

// ---------------------------------------------------------------------------
// Phase 4 — self-service
// ---------------------------------------------------------------------------

export interface KbCategory {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  parentId: string | null;
  visibility: ContentVisibilityDto;
  position: number;
  isActive: boolean;
  _count: { articles: number };
}

export type ContentVisibilityDto = 'PUBLIC' | 'PORTAL_USERS' | 'AGENTS_ONLY';
export type ArticleStatusDto = 'DRAFT' | 'PENDING_REVIEW' | 'PUBLISHED' | 'ARCHIVED';

export interface KbArticleSummary {
  id: string;
  title: string;
  slug: string;
  summary: string | null;
  status: ArticleStatusDto;
  visibility: ContentVisibilityDto;
  position: number;
  publishedAt: string | null;
  viewCount: number;
  helpfulCount: number;
  notHelpfulCount: number;
  createdAt: string;
  updatedAt: string;
  category: { id: string; name: string; slug: string } | null;
  author: { id: string; firstName: string; lastName: string } | null;
}

export interface KbArticle extends KbArticleSummary {
  body: string;
  keywords: string[];
  seoTitle: string | null;
  seoDescription: string | null;
}

export interface KbArticleFeedback {
  id: string;
  isHelpful: boolean;
  comment: string | null;
  createdAt: string;
  user: { id: string; firstName: string; lastName: string } | null;
}

export interface HelpCenter {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  welcomeMessage: string | null;
  logoUrl: string | null;
  primaryColor: string;
  supportEmail: string | null;
  footerText: string | null;
  isPublished: boolean;
  allowPublicBrowsing: boolean;
  allowSelfRegistration: boolean;
  allowTicketSubmission: boolean;
  kbEnabled: boolean;
  communityEnabled: boolean;
  moderateCommunity: boolean;
}

export interface WebFormFieldDto {
  key: string;
  label: string;
  type: 'TEXT' | 'TEXTAREA' | 'EMAIL' | 'PHONE' | 'NUMBER' | 'SELECT' | 'CHECKBOX' | 'DATE';
  required: boolean;
  placeholder: string | null;
  helpText: string | null;
  options: string[];
  mapsTo: 'subject' | 'description' | 'name' | 'email' | 'phone' | 'custom';
}

export interface WebForm {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  fields: WebFormFieldDto[];
  submitLabel: string;
  successMessage: string;
  requireLogin: boolean;
  isActive: boolean;
  submissionCount: number;
  department: { id: string; name: string } | null;
  category: { id: string; name: string } | null;
  priority: { id: string; name: string; color: string } | null;
}

export type TopicTypeDto = 'QUESTION' | 'DISCUSSION' | 'IDEA' | 'PROBLEM' | 'ANNOUNCEMENT';
export type TopicStatusDto = 'OPEN' | 'ANSWERED' | 'CLOSED';
export type ModerationStatusDto = 'PENDING' | 'PUBLISHED' | 'REJECTED';

export interface CommunityCategory {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  visibility: ContentVisibilityDto;
  position: number;
  isActive: boolean;
  _count: { topics: number };
}

export interface CommunityAuthor {
  id: string;
  firstName: string;
  lastName: string;
  type: 'AGENT' | 'CUSTOMER';
}

export interface CommunityTopic {
  id: string;
  title: string;
  slug: string;
  body: string;
  type: TopicTypeDto;
  status: TopicStatusDto;
  moderation: ModerationStatusDto;
  isPinned: boolean;
  isLocked: boolean;
  viewCount: number;
  replyCount: number;
  voteCount: number;
  ticketId: string | null;
  lastActivityAt: string;
  createdAt: string;
  category: { id: string; name: string; slug: string };
  author: CommunityAuthor | null;
}

export interface CommunityReply {
  id: string;
  body: string;
  moderation: ModerationStatusDto;
  isAnswer: boolean;
  voteCount: number;
  createdAt: string;
  author: CommunityAuthor | null;
}

export interface CommunityTopicDetail extends CommunityTopic {
  replies: CommunityReply[];
  votedTopic: boolean;
  votedReplyIds: string[];
}

// Portal (customer-facing) shapes

export interface PortalConfig {
  slug: string;
  name: string;
  tagline: string | null;
  welcomeMessage: string | null;
  logoUrl: string | null;
  primaryColor: string;
  supportEmail: string | null;
  footerText: string | null;
  allowSelfRegistration: boolean;
  allowTicketSubmission: boolean;
  kbEnabled: boolean;
  communityEnabled: boolean;
}

export interface PortalCategory {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  parentId: string | null;
  position: number;
  _count: { articles: number };
}

export interface PortalArticleCard {
  id: string;
  title: string;
  slug: string;
  summary: string | null;
  publishedAt: string | null;
  viewCount: number;
  helpfulCount: number;
  notHelpfulCount: number;
  category: { id: string; name: string; slug: string } | null;
}

export interface PortalArticle extends PortalArticleCard {
  body: string;
  keywords: string[];
  updatedAt: string;
  related: PortalArticleCard[];
  myFeedback: { isHelpful: boolean } | null;
}

export interface PortalForm {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  fields: WebFormFieldDto[];
  submitLabel: string;
  successMessage: string;
  requireLogin: boolean;
}

export interface PortalTicketSummary {
  id: string;
  ticketNumber: number;
  subject: string;
  description: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
  firstResponseDueAt: string | null;
  resolutionDueAt: string | null;
  status: { id: string; name: string; color: string; isResolved: boolean; isClosed: boolean };
  priority: { id: string; name: string; color: string };
  department: { id: string; name: string } | null;
  category: { id: string; name: string } | null;
  assignedAgent: { id: string; firstName: string; lastName: string } | null;
}

export interface PortalMessage {
  id: string;
  bodyText: string;
  bodyHtml: string | null;
  direction: 'INBOUND' | 'OUTBOUND';
  createdAt: string;
  authorUser: { id: string; firstName: string; lastName: string } | null;
  authorContact: { id: string; firstName: string; lastName: string } | null;
  attachments: { id: string; fileName: string; fileSize: number; mimeType: string }[];
}

export interface PortalTicket extends PortalTicketSummary {
  messages: PortalMessage[];
}

export interface PortalProfile {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  emailVerifiedAt: string | null;
  contact: { id: string; phone: string | null; account: { id: string; name: string } | null } | null;
}

export interface PortalTicketOptions {
  departments: { id: string; name: string }[];
  categories: { id: string; name: string }[];
  priorities: { id: string; name: string; color: string }[];
}

// ---------------------------------------------------------------------------
// Phase 5 — omnichannel, webhooks and API keys
// ---------------------------------------------------------------------------

export type ChannelTypeDto =
  | 'EMAIL'
  | 'CHAT'
  | 'WHATSAPP'
  | 'INSTAGRAM'
  | 'FACEBOOK'
  | 'TELEGRAM'
  | 'VOICE';

export interface Channel {
  id: string;
  type: ChannelTypeDto;
  provider: string;
  name: string;
  identifier: string | null;
  isActive: boolean;
  config: Record<string, unknown>;
  departmentId: string | null;
  priorityId: string | null;
  categoryId: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  department: { id: string; name: string } | null;
  priority: { id: string; name: string; color: string } | null;
  category: { id: string; name: string } | null;
  configuredSecrets: string[];
  canSend: boolean;
  _count: { events: number };
  /** Only present in the response that created or rotated it. */
  webhookUrl?: string;
}

export interface ChannelCatalogue {
  providers: Record<ChannelTypeDto, string[]>;
  secretFields: Record<string, { key: string; label: string; required: boolean }[]>;
}

export interface ChannelEvent {
  id: string;
  externalId: string;
  status: 'RECEIVED' | 'PROCESSED' | 'IGNORED' | 'FAILED';
  error: string | null;
  ticketId: string | null;
  messageId: string | null;
  processedAt: string | null;
  createdAt: string;
  channel: { id: string; name: string; type: ChannelTypeDto };
}

export interface WebhookEndpointDto {
  id: string;
  name: string;
  url: string;
  events: string[];
  isActive: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  failureCount: number;
  createdAt: string;
  _count: { deliveries: number };
  /** Returned once, when the endpoint is created or its secret is rotated. */
  secret?: string;
}

export interface WebhookDeliveryDto {
  id: string;
  event: string;
  status: 'PENDING' | 'DELIVERED' | 'FAILED';
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  deliveredAt: string | null;
  createdAt: string;
  endpoint: { id: string; name: string; url: string };
}

export interface ApiKeyDto {
  id: string;
  name: string;
  prefix: string;
  userId: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  role: { id: string; name: string; systemKey: string | null };
  createdBy: { id: string; firstName: string; lastName: string } | null;
  /** Returned once, at creation. */
  key?: string;
}

export interface ChatSessionDto {
  id: string;
  status: 'QUEUED' | 'ACTIVE' | 'ENDED';
  visitorName: string | null;
  visitorEmail: string | null;
  pageUrl: string | null;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  rating: number | null;
  ticketId: string | null;
  contactId: string | null;
  ticket: {
    id: string;
    ticketNumber: number;
    subject: string;
    status: { id: string; name: string; color: string };
    assignedAgent: { id: string; firstName: string; lastName: string } | null;
  } | null;
}

export interface ChatMessageDto {
  id: string;
  bodyText: string;
  direction: 'INBOUND' | 'OUTBOUND';
  createdAt: string;
  authorUser: { id: string; firstName: string; lastName: string } | null;
  authorContact: { id: string; firstName: string; lastName: string } | null;
}

export interface ChatTranscript {
  session: ChatSessionDto;
  messages: ChatMessageDto[];
}

export interface ChatWidgetConfig {
  enabled: boolean;
  name: string;
  primaryColor: string;
  greeting: string;
  offlineMessage: string;
  requireEmail: boolean;
}

// ---------------------------------------------------------------------------
// Phase 6 — AI assistance
// ---------------------------------------------------------------------------

export type AiProviderKindDto = 'ANTHROPIC' | 'HEURISTIC';
export type AiInsightTypeDto = 'SUMMARY' | 'SENTIMENT' | 'INTENT' | 'SUGGESTED_REPLY' | 'KB_SUGGESTIONS';

export interface AiSettingsDto {
  id: string;
  provider: AiProviderKindDto;
  model: string;
  isEnabled: boolean;
  summaryEnabled: boolean;
  sentimentEnabled: boolean;
  intentEnabled: boolean;
  suggestedReplyEnabled: boolean;
  autoAnalyse: boolean;
  assistantDailyLimit: number;
  monthlyTokenBudget: number;
  promptGuidance: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  hasApiKey: boolean;
}

export interface AiSummaryContent {
  text: string;
  highlights: string[];
}

export interface AiSentimentContent {
  sentiment: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'FRUSTRATED';
  score: number;
  rationale: string;
}

export interface AiIntentContent {
  intent: string;
  categoryId: string | null;
  categoryName: string | null;
  priorityId: string | null;
  priorityName: string | null;
  urgency: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  confidence: number;
}

export interface AiReplyContent {
  text: string;
  citedArticleIds: string[];
  grounded: boolean;
}

export interface AiInsightDto {
  id: string;
  type: AiInsightTypeDto;
  status: 'PENDING' | 'READY' | 'FAILED';
  content: Partial<AiSummaryContent & AiSentimentContent & AiIntentContent & AiReplyContent>;
  provider: AiProviderKindDto;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  latencyMs: number;
  error: string | null;
  createdAt: string;
  requestedBy: { id: string; firstName: string; lastName: string } | null;
}

export interface AiUsageDto {
  month: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  budgetTokens: number;
  budgetUsedRatio: number | null;
  byType: {
    type: AiInsightTypeDto;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
  }[];
}

export interface AiArticleSuggestion {
  id: string;
  title: string;
  slug: string;
  summary: string | null;
  score: number;
}

// --- Phase 7: analytics, reporting and CSAT ---------------------------------------

export interface TrendPointDto {
  day: string;
  created: number;
  resolved: number;
  closed: number;
  reopened: number;
}

export interface TicketReportDto {
  range: { from: string; to: string };
  totals: {
    created: number;
    resolved: number;
    closed: number;
    reopened: number;
    open: number;
    unassigned: number;
    overdue: number;
    avgFirstResponseMinutes: number | null;
    avgResolutionMinutes: number | null;
    resolutionRate: number | null;
  };
  trend: TrendPointDto[];
  byPriority: { id: string; name: string; colour: string | null; count: number }[];
  byStatus: { id: string; name: string; colour: string | null; count: number }[];
  byChannel: { channel: string; count: number }[];
  byDepartment: { id: string | null; name: string; created: number; resolved: number }[];
}

export interface AgentReportRowDto {
  agentId: string;
  name: string;
  email: string;
  assigned: number;
  resolved: number;
  publicReplies: number;
  firstResponses: number;
  avgFirstResponseMinutes: number | null;
  avgResolutionMinutes: number | null;
  csatResponses: number;
  csatAverage: number | null;
  openNow: number;
}

export interface AgentReportDto {
  range: { from: string; to: string };
  rows: AgentReportRowDto[];
}

export interface SlaReportDto {
  range: { from: string; to: string };
  totals: {
    firstResponses: number;
    firstResponseMet: number;
    firstResponseBreached: number;
    firstResponseCompliance: number | null;
    resolutions: number;
    resolutionMet: number;
    resolutionBreached: number;
    resolutionCompliance: number | null;
    atRisk: number;
    breachedOpen: number;
  };
  trend: {
    day: string;
    firstResponseMet: number;
    firstResponseBreached: number;
    resolutionMet: number;
    resolutionBreached: number;
  }[];
  byPolicy: {
    id: string;
    name: string;
    firstResponseBreached: number;
    resolutionBreached: number;
    tickets: number;
  }[];
}

export interface CsatReportDto {
  range: { from: string; to: string };
  totals: {
    sent: number;
    responses: number;
    responseRate: number | null;
    average: number | null;
    positive: number;
    neutral: number;
    negative: number;
    satisfactionRate: number | null;
  };
  distribution: { rating: number; count: number }[];
  trend: { day: string; responses: number; average: number | null }[];
  byAgent: { agentId: string; name: string; responses: number; average: number | null }[];
  comments: {
    id: string;
    rating: number;
    comment: string;
    respondedAt: string;
    ticketId: string;
    ticketNumber: number;
    subject: string;
    contactName: string | null;
  }[];
}

export interface DashboardDto {
  range: { from: string; to: string };
  tickets: TicketReportDto['totals'];
  trend: TrendPointDto[];
  byPriority: TicketReportDto['byPriority'];
  byStatus: TicketReportDto['byStatus'];
  byChannel: TicketReportDto['byChannel'];
  sla: SlaReportDto['totals'];
  csat: CsatReportDto['totals'];
  topAgents: AgentReportRowDto[];
}

export type ReportKindDto = 'TICKETS' | 'AGENTS' | 'SLA' | 'CSAT';
export type ExportStatusDto = 'QUEUED' | 'READY' | 'FAILED';

export interface ReportExportDto {
  id: string;
  kind: ReportKindDto;
  filters: Record<string, unknown>;
  status: ExportStatusDto;
  fileName: string | null;
  rowCount: number;
  sizeBytes: number;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  requestedBy: { id: string; firstName: string; lastName: string } | null;
}

export interface ReportDefinitionDto {
  id: string;
  name: string;
  kind: ReportKindDto;
  description: string | null;
  filters: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; firstName: string; lastName: string } | null;
}

export interface CsatSettingsDto {
  id: string;
  isEnabled: boolean;
  delayMinutes: number;
  expiryDays: number;
  subject: string;
  introText: string;
  thankYouText: string;
  createdAt: string;
  updatedAt: string;
}

export interface TicketCsatDto {
  id: string;
  status: 'PENDING' | 'ANSWERED' | 'EXPIRED';
  rating: number | null;
  comment: string | null;
  sentAt: string;
  respondedAt: string | null;
  expiresAt: string;
}

export interface CsatSurveyDto {
  ticketNumber: number;
  subject: string;
  organizationName: string;
  introText: string;
  expiresAt: string;
}

export interface CsatSurveyResultDto {
  rating: number;
  thankYouText: string;
  ticketNumber: number;
  organizationName: string;
}

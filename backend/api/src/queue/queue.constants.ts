export const QUEUE_NAMES = {
  EMAIL: 'email',
  NOTIFICATIONS: 'notifications',
  AUTOMATION: 'automation',
  SLA: 'sla',
  CHANNEL: 'channel',
  WEBHOOK: 'webhook',
  AI: 'ai',
  ANALYTICS: 'analytics',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const EMAIL_JOB = 'send-email';
export const NOTIFICATION_JOB = 'deliver-notification';
export const CHANNEL_SEND_JOB = 'channel-send';
export const WEBHOOK_DELIVER_JOB = 'webhook-deliver';
export const AI_ANALYSE_JOB = 'ai-analyse';
export const METRICS_ROLLUP_JOB = 'metrics-rollup';
export const REPORT_EXPORT_JOB = 'report-export';

/** An agent reply leaving over the channel the ticket arrived on. */
export interface ChannelSendJob {
  organizationId: string;
  channelId: string;
  ticketId: string;
  messageId: string;
  to: string;
}

/** One attempt to hand an event to a customer's HTTP endpoint. */
export interface WebhookDeliveryJob {
  organizationId: string;
  deliveryId: string;
}

/** Automatic analysis of a ticket, out of the request path. */
export interface AiAnalyseJob {
  organizationId: string;
  ticketId: string;
  types?: ('SUMMARY' | 'SENTIMENT' | 'INTENT' | 'SUGGESTED_REPLY')[];
  reason: 'TICKET_CREATED' | 'CUSTOMER_REPLIED' | 'MANUAL';
}

/** One report rendered to CSV and written to storage, out of the request path. */
export interface ReportExportJob {
  organizationId: string;
  exportId: string;
}

export interface SendEmailJob {
  organizationId: string | null;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  /**
   * Class A background work (a message to a customer produced by an automation, a survey):
   * the worker re-checks the organization's Workeasy360 access right before sending. Unset
   * for account-security mail (password reset, verification, invitations), which is not
   * the organization's business and is sent regardless.
   */
  requiresAccess?: boolean;
}

export interface DeliverNotificationJob {
  organizationId: string;
  userId: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
  data?: Record<string, unknown>;
}

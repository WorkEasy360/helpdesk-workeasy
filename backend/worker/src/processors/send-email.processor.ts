import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { EmailProvider } from '../email-provider';
import type { AccessGate } from '../access-gate';

export interface SendEmailJob {
  organizationId: string | null;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  /**
   * Class A: a message the organization's own business produced (an automation's email, a
   * satisfaction survey). Checked right before sending. Account-security mail (password
   * reset, verification, invitations) leaves it unset and is never held back.
   */
  requiresAccess?: boolean;
}

/**
 * Sends one transactional email. Idempotent enough for at-least-once delivery: a
 * retry can duplicate a message, which is preferable to dropping a password reset.
 */
export async function handleSendEmail(
  job: Job<SendEmailJob>,
  deps: { emailProvider: EmailProvider; logger: Logger; gate: AccessGate },
): Promise<{ providerMessageId: string | null }> {
  const { to, subject, html, text, replyTo } = job.data;
  if (
    job.data.requiresAccess &&
    job.data.organizationId &&
    !(await deps.gate.allows(job.data.organizationId, 'email', { jobId: job.id }))
  ) {
    return { providerMessageId: null };
  }
  const providerMessageId = await deps.emailProvider.send({ to, subject, html, text, replyTo });

  deps.logger.info(
    { jobId: job.id, organizationId: job.data.organizationId, providerMessageId },
    `Email sent to ${to}`,
  );
  return { providerMessageId };
}

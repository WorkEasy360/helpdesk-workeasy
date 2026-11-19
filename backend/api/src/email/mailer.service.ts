import { Inject, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { EMAIL_QUEUE } from '../queue/queue.module';
import { EMAIL_JOB, type SendEmailJob } from '../queue/queue.constants';
import { AppConfig } from '../config/config.module';
import { renderEmail, type EmailTemplate } from './templates';

/**
 * Application-facing mail API. Enqueues onto the `email` queue so a slow or failing
 * provider can never block a request; the worker performs the actual send.
 */
@Injectable()
export class MailerService {
  constructor(
    @Inject(EMAIL_QUEUE) private readonly queue: Queue<SendEmailJob>,
    private readonly config: AppConfig,
  ) {}

  get frontendUrl(): string {
    return this.config.get('FRONTEND_URL');
  }

  /**
   * `delayMs` lets a caller post-date a message — a satisfaction survey should not land
   * in the same second as the resolution notice.
   */
  async send(
    organizationId: string | null,
    to: string,
    template: EmailTemplate,
    delayMs = 0,
    options: { requiresAccess?: boolean } = {},
  ): Promise<void> {
    const rendered = renderEmail(template);
    await this.queue.add(
      EMAIL_JOB,
      {
        organizationId,
        to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        ...(options.requiresAccess ? { requiresAccess: true } : {}),
      },
      delayMs > 0 ? { delay: delayMs } : {},
    );
  }
}

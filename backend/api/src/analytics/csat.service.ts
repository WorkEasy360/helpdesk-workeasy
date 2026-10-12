import { Inject, Injectable, Logger } from '@nestjs/common';
import { TenantContext, type TenantPrismaClient } from '@digisoft/db';
import {
  CsatError,
  loadSurvey,
  scheduleSurvey,
  submitSurvey,
  type AnalyticsDeps,
} from '@digisoft/analytics';
import type { AuthenticatedUser, CsatSettingsInput, CsatSubmitInput } from '@digisoft/shared';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfig } from '../config/config.module';
import { AppError } from '../common/errors/app-error';
import { AuditService } from '../audit/audit.service';
import { MailerService } from '../email/mailer.service';

const SETTINGS_SELECT = {
  id: true,
  isEnabled: true,
  delayMinutes: true,
  expiryDays: true,
  subject: true,
  introText: true,
  thankYouText: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Satisfaction surveys. The survey row is written when the mail is queued, so the
 * response rate is measured against surveys actually sent rather than tickets resolved.
 */
@Injectable()
export class CsatService {
  private readonly logger = new Logger(CsatService.name);
  private readonly deps: AnalyticsDeps;

  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {
    this.deps = {
      prisma,
      log: (level, message, meta) =>
        level === 'error' ? this.logger.error(message, meta) : this.logger.warn(message),
    };
  }

  async settings(organizationId: string) {
    const existing = await this.db.csatSettings.findFirst({
      where: { organizationId },
      select: SETTINGS_SELECT,
    });
    if (existing) return existing;
    try {
      return await this.db.csatSettings.create({
        data: { organizationId },
        select: SETTINGS_SELECT,
      });
    } catch {
      // A concurrent first read created it.
      return this.db.csatSettings.findFirstOrThrow({
        where: { organizationId },
        select: SETTINGS_SELECT,
      });
    }
  }

  async updateSettings(actor: AuthenticatedUser, input: CsatSettingsInput) {
    const current = await this.settings(actor.organizationId);
    const settings = await this.db.csatSettings.update({
      where: { id: current.id },
      data: {
        ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
        ...(input.delayMinutes !== undefined ? { delayMinutes: input.delayMinutes } : {}),
        ...(input.expiryDays !== undefined ? { expiryDays: input.expiryDays } : {}),
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(input.introText !== undefined ? { introText: input.introText } : {}),
        ...(input.thankYouText !== undefined ? { thankYouText: input.thankYouText } : {}),
      },
      select: SETTINGS_SELECT,
    });

    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'csat_settings.updated',
      entity: 'CsatSettings',
      entityId: settings.id,
      oldValue: { isEnabled: current.isEnabled, delayMinutes: current.delayMinutes },
      newValue: { isEnabled: settings.isEnabled, delayMinutes: settings.delayMinutes },
    });
    return settings;
  }

  /** What an agent sees on the ticket: the survey's state and, once given, the score. */
  async forTicket(ticketId: string) {
    return this.db.csatResponse.findFirst({
      where: { ticketId },
      select: {
        id: true,
        status: true,
        rating: true,
        comment: true,
        sentAt: true,
        respondedAt: true,
        expiresAt: true,
      },
    });
  }

  /**
   * Called when a ticket is resolved. Never throws into the caller: a survey that cannot
   * be sent must not fail the resolution that triggered it.
   */
  async onTicketResolved(organizationId: string, ticketId: string): Promise<void> {
    try {
      const survey = await TenantContext.runUnscoped(() =>
        scheduleSurvey(this.deps, organizationId, ticketId),
      );
      if (!survey) return;

      const portal = await TenantContext.runUnscoped(() =>
        this.prisma.helpCenter.findFirst({
          where: { organizationId },
          select: { slug: true, organization: { select: { name: true } } },
        }),
      );
      if (!portal) {
        this.logger.warn(`No help center for ${organizationId}; survey ${survey.id} has nowhere to land`);
        return;
      }

      const url = `${this.config.get('FRONTEND_URL')}/help/${portal.slug}/csat/${survey.token}`;
      await this.mailer.send(
        organizationId,
        survey.contactEmail,
        {
          kind: 'csat-survey',
          subject: survey.subject,
          contactName: survey.contactName,
          organizationName: portal.organization.name,
          ticketNumber: survey.ticketNumber,
          ticketSubject: survey.ticketSubject,
          introText: survey.introText,
          url,
        },
        survey.delayMinutes * 60_000,
        // Sent minutes after the resolution, by the worker: re-checked there.
        { requiresAccess: true },
      );
    } catch (error) {
      this.logger.error(
        `Unable to send a satisfaction survey for ${ticketId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Public: the survey behind an emailed token. */
  async load(token: string) {
    return TenantContext.runUnscoped(async () => {
      try {
        const survey = await loadSurvey(this.deps, token);
        const settings = await this.prisma.csatSettings.findUnique({
          where: { organizationId: survey.organizationId },
          select: { introText: true },
        });
        return {
          ticketNumber: survey.ticket.ticketNumber,
          subject: survey.ticket.subject,
          organizationName: survey.organization.name,
          introText: settings?.introText ?? '',
          expiresAt: survey.expiresAt,
        };
      } catch (error) {
        throw this.translate(error);
      }
    });
  }

  /** Public: record an answer. The token is the only credential, and it works once. */
  async submit(token: string, input: CsatSubmitInput) {
    return TenantContext.runUnscoped(async () => {
      try {
        const survey = await submitSurvey(this.deps, token, input);
        return {
          rating: survey.rating,
          thankYouText: survey.thankYouText,
          ticketNumber: survey.ticket.ticketNumber,
          organizationName: survey.organization.name,
        };
      } catch (error) {
        throw this.translate(error);
      }
    });
  }

  private translate(error: unknown): unknown {
    if (error instanceof CsatError) {
      return error.reason === 'NOT_FOUND'
        ? AppError.notFound('Survey', error.message)
        : AppError.validation(error.message);
    }
    return error;
  }
}

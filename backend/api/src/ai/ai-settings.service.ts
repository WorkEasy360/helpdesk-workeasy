import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@digisoft/db';
import type { TenantPrismaClient } from '@digisoft/db';
import type { AiSettingsInput, AuthenticatedUser } from '@digisoft/shared';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import { AppError } from '../common/errors/app-error';
import { AuditService } from '../audit/audit.service';
import { ChannelSecretsService } from '../channels/channel-secrets.service';

const SETTINGS_SELECT = {
  id: true,
  provider: true,
  model: true,
  isEnabled: true,
  summaryEnabled: true,
  sentimentEnabled: true,
  intentEnabled: true,
  suggestedReplyEnabled: true,
  autoAnalyse: true,
  assistantDailyLimit: true,
  monthlyTokenBudget: true,
  promptGuidance: true,
  lastCheckedAt: true,
  lastError: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * The organization's assistant configuration. The provider key is stored with the same
 * encryption as channel credentials and, like those, is never returned — the API only
 * says whether one is held.
 */
@Injectable()
export class AiSettingsService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    private readonly secrets: ChannelSecretsService,
    private readonly audit: AuditService,
  ) {}

  /** Creates the row on first read, so every organization has settings to show. */
  async get(organizationId: string) {
    const { secrets, ...rest } = await this.raw(organizationId);
    return { ...rest, hasApiKey: this.secrets.names(secrets).includes('apiKey') };
  }

  async update(actor: AuthenticatedUser, input: AiSettingsInput) {
    const current = await this.raw(actor.organizationId);

    const provider = input.provider ?? current.provider;
    const sealed =
      input.apiKey === undefined
        ? current.secrets
        : this.secrets.seal(current.secrets, { apiKey: input.apiKey });

    if (provider === 'ANTHROPIC' && (input.isEnabled ?? current.isEnabled)) {
      const hasKey = this.secrets.names(sealed).includes('apiKey');
      if (!hasKey) {
        throw AppError.validation('Add an Anthropic API key before switching the assistant on');
      }
    }

    const settings = await this.db.aiSettings.update({
      where: { id: current.id },
      data: {
        provider,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.apiKey !== undefined ? { secrets: sealed } : {}),
        ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
        ...(input.summaryEnabled !== undefined ? { summaryEnabled: input.summaryEnabled } : {}),
        ...(input.sentimentEnabled !== undefined ? { sentimentEnabled: input.sentimentEnabled } : {}),
        ...(input.intentEnabled !== undefined ? { intentEnabled: input.intentEnabled } : {}),
        ...(input.suggestedReplyEnabled !== undefined
          ? { suggestedReplyEnabled: input.suggestedReplyEnabled }
          : {}),
        ...(input.autoAnalyse !== undefined ? { autoAnalyse: input.autoAnalyse } : {}),
        ...(input.assistantDailyLimit !== undefined
          ? { assistantDailyLimit: input.assistantDailyLimit }
          : {}),
        ...(input.monthlyTokenBudget !== undefined
          ? { monthlyTokenBudget: input.monthlyTokenBudget }
          : {}),
        ...(input.promptGuidance !== undefined ? { promptGuidance: input.promptGuidance } : {}),
      },
      select: { ...SETTINGS_SELECT, secrets: true },
    });

    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'ai_settings.updated',
      entity: 'AiSettings',
      entityId: settings.id,
      oldValue: { provider: current.provider, model: current.model, isEnabled: current.isEnabled },
      newValue: { provider: settings.provider, model: settings.model, isEnabled: settings.isEnabled },
    });

    const { secrets, ...rest } = settings;
    return { ...rest, hasApiKey: this.secrets.names(secrets).includes('apiKey') };
  }

  async recordCheck(organizationId: string, error: string | null): Promise<void> {
    const settings = await this.raw(organizationId);
    await this.db.aiSettings.update({
      where: { id: settings.id },
      data: { lastCheckedAt: new Date(), lastError: error?.slice(0, 500) ?? null },
    });
  }

  /**
   * Creates the row, returning null when a concurrent request created it first. The
   * settings screen loads settings and usage side by side, so two first reads race.
   */
  private async create(organizationId: string) {
    try {
      return await this.db.aiSettings.create({
        data: { organizationId },
        select: { ...SETTINGS_SELECT, secrets: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return null;
      }
      throw error;
    }
  }

  private async raw(organizationId: string) {
    const select = { ...SETTINGS_SELECT, secrets: true };
    return (
      (await this.db.aiSettings.findFirst({ where: { organizationId }, select })) ??
      (await this.create(organizationId)) ??
      (await this.db.aiSettings.findFirstOrThrow({ where: { organizationId }, select }))
    );
  }
}

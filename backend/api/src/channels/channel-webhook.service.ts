import { Injectable, Logger } from '@nestjs/common';
import { TenantContext } from '@digisoft/db';
import { providerFor, safeEqual } from '@digisoft/channels';
import type { ChannelType } from '@digisoft/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AppError } from '../common/errors/app-error';
import { ChannelSecretsService } from './channel-secrets.service';
import { InboundService, type IngestChannel, type IngestOutcome } from './inbound.service';

export interface WebhookRequest {
  channelId: string;
  secret: string;
  rawBody: string;
  payload: unknown;
  headers: Record<string, string | undefined>;
  query: Record<string, string | undefined>;
  url: string;
}

/**
 * The public edge of the channel pipeline. It runs before any tenant context exists, so
 * it resolves the channel with the unscoped client and then opens the scope for the
 * ingestion it hands off to.
 */
@Injectable()
export class ChannelWebhookService {
  private readonly logger = new Logger(ChannelWebhookService.name);
  /** Channels already warned about, so an unsigned channel does not flood the log. */
  private readonly warnedUnsigned = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: ChannelSecretsService,
    private readonly inbound: InboundService,
  ) {}

  async challenge(
    channelId: string,
    secret: string,
    query: Record<string, string | undefined>,
  ): Promise<string> {
    const channel = await this.resolve(channelId, secret);
    const provider = providerFor(channel.type as ChannelType, channel.provider);
    const answer = provider?.challenge?.(query, this.secrets.open(channel.secrets));
    if (!answer) {
      throw AppError.forbidden('Webhook verification failed');
    }
    return answer;
  }

  async receive(request: WebhookRequest): Promise<IngestOutcome[]> {
    const channel = await this.resolve(request.channelId, request.secret);
    const provider = providerFor(channel.type as ChannelType, channel.provider);
    if (!provider) {
      throw AppError.validation(`No adapter is installed for ${channel.type}/${channel.provider}`);
    }

    const secrets = this.secrets.open(channel.secrets);
    if (provider.hasProviderAuth && !provider.hasProviderAuth(secrets)) {
      if (!this.warnedUnsigned.has(channel.id)) {
        this.warnedUnsigned.add(channel.id);
        this.logger.warn(
          `Channel ${channel.id} (${channel.provider}) has no provider signing secret configured; ` +
            'only the webhook URL secret authenticates its requests',
        );
      }
    }
    const verified = provider.verify(
      {
        rawBody: request.rawBody,
        // Providers that sign the request URL (Twilio) need the URL it was posted to.
        headers: { ...request.headers, 'x-digisoft-webhook-url': request.url },
        query: request.query,
      },
      secrets,
    );
    if (!verified) {
      this.logger.warn(`Rejected an unverified webhook for channel ${channel.id}`);
      throw AppError.forbidden('Webhook signature verification failed');
    }

    const messages = provider.parse(request.payload, {
      identifier: channel.identifier,
      config: (channel.config ?? {}) as Record<string, unknown>,
    });

    const ingestChannel: IngestChannel = {
      id: channel.id,
      organizationId: channel.organizationId,
      type: channel.type as ChannelType,
      provider: channel.provider,
      identifier: channel.identifier,
      config: channel.config,
      departmentId: channel.departmentId,
      priorityId: channel.priorityId,
      categoryId: channel.categoryId,
    };

    // Every message is ingested inside the channel's own tenant scope.
    return TenantContext.run(channel.organizationId, async () => {
      const outcomes: IngestOutcome[] = [];
      for (const message of messages) {
        outcomes.push(await this.inbound.ingest(ingestChannel, message));
      }
      return outcomes;
    });
  }

  private async resolve(channelId: string, secret: string) {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, deletedAt: null },
      select: {
        id: true,
        organizationId: true,
        type: true,
        provider: true,
        identifier: true,
        config: true,
        secrets: true,
        webhookSecret: true,
        isActive: true,
        departmentId: true,
        priorityId: true,
        categoryId: true,
      },
    });

    // A wrong id and a wrong secret answer identically, so neither can be probed.
    if (!channel || !channel.webhookSecret || !safeEqual(channel.webhookSecret, secret)) {
      throw AppError.notFound('webhook');
    }
    if (!channel.isActive) {
      throw AppError.validation('This channel is turned off');
    }
    return channel;
  }
}

import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { ChannelWebhookService } from './channel-webhook.service';

/** Files one multipart webhook post may carry (Mailgun forwards attachments this way). */
export const WEBHOOK_MAX_FILES = 10;

/**
 * Where providers post. The path carries the channel id and its URL secret, and the
 * provider's own signature is checked on top of that before anything is stored.
 */
@Public()
@Controller('webhooks')
export class ChannelWebhooksController {
  constructor(private readonly webhooks: ChannelWebhookService) {}

  /** Meta-style subscription handshake: echo the challenge when the token matches. */
  @Get(':channelId/:secret')
  challenge(
    @Param('channelId') channelId: string,
    @Param('secret') secret: string,
    @Query() query: Record<string, string | undefined>,
  ): Promise<string> {
    return this.webhooks.challenge(channelId, secret, query);
  }

  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post(':channelId/:secret')
  // JSON and urlencoded bodies arrive with `rawBody`; multipart is parsed here instead.
  @UseInterceptors(AnyFilesInterceptor())
  async receive(
    @Param('channelId') channelId: string,
    @Param('secret') secret: string,
    @Req() request: Request,
  ): Promise<{ received: true; results: unknown[] }> {
    const headers: Record<string, string | undefined> = Object.fromEntries(
      Object.entries(request.headers).map(([key, value]) => [
        key.toLowerCase(),
        Array.isArray(value) ? value[0] : value,
      ]),
    );
    let rawBody = request.rawBody?.toString('utf8');
    let payload: unknown = request.body;

    if (request.is('multipart/form-data')) {
      // Multipart has no signable raw bytes here. The providers that post it (Mailgun)
      // sign fields, not the body, so the text fields are re-encoded as the urlencoded
      // equivalent for verification and the files become inline attachments.
      const fields = (request.body ?? {}) as Record<string, unknown>;
      rawBody = new URLSearchParams(
        Object.entries(fields).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      ).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
      const files = (request.files ?? []) as Express.Multer.File[];
      if (files.length > 0) {
        payload = {
          ...fields,
          attachments: files.map((file) => ({
            fileName: file.originalname,
            mimeType: file.mimetype || 'application/octet-stream',
            contentBase64: file.buffer.toString('base64'),
          })),
        };
      }
    }

    const results = await this.webhooks.receive({
      channelId,
      secret,
      rawBody: rawBody ?? JSON.stringify(request.body ?? {}),
      payload,
      headers,
      query: request.query as Record<string, string | undefined>,
      // Correct behind a proxy only with TRUST_PROXY set; Twilio signs this exact URL.
      url: `${request.protocol}://${request.get('host') ?? ''}${request.originalUrl}`,
    });
    return { received: true, results };
  }
}

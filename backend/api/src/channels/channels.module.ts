import { Module } from '@nestjs/common';
import { TicketsModule } from '../tickets/tickets.module';
import { ChannelsController } from './channels.controller';
import { ChannelWebhooksController } from './webhooks.controller';
import { ChannelsService } from './channels.service';
import { ChannelWebhookService } from './channel-webhook.service';
import { InboundService } from './inbound.service';
import { ChannelOutboundModule } from './channel-outbound.module';
import { attachmentMulterModule } from '../attachments/multer-options';
import { WEBHOOK_MAX_FILES } from './webhooks.controller';

@Module({
  // Multipart webhook posts (Mailgun with attachments) are parsed with the upload limits.
  imports: [TicketsModule, ChannelOutboundModule, attachmentMulterModule(WEBHOOK_MAX_FILES)],
  controllers: [ChannelsController, ChannelWebhooksController],
  providers: [ChannelsService, ChannelWebhookService, InboundService],
  exports: [ChannelsService, InboundService],
})
export class ChannelsModule {}

import { Global, Module } from '@nestjs/common';
import { TicketsModule } from '../tickets/tickets.module';
import { ChannelOutboundModule } from '../channels/channel-outbound.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiSettingsService } from './ai-settings.service';
import { AiDispatchModule } from './ai-dispatch.module';
import { AssistantController } from './assistant/assistant.controller';
import { AssistantService } from './assistant/assistant.service';

/**
 * Global so the automation side can ask for an insight without importing the module
 * that owns the HTTP surface.
 */
@Global()
@Module({
  imports: [TicketsModule, ChannelOutboundModule, AiDispatchModule],
  controllers: [AiController, AssistantController],
  providers: [AiService, AiSettingsService, AssistantService],
  exports: [AiService, AiSettingsService],
})
export class AiModule {}

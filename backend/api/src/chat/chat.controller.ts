import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  PERMISSIONS,
  chatMessageSchema,
  listChatSessionsQuerySchema,
  rateChatSchema,
  startChatSchema,
  type AuthenticatedUser,
  type ChatMessageInput,
  type ListChatSessionsQuery,
  type RateChatInput,
  type StartChatInput,
  patchSchema,
} from '@digisoft/shared';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import { AppError } from '../common/errors/app-error';
import { CurrentHelpCenter, PortalGuard, PortalUser } from '../portal/portal.guard';
import type { PortalHelpCenter } from '../portal/portal.types';
import { ChatService } from './chat.service';

/** The widget's endpoints. A chat is addressed by help center slug, like the portal. */
@Public()
@UseGuards(PortalGuard)
@Controller('portal/:slug/chat')
export class PortalChatController {
  constructor(private readonly chat: ChatService) {}

  /** Whether chat is available here, and what the widget should greet people with. */
  @Get('config')
  async config(
    @CurrentHelpCenter() helpCenter: PortalHelpCenter,
    @Headers('origin') origin: string | undefined,
  ) {
    await this.chat.assertWidgetOrigin(origin);
    const channel = await this.chat.channel();
    const config = (channel?.config ?? {}) as Record<string, unknown>;
    return {
      enabled: channel !== null,
      name: helpCenter.name,
      primaryColor: helpCenter.primaryColor,
      greeting: typeof config['greeting'] === 'string' ? config['greeting'] : 'Hi! How can we help?',
      offlineMessage:
        typeof config['offlineMessage'] === 'string'
          ? config['offlineMessage']
          : 'We are offline right now — leave a message and we will reply by email.',
      requireEmail: config['requireEmail'] !== false,
    };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('start')
  async start(
    @CurrentHelpCenter() helpCenter: PortalHelpCenter,
    @PortalUser() user: AuthenticatedUser | null,
    @Body(zodBody(startChatSchema)) dto: StartChatInput,
    @Req() request: Request,
  ) {
    await this.chat.assertWidgetOrigin(request.headers.origin);
    return this.chat.start(helpCenter.organizationId, dto, {
      ip: request.ip ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      contactId: user?.contactId ?? null,
    });
  }

  @Get('session')
  async session(
    @Headers('x-chat-token') token: string | undefined,
    @Headers('origin') origin: string | undefined,
  ) {
    await this.chat.assertWidgetOrigin(origin);
    const session = await this.requireSession(token);
    return this.chat.transcript(session.id);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('messages')
  async message(
    @CurrentHelpCenter() helpCenter: PortalHelpCenter,
    @Headers('x-chat-token') token: string | undefined,
    @Headers('origin') origin: string | undefined,
    @Body(zodBody(chatMessageSchema)) dto: ChatMessageInput,
  ) {
    await this.chat.assertWidgetOrigin(origin);
    const session = await this.requireSession(token);
    return this.chat.visitorMessage(helpCenter.organizationId, session.id, dto);
  }

  @HttpCode(HttpStatus.OK)
  @Post('end')
  async end(
    @CurrentHelpCenter() helpCenter: PortalHelpCenter,
    @Headers('x-chat-token') token: string | undefined,
    @Headers('origin') origin: string | undefined,
    @Body(zodBody(patchSchema(rateChatSchema))) dto: Partial<RateChatInput>,
  ) {
    await this.chat.assertWidgetOrigin(origin);
    const session = await this.requireSession(token);
    return this.chat.end(helpCenter.organizationId, session.id, dto.rating);
  }

  private async requireSession(token: string | undefined) {
    if (!token) {
      throw AppError.unauthenticated('This chat session is no longer valid');
    }
    return this.chat.fromToken(token);
  }
}

/** The agent's chat inbox. Replies themselves go through the normal ticket endpoints. */
@Controller('chat')
export class AgentChatController {
  constructor(private readonly chat: ChatService) {}

  @RequirePermissions(PERMISSIONS.CHAT_HANDLE)
  @Get('sessions')
  list(@Query(zodBody(listChatSessionsQuerySchema)) query: ListChatSessionsQuery) {
    return this.chat.list(query);
  }

  @RequirePermissions(PERMISSIONS.CHAT_HANDLE)
  @Get('sessions/:id')
  transcript(@Param('id') id: string) {
    return this.chat.transcript(id);
  }

  @RequirePermissions(PERMISSIONS.CHAT_HANDLE)
  @Post('sessions/:id/accept')
  accept(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.chat.accept(id, user);
  }

  @RequirePermissions(PERMISSIONS.CHAT_HANDLE)
  @HttpCode(HttpStatus.OK)
  @Post('sessions/:id/end')
  end(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.chat.end(user.organizationId, id);
  }
}

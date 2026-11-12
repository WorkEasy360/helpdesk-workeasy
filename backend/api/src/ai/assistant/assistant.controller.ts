import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  PERMISSIONS,
  assistantAskSchema,
  type AssistantAskInput,
  type AuthenticatedUser,
} from '@digisoft/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { AssistantService } from './assistant.service';

/**
 * The workspace assistant. `ai.use` is the gate — the same permission that opens the
 * per-ticket insights — and the organization's daily allowance is taken inside `ask`.
 *
 * There is no write endpoint here on purpose: a confirmed action goes to the product's
 * own endpoint, which validates and audits it like any other change.
 */
@Controller('assistant')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @RequirePermissions(PERMISSIONS.AI_USE)
  @Get()
  welcome(@CurrentUser() user: AuthenticatedUser) {
    return this.assistant.welcome(user);
  }

  /**
   * Rate limited per member on top of the organization's daily allowance: the
   * allowance stops a workspace spending its budget, this stops one tab spending it.
   */
  @RequirePermissions(PERMISSIONS.AI_USE)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post()
  ask(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(assistantAskSchema)) dto: AssistantAskInput,
  ) {
    return this.assistant.ask(user, dto);
  }
}

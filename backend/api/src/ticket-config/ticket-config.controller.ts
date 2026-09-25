import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import {
  PERMISSIONS,
  tagSchema,
  ticketCategorySchema,
  ticketPrioritySchema,
  ticketStatusSchema,
  type AuthenticatedUser,
  type TagInput,
  type TicketCategoryInput,
  type TicketPriorityInput,
  type TicketStatusInput,
  patchSchema,
} from '@digisoft/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import { TicketConfigService } from './ticket-config.service';

@Controller()
export class TicketConfigController {
  constructor(private readonly config: TicketConfigService) {}

  // Reading the configuration needs only ticket.read: every agent screen depends on it.
  @RequirePermissions(PERMISSIONS.TICKET_READ)
  @Get('ticket-statuses')
  listStatuses() {
    return this.config.listStatuses();
  }

  @RequirePermissions(PERMISSIONS.TICKET_CONFIG)
  @Post('ticket-statuses')
  createStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(ticketStatusSchema)) dto: TicketStatusInput,
  ) {
    return this.config.createStatus(user, dto);
  }

  @RequirePermissions(PERMISSIONS.TICKET_CONFIG)
  @Patch('ticket-statuses/:id')
  updateStatus(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(patchSchema(ticketStatusSchema))) dto: Partial<TicketStatusInput>,
  ) {
    return this.config.updateStatus(id, user, dto);
  }

  @RequirePermissions(PERMISSIONS.TICKET_CONFIG)
  @Delete('ticket-statuses/:id')
  async removeStatus(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.config.removeStatus(id, user);
    return { deleted: true };
  }

  @RequirePermissions(PERMISSIONS.TICKET_READ)
  @Get('ticket-priorities')
  listPriorities() {
    return this.config.listPriorities();
  }

  @RequirePermissions(PERMISSIONS.TICKET_CONFIG)
  @Post('ticket-priorities')
  createPriority(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(ticketPrioritySchema)) dto: TicketPriorityInput,
  ) {
    return this.config.createPriority(user, dto);
  }

  @RequirePermissions(PERMISSIONS.TICKET_CONFIG)
  @Patch('ticket-priorities/:id')
  updatePriority(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(patchSchema(ticketPrioritySchema))) dto: Partial<TicketPriorityInput>,
  ) {
    return this.config.updatePriority(id, user, dto);
  }

  @RequirePermissions(PERMISSIONS.TICKET_CONFIG)
  @Delete('ticket-priorities/:id')
  async removePriority(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.config.removePriority(id, user);
    return { deleted: true };
  }

  @RequirePermissions(PERMISSIONS.TICKET_READ)
  @Get('ticket-categories')
  listCategories() {
    return this.config.listCategories();
  }

  @RequirePermissions(PERMISSIONS.TICKET_CONFIG)
  @Post('ticket-categories')
  createCategory(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(ticketCategorySchema)) dto: TicketCategoryInput,
  ) {
    return this.config.createCategory(user, dto);
  }

  @RequirePermissions(PERMISSIONS.TICKET_CONFIG)
  @Patch('ticket-categories/:id')
  updateCategory(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(patchSchema(ticketCategorySchema))) dto: Partial<TicketCategoryInput>,
  ) {
    return this.config.updateCategory(id, user, dto);
  }

  @RequirePermissions(PERMISSIONS.TICKET_CONFIG)
  @Delete('ticket-categories/:id')
  async removeCategory(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.config.removeCategory(id, user);
    return { deleted: true };
  }

  @RequirePermissions(PERMISSIONS.TICKET_READ)
  @Get('tags')
  listTags() {
    return this.config.listTags();
  }

  @RequirePermissions(PERMISSIONS.TICKET_CONFIG)
  @Post('tags')
  createTag(@CurrentUser() user: AuthenticatedUser, @Body(zodBody(tagSchema)) dto: TagInput) {
    return this.config.createTag(user, dto);
  }

  @RequirePermissions(PERMISSIONS.TICKET_CONFIG)
  @Delete('tags/:id')
  async removeTag(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.config.removeTag(id, user);
    return { deleted: true };
  }
}

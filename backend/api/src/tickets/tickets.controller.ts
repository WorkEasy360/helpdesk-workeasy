import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  PERMISSIONS,
  assignTicketSchema,
  bulkUpdateTicketsSchema,
  changePrioritySchema,
  changeStatusSchema,
  createMessageSchema,
  createTicketSchema,
  linkTicketSchema,
  listTicketsQuerySchema,
  mergeTicketSchema,
  paginationQuerySchema,
  resolveTicketSchema,
  setTicketTagsSchema,
  updateTicketSchema,
  type AssignTicketInput,
  type AuthenticatedUser,
  type BulkUpdateTicketsInput,
  type ChangePriorityInput,
  type ChangeStatusInput,
  type CreateMessageInput,
  type CreateTicketInput,
  type LinkTicketInput,
  type ListTicketsQuery,
  type MergeTicketInput,
  type PaginationQuery,
  type ResolveTicketInput,
  type SetTicketTagsInput,
  type UpdateTicketInput,
} from '@digisoft/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import { TicketsService } from './tickets.service';
import { TicketMessagesService } from './ticket-messages.service';

@Controller('tickets')
export class TicketsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly messages: TicketMessagesService,
  ) {}

  @RequirePermissions(PERMISSIONS.TICKET_READ)
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query(zodBody(listTicketsQuerySchema)) query: ListTicketsQuery,
  ) {
    return this.tickets.list(user, query);
  }

  @RequirePermissions(PERMISSIONS.TICKET_READ)
  @Get('summary')
  summary(@CurrentUser() user: AuthenticatedUser) {
    return this.tickets.summary(user);
  }

  /** One action over up to 100 tickets; see TicketsService.bulkUpdate. */
  @RequirePermissions(PERMISSIONS.TICKET_UPDATE)
  @HttpCode(HttpStatus.OK)
  @Post('bulk')
  bulkUpdate(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(bulkUpdateTicketsSchema)) dto: BulkUpdateTicketsInput,
  ) {
    return this.tickets.bulkUpdate(user, dto);
  }

  @RequirePermissions(PERMISSIONS.TICKET_READ)
  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tickets.findById(user, id);
  }

  @RequirePermissions(PERMISSIONS.TICKET_CREATE)
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(createTicketSchema)) dto: CreateTicketInput,
  ) {
    return this.tickets.create(user, dto);
  }

  @RequirePermissions(PERMISSIONS.TICKET_UPDATE)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(updateTicketSchema)) dto: UpdateTicketInput,
  ) {
    return this.tickets.update(id, user, dto);
  }

  @RequirePermissions(PERMISSIONS.TICKET_ASSIGN)
  @HttpCode(HttpStatus.OK)
  @Post(':id/assign')
  assign(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(assignTicketSchema)) dto: AssignTicketInput,
  ) {
    return this.tickets.assign(id, user, dto);
  }

  @RequirePermissions(PERMISSIONS.TICKET_UPDATE)
  @HttpCode(HttpStatus.OK)
  @Post(':id/status')
  changeStatus(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(changeStatusSchema)) dto: ChangeStatusInput,
  ) {
    return this.tickets.changeStatus(id, user, dto);
  }

  @RequirePermissions(PERMISSIONS.TICKET_UPDATE)
  @HttpCode(HttpStatus.OK)
  @Post(':id/priority')
  changePriority(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(changePrioritySchema)) dto: ChangePriorityInput,
  ) {
    return this.tickets.changePriority(id, user, dto);
  }

  @RequirePermissions(PERMISSIONS.TICKET_UPDATE)
  @HttpCode(HttpStatus.OK)
  @Post(':id/resolve')
  resolve(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(resolveTicketSchema)) dto: ResolveTicketInput,
  ) {
    return this.tickets.resolve(id, user, dto);
  }

  @RequirePermissions(PERMISSIONS.TICKET_UPDATE)
  @HttpCode(HttpStatus.OK)
  @Post(':id/close')
  close(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tickets.close(id, user);
  }

  @RequirePermissions(PERMISSIONS.TICKET_UPDATE)
  @HttpCode(HttpStatus.OK)
  @Post(':id/reopen')
  reopen(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tickets.reopen(id, user);
  }

  @RequirePermissions(PERMISSIONS.TICKET_UPDATE)
  @Patch(':id/tags')
  setTags(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(setTicketTagsSchema)) dto: SetTicketTagsInput,
  ) {
    return this.tickets.setTags(id, user, dto.tagIds);
  }

  @RequirePermissions(PERMISSIONS.TICKET_MERGE)
  @HttpCode(HttpStatus.OK)
  @Post(':id/merge')
  merge(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(mergeTicketSchema)) dto: MergeTicketInput,
  ) {
    return this.tickets.merge(id, user, dto);
  }

  @RequirePermissions(PERMISSIONS.TICKET_UPDATE)
  @Post(':id/links')
  link(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(linkTicketSchema)) dto: LinkTicketInput,
  ) {
    return this.tickets.link(id, user, dto);
  }

  @RequirePermissions(PERMISSIONS.TICKET_UPDATE)
  @Delete(':id/links/:linkId')
  unlink(
    @Param('id') id: string,
    @Param('linkId') linkId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tickets.unlink(id, user, linkId);
  }

  @RequirePermissions(PERMISSIONS.TICKET_READ)
  @HttpCode(HttpStatus.OK)
  @Post(':id/follow')
  follow(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tickets.follow(id, user, true);
  }

  @RequirePermissions(PERMISSIONS.TICKET_READ)
  @HttpCode(HttpStatus.OK)
  @Post(':id/unfollow')
  unfollow(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tickets.follow(id, user, false);
  }

  @RequirePermissions(PERMISSIONS.TICKET_READ)
  @Get(':id/transitions')
  transitions(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tickets.transitions(id, user);
  }

  @RequirePermissions(PERMISSIONS.TICKET_READ)
  @Get(':id/history')
  history(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query(zodBody(paginationQuerySchema)) query: PaginationQuery,
  ) {
    return this.tickets.history(id, user, query);
  }

  @RequirePermissions(PERMISSIONS.TICKET_READ)
  @Get(':id/messages')
  listMessages(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query(zodBody(paginationQuerySchema.extend({ pageSize: paginationQuerySchema.shape.pageSize.default(100) })))
    query: PaginationQuery,
  ) {
    return this.messages.list(id, user, query);
  }

  @RequirePermissions(PERMISSIONS.TICKET_REPLY)
  @Post(':id/messages')
  addReply(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(createMessageSchema)) dto: CreateMessageInput,
  ) {
    return this.messages.addReply(id, user, dto);
  }

  @RequirePermissions(PERMISSIONS.TICKET_COMMENT)
  @Post(':id/comments')
  addComment(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(createMessageSchema)) dto: CreateMessageInput,
  ) {
    return this.messages.addComment(id, user, dto);
  }

  @RequirePermissions(PERMISSIONS.TICKET_DELETE)
  @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.tickets.remove(id, user);
    return { deleted: true };
  }
}

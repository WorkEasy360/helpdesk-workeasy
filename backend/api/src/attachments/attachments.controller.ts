import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Res,
  UploadedFile as UploadedFileParam,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { PERMISSIONS, type AuthenticatedUser } from '@digisoft/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { AppError } from '../common/errors/app-error';
import { AttachmentsService, type UploadedFile } from './attachments.service';
import { sendAttachmentDownload } from './attachment-download';

@Controller()
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @RequirePermissions(PERMISSIONS.ATTACHMENT_CREATE)
  @Post('tickets/:id/attachments')
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @Param('id') ticketId: string,
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFileParam() file: UploadedFile | undefined,
  ) {
    if (!file) {
      throw AppError.validation('No file was uploaded');
    }
    return this.attachments.upload(ticketId, user, file);
  }

  @RequirePermissions(PERMISSIONS.TICKET_READ)
  @Get('tickets/:id/attachments')
  list(@Param('id') ticketId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.attachments.listForTicket(ticketId, user);
  }

  /**
   * Authorised download. Object storage answers with a short-lived signed URL; local
   * storage is streamed through the API so the same checks apply either way. With
   * `?mode=url` (or `Accept: application/json`) the link comes back as JSON instead.
   */
  @RequirePermissions(PERMISSIONS.TICKET_READ)
  @Get('attachments/:id/download')
  async download(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    sendAttachmentDownload(req, res, await this.attachments.download(id, user));
  }

  @RequirePermissions(PERMISSIONS.ATTACHMENT_DELETE)
  @Delete('attachments/:id')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.attachments.remove(id, user);
    return { deleted: true };
  }
}

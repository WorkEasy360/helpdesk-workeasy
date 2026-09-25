import { Module } from '@nestjs/common';
import { TicketsModule } from '../tickets/tickets.module';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { attachmentMulterModule } from './multer-options';

@Module({
  imports: [
    TicketsModule,
    attachmentMulterModule(),
  ],
  controllers: [AttachmentsController],
  providers: [AttachmentsService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}

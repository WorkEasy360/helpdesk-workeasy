import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { AuthenticatedUser } from '@digisoft/shared';
import { TENANT_PRISMA } from '../prisma/prisma.module';
import type { TenantPrismaClient } from '@digisoft/db';
import { AppError } from '../common/errors/app-error';
import { AppConfig } from '../config/config.module';
import { AuditService } from '../audit/audit.service';
import {
  STORAGE_PROVIDER,
  type DownloadTarget,
  type StorageProvider,
} from '@digisoft/storage';
import { TicketsService } from '../tickets/tickets.service';

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * Files people attach to tickets. PostgreSQL holds only metadata; the bytes go to the
 * configured storage provider, and every download is authorised through this service
 * rather than served from a public bucket path.
 */
@Injectable()
export class AttachmentsService {
  /**
   * An allowlist rather than a blocklist: anything not named here is refused, so a new
   * dangerous type cannot slip through by omission.
   */
  private static readonly ALLOWED_MIME_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'application/pdf',
    'text/plain',
    'text/csv',
    'application/json',
    'application/zip',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ]);

  constructor(
    @Inject(TENANT_PRISMA) private readonly db: TenantPrismaClient,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly tickets: TicketsService,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  get maxBytes(): number {
    return this.config.get('ATTACHMENT_MAX_BYTES');
  }

  async upload(ticketId: string, actor: AuthenticatedUser, file: UploadedFile) {
    await this.tickets.assertVisible(actor, ticketId);
    this.validate(file);

    const safeName = AttachmentsService.sanitiseFileName(file.originalname);
    // The key is generated server-side and never derived from user input, so a crafted
    // filename cannot steer the write.
    const storageKey = `${actor.organizationId}/tickets/${ticketId}/${randomUUID()}${path
      .extname(safeName)
      .toLowerCase()}`;

    await this.storage.put(storageKey, file.buffer, file.mimetype);

    const attachment = await this.db.attachment.create({
      data: {
        organizationId: actor.organizationId,
        ticketId,
        fileName: safeName,
        fileSize: file.size,
        mimeType: file.mimetype,
        storageKey,
        uploadedById: actor.id,
      },
      select: {
        id: true,
        fileName: true,
        fileSize: true,
        mimeType: true,
        ticketId: true,
        messageId: true,
        createdAt: true,
      },
    });

    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'ticket.attachment_added',
      entity: 'Ticket',
      entityId: ticketId,
      newValue: { attachmentId: attachment.id, fileName: attachment.fileName },
    });
    return attachment;
  }

  async listForTicket(ticketId: string, actor: AuthenticatedUser) {
    await this.tickets.assertVisible(actor, ticketId);
    return this.db.attachment.findMany({
      where: { ticketId },
      select: {
        id: true,
        fileName: true,
        fileSize: true,
        mimeType: true,
        messageId: true,
        createdAt: true,
        uploadedBy: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Resolves a download after re-checking that the caller may open the ticket. */
  async download(
    id: string,
    actor: AuthenticatedUser,
  ): Promise<{ target: DownloadTarget; fileName: string; mimeType: string; fileSize: number }> {
    const attachment = await this.db.attachment.findUnique({
      where: { id },
      select: {
        id: true,
        ticketId: true,
        fileName: true,
        mimeType: true,
        fileSize: true,
        storageKey: true,
      },
    });
    if (!attachment) {
      throw AppError.notFound('attachment');
    }
    if (attachment.ticketId) {
      await this.tickets.assertVisible(actor, attachment.ticketId);
    }

    const target = await this.storage.download(
      attachment.storageKey,
      attachment.fileName,
      attachment.mimeType,
    );
    return {
      target,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      fileSize: attachment.fileSize,
    };
  }

  async remove(id: string, actor: AuthenticatedUser): Promise<void> {
    const attachment = await this.db.attachment.findUnique({
      where: { id },
      select: { id: true, ticketId: true, storageKey: true, fileName: true },
    });
    if (!attachment) {
      throw AppError.notFound('attachment');
    }
    if (attachment.ticketId) {
      await this.tickets.assertVisible(actor, attachment.ticketId);
    }

    await this.db.attachment.delete({ where: { id } });
    await this.storage.remove(attachment.storageKey);
    await this.audit.record({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action: 'ticket.attachment_removed',
      entity: 'Ticket',
      entityId: attachment.ticketId ?? attachment.id,
      oldValue: { attachmentId: id, fileName: attachment.fileName },
    });
  }

  private validate(file: UploadedFile): void {
    if (!file.buffer || file.size === 0) {
      throw AppError.validation('The uploaded file is empty');
    }
    if (file.size > this.maxBytes) {
      throw new AppError(
        'FILE_TOO_LARGE',
        `Files must be ${Math.floor(this.maxBytes / (1024 * 1024))} MB or smaller`,
        413,
      );
    }
    if (!AttachmentsService.ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new AppError(
        'UNSUPPORTED_MEDIA_TYPE',
        `Files of type ${file.mimetype} are not accepted`,
        415,
      );
    }
  }

  /**
   * Strips directories and control characters so the stored name is safe to echo back.
   * Both `/` and `\` count as separators whatever the host OS: `path.basename` only
   * knows the platform's own, which made the result differ between Linux and Windows.
   */
  static sanitiseFileName(name: string): string {
    const base = (name.split(/[\\/]/).pop() ?? '').replace(/[\x00-\x1f\x7f]/g, '');
    const cleaned = base.replace(/[:*?"<>|]/g, '_').trim();
    const usable = cleaned.length > 0 && cleaned !== '.' && cleaned !== '..';
    return (usable ? cleaned : 'file').slice(0, 200);
  }
}

import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AppConfig } from '../config/config.module';

/**
 * The one upload policy for every route that accepts files. Files are buffered in
 * memory and handed to the storage provider, so the multer limit is what stops an
 * oversized upload before it is held in full; services still check size themselves.
 * Each module with an upload route registers it — multer defaults are unbounded.
 */
export function attachmentMulterModule(maxFiles = 1) {
  return MulterModule.registerAsync({
    inject: [AppConfig],
    useFactory: (config: AppConfig) => ({
      storage: memoryStorage(),
      limits: { fileSize: config.get('ATTACHMENT_MAX_BYTES'), files: maxFiles },
    }),
  });
}

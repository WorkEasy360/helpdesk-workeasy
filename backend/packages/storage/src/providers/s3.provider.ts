import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { DownloadTarget, StorageProvider, StoredObject } from '../types';

export interface S3Options {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle: boolean;
  /** Seconds a download link stays valid. */
  signedUrlTtl: number;
}

/** S3 and S3-compatible storage (AWS S3, MinIO, Cloudflare R2). */
export class S3StorageProvider implements StorageProvider {
  readonly name = 's3';
  private readonly client: S3Client;

  constructor(private readonly options: S3Options) {
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle,
      // Falls back to the standard AWS provider chain when no keys are configured.
      credentials:
        options.accessKeyId && options.secretAccessKey
          ? { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey }
          : undefined,
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return { storageKey: key, size: body.byteLength };
  }

  async download(key: string, fileName: string, contentType: string): Promise<DownloadTarget> {
    // Taken before signing, so the reported expiry is never later than the real one.
    const expiresAt = new Date(Date.now() + this.options.signedUrlTtl * 1000);
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        // Force a download with the original name rather than rendering in the tab.
        ResponseContentDisposition: `attachment; filename="${encodeURIComponent(fileName)}"`,
        ResponseContentType: contentType,
      }),
      { expiresIn: this.options.signedUrlTtl },
    );
    return { url, expiresAt };
  }

  async remove(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }),
    );
  }
}

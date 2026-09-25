import type { Readable } from 'node:stream';

export interface StoredObject {
  storageKey: string;
  size: number;
}

export interface DownloadTarget {
  /** A URL the browser can follow directly (object storage with presigning). */
  url?: string;
  /** When `url` stops working; set alongside it. */
  expiresAt?: Date;
  /** A stream the API proxies itself (local filesystem). */
  stream?: Readable;
}

/** Every file in the product goes through this interface, never a provider SDK. */
export interface StorageProvider {
  readonly name: string;
  put(key: string, body: Buffer, contentType: string): Promise<StoredObject>;
  download(key: string, fileName: string, contentType: string): Promise<DownloadTarget>;
  remove(key: string): Promise<void>;
}

export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');

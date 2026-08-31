export interface PresignResult {
  url: string;
  expiresIn: number;
}
export interface StorageProvider {
  presignPut(
    key: string,
    contentType: string,
    contentLength: number,
    expiresInSec?: number,
  ): Promise<PresignResult>;
  presignGet(key: string, expiresInSec?: number): Promise<PresignResult>;
  deleteObject(key: string): Promise<void>;
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  getObject(key: string): Promise<Buffer>;
  /** Object metadata without downloading the body. Throws if the object is absent. */
  headObject(key: string): Promise<{ contentLength: number; contentType: string | null }>;
  /** Lists every object under `prefix`, paginating internally. */
  listObjects(prefix: string): Promise<{ key: string; lastModified: Date | undefined }[]>;
  publicUrl(key: string): string;
}
export { keys } from './keys.js';
export { createR2Provider } from './r2.js';

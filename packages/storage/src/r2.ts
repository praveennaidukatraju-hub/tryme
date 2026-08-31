import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { PresignResult, StorageProvider } from './index.js';

export interface R2Config {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicUrl: string;
  forcePathStyle: boolean;
  region?: string;
  /** Endpoint used for presigned URL signing (SigV4 Host header).
   *  When behind a reverse proxy, the internal endpoint's host differs from
   *  what MinIO receives as the Host header. Set this to the public-facing
   *  domain (without /minio prefix) so the signed Host matches the header
   *  forwarded by Nginx. Falls back to `endpoint` when omitted. */
  signEndpoint?: string;
  /** Public-facing base URL for presigned PUT/GET URLs sent to the browser.
   *  e.g. "https://rankplex.cloud/minio"
   *  When set, the internal endpoint origin in the generated URL is replaced
   *  with this value so browsers can reach it. */
  presignBaseUrl?: string;
}

// Default NodeHttpHandler timeouts are 0 (disabled) — a stalled R2/MinIO connection would
// otherwise hang GetObject/PutObject calls forever with no error. Bound them so callers
// (e.g. the dispatcher's job pipeline) get a thrown error instead of an indefinite hang.
const R2_REQUEST_HANDLER = {
  connectionTimeout: 10_000,
  requestTimeout: 60_000,
  throwOnRequestTimeout: true,
  socketTimeout: 60_000,
} as const;

export function createR2Provider(cfg: R2Config): StorageProvider {
  const s3 = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region ?? 'auto',
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    forcePathStyle: cfg.forcePathStyle,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: R2_REQUEST_HANDLER,
  });
  // Separate client for presigning when behind a reverse proxy:
  // signs the Host header with the public domain so it matches what Nginx forwards.
  const signS3 = cfg.signEndpoint
    ? new S3Client({
        endpoint: cfg.signEndpoint,
        region: cfg.region ?? 'auto',
        credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
        forcePathStyle: cfg.forcePathStyle,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        requestHandler: R2_REQUEST_HANDLER,
      })
    : s3;
  const sign = async (
    cmd: PutObjectCommand | GetObjectCommand,
    expiresIn: number,
  ): Promise<PresignResult> => {
    let url = await getSignedUrl(signS3, cmd, { expiresIn });
    if (cfg.presignBaseUrl) {
      const signOrigin = new URL(cfg.signEndpoint ?? cfg.endpoint).origin;
      const publicBase = cfg.presignBaseUrl.replace(/\/$/, '');
      url = url.replace(signOrigin, publicBase);
    }
    return { url, expiresIn };
  };
  return {
    // ContentLength omitted from PutObjectCommand: including it forces content-length into
    // X-Amz-SignedHeaders, causing SignatureDoesNotMatch when the real file size differs.
    presignPut: (key, contentType, _contentLength, expiresIn = 300) =>
      sign(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          ContentType: contentType,
        }),
        expiresIn,
      ),
    presignGet: (key, expiresIn = 300) =>
      sign(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), expiresIn),
    deleteObject: async (key) => {
      await s3.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
    },
    putObject: async (key, body, contentType) => {
      await s3.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },
    getObject: async (key) => {
      const res = await s3.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
      const chunks: Uint8Array[] = [];
      for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },
    headObject: async (key) => {
      const res = await s3.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
      return { contentLength: res.ContentLength ?? 0, contentType: res.ContentType ?? null };
    },
    listObjects: async (prefix) => {
      const out: { key: string; lastModified: Date | undefined }[] = [];
      let continuationToken: string | undefined;
      do {
        const res = await s3.send(
          new ListObjectsV2Command({
            Bucket: cfg.bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );
        for (const obj of res.Contents ?? []) {
          if (obj.Key) out.push({ key: obj.Key, lastModified: obj.LastModified });
        }
        continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (continuationToken);
      return out;
    },
    publicUrl: (key) => `${cfg.publicUrl.replace(/\/$/, '')}/${key}`,
  };
}

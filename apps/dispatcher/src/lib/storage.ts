import { createR2Provider } from '@tryme/storage';
import type { Env } from '../env.js';

export function makeStorage(env: Env) {
  return createR2Provider({
    endpoint: env.R2_ENDPOINT,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
    publicUrl: env.R2_PUBLIC_URL,
    forcePathStyle: env.R2_FORCE_PATH_STYLE,
    presignBaseUrl: env.R2_PUBLIC_PRESIGN_BASE,
    signEndpoint: env.R2_SIGN_ENDPOINT,
  });
}

import type { Env } from '../../src/env';
import { buildServer } from '../../src/server';
import type { Containers } from './containers';

export type TestApp = Awaited<ReturnType<typeof buildTestApp>>;

export async function buildTestApp(
  c: Containers,
  envOverrides: Partial<Env> = {},
  opts: {
    beforeListen?: (app: Awaited<ReturnType<typeof buildServer>>) => void | Promise<void>;
  } = {},
) {
  const app = await buildServer({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    API_PORT: 0,
    DATABASE_URL: c.pgUrl,
    REDIS_URL: c.redisUrl,
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef-32min',
    JWT_EXPIRY: '15m',
    REFRESH_TOKEN_EXPIRY: '7d',
    R2_ENDPOINT: c.r2Endpoint,
    R2_ACCESS_KEY_ID: c.r2Key,
    R2_SECRET_ACCESS_KEY: c.r2Secret,
    R2_BUCKET: c.r2Bucket,
    R2_PUBLIC_URL: `${c.r2Endpoint}/${c.r2Bucket}`,
    R2_FORCE_PATH_STYLE: true,
    CORS_ORIGIN: ['http://localhost:3000'],
    COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef-32min',
    ...envOverrides,
  } as Env);
  // Some tests need a throwaway route registered on the instance before it starts
  // listening (e.g. to hit a preHandler in isolation before any real route using it
  // exists yet). Fastify refuses new routes once listening, so this must run first.
  if (opts.beforeListen) await opts.beforeListen(app);
  await app.listen({ port: 0 });
  return app;
}

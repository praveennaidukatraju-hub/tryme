import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

/** Smallest process.env that satisfies the required half of the schema. */
const REQUIRED = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'test-jwt-secret-0123456789abcdef-32min',
  COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef-32min',
  R2_ENDPOINT: 'http://localhost:9000',
  R2_ACCESS_KEY_ID: 'k',
  R2_SECRET_ACCESS_KEY: 's',
  R2_BUCKET: 'b',
  R2_PUBLIC_URL: 'http://localhost:9000/b',
  RESEND_API_KEY: 'r',
};

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});

/**
 * Vars this file asserts *unset* behaviour for. Inherited from the developer's
 * own shell or .env they would otherwise leak in through `original` and make a
 * "defaults to false when unset" case pass or fail depending on whose machine
 * it runs on — which is exactly what happened once a real .env carried
 * SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS=true for local Shopify testing.
 */
const CLEARED = ['SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS'];

function load(overrides: Record<string, string> = {}) {
  const base = { ...original, ...REQUIRED } as NodeJS.ProcessEnv;
  for (const key of CLEARED) delete base[key];
  process.env = { ...base, ...overrides };
  return loadEnv();
}

describe('SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS', () => {
  // This flag decides whether Shopify test charges — which never bill, and which
  // every free development store produces — grant real credits. Anything other
  // than an explicit opt-in has to read as off, because the failure mode is
  // silently giving away GPU spend to anyone who can install the app.
  it('defaults to false when unset', () => {
    const env = load();
    expect(env.SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS).toBe(false);
  });

  it('is true only for the exact string "true"', () => {
    expect(
      load({ SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS: 'true' }).SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS,
    ).toBe(true);
  });

  // Regression guard for the reason this does not use z.coerce.boolean() like
  // R2_FORCE_PATH_STYLE: coercion follows JS truthiness, so every value below —
  // including 'false', the obvious way to write "off" in a .env file — would
  // come back true and quietly enable free credits in production.
  it.each(['false', 'False', 'FALSE', '0', 'no', 'off', '', 'TRUE', 'True', 'yes', '1'])(
    'treats %o as false',
    (value) => {
      expect(
        load({ SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS: value }).SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS,
      ).toBe(false);
    },
  );
});

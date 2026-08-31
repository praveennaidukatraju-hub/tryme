import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  verifyAppProxySignature,
  verifyQueryHmac,
  verifySessionToken,
  verifyWebhookHmac,
} from '../src/modules/shopify/service.js';
import { signHs256 } from './helpers/shopify-session.js';

const SECRET = 'shpss_test_secret';
const API_KEY = 'shpapikey';

describe('shopify service', () => {
  it('verifies a valid webhook HMAC', () => {
    const raw = Buffer.from('{"id":1}');
    const hmac = createHmac('sha256', SECRET).update(raw).digest('base64');
    expect(verifyWebhookHmac(raw, hmac, SECRET)).toBe(true);
    expect(verifyWebhookHmac(raw, 'AAAA', SECRET)).toBe(false);
  });

  it('verifies a valid query HMAC and rejects tampering', () => {
    const params: Record<string, string> = { shop: 'a.myshopify.com', code: 'abc', ts: '1' };
    const msg = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    const hmac = createHmac('sha256', SECRET).update(msg).digest('hex');
    expect(verifyQueryHmac({ ...params, hmac }, SECRET)).toBe(true);
    expect(verifyQueryHmac({ ...params, hmac, code: 'evil' }, SECRET)).toBe(false);
  });

  it('verifies a valid session token', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signHs256(
      {
        iss: 'https://a.myshopify.com/admin',
        dest: 'https://a.myshopify.com',
        aud: API_KEY,
        exp: now + 60,
        nbf: now - 5,
        iat: now,
      },
      SECRET,
    );
    const res = verifySessionToken(token, SECRET, API_KEY);
    expect(res.shopDomain).toBe('a.myshopify.com');
  });

  it('rejects a session token with wrong aud', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signHs256(
      {
        iss: 'https://a.myshopify.com/admin',
        dest: 'https://a.myshopify.com',
        aud: 'other',
        exp: now + 60,
        nbf: now - 5,
      },
      SECRET,
    );
    expect(() => verifySessionToken(token, SECRET, API_KEY)).toThrow();
  });

  it('verifies a valid app proxy signature (sorted, no delimiter, comma-joined multi-values)', () => {
    const params: Record<string, string | string[]> = {
      shop: 'a.myshopify.com',
      path_prefix: '/apps/widget',
      timestamp: '1317327555',
      extra: ['1', '2'],
    };
    // Independently built oracle string, per Shopify's documented app-proxy
    // algorithm — NOT '&'-joined like verifyQueryHmac's OAuth scheme above.
    const msg = Object.keys(params)
      .sort()
      .map((k) => {
        const v = params[k];
        return `${k}=${Array.isArray(v) ? v.join(',') : v}`;
      })
      .join('');
    const signature = createHmac('sha256', SECRET).update(msg).digest('hex');
    expect(verifyAppProxySignature({ ...params, signature }, SECRET)).toBe(true);
  });

  it('rejects a tampered app proxy param and a missing signature', () => {
    const params: Record<string, string> = { shop: 'a.myshopify.com', timestamp: '1317327555' };
    const msg = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('');
    const signature = createHmac('sha256', SECRET).update(msg).digest('hex');
    expect(
      verifyAppProxySignature({ ...params, signature, shop: 'evil.myshopify.com' }, SECRET),
    ).toBe(false);
    expect(verifyAppProxySignature({ ...params }, SECRET)).toBe(false);
  });

  it('does not accept an OAuth-style "&"-joined signature (distinct scheme from verifyQueryHmac)', () => {
    const params: Record<string, string> = { shop: 'a.myshopify.com', timestamp: '1' };
    const ampersandJoined = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    const wrongSignature = createHmac('sha256', SECRET).update(ampersandJoined).digest('hex');
    expect(verifyAppProxySignature({ ...params, signature: wrongSignature }, SECRET)).toBe(false);
  });

  it('rejects an expired session token', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signHs256(
      {
        iss: 'https://a.myshopify.com/admin',
        dest: 'https://a.myshopify.com',
        aud: API_KEY,
        exp: now - 10,
        nbf: now - 60,
      },
      SECRET,
    );
    expect(() => verifySessionToken(token, SECRET, API_KEY)).toThrow();
  });
});

import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptToken } from '../../src/lib/crypto';
import { buildTestApp, type TestApp } from '../helpers/api';
import { createVerifiedUserToken } from '../helpers/auth';
import { type Containers, startContainers } from '../helpers/containers';

const TEST_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
const TEST_CLIENT_ID = 'google-drive-test-client-id';
const TEST_CLIENT_SECRET = 'google-drive-test-client-secret';

describe('google-drive integration', () => {
  let c: Containers;
  let app: TestApp;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c, {
      GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: TEST_CLIENT_SECRET,
      GOOGLE_DRIVE_TOKEN_ENC_KEY: TEST_ENC_KEY,
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /v1/integrations/google-drive/connect', () => {
    it('redirects to Google consent with state and correct params', async () => {
      const { token, userId } = await createVerifiedUserToken(app, 'gdrive-connect@example.com');

      const res = await app.inject({
        method: 'GET',
        url: '/v1/integrations/google-drive/connect',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(302);
      const location = res.headers.location as string;
      expect(location).toBeDefined();
      const url = new URL(location);
      expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(url.searchParams.get('client_id')).toBe(TEST_CLIENT_ID);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('access_type')).toBe('offline');
      expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');

      const state = url.searchParams.get('state');
      expect(state).toBeTruthy();
      const stored = await app.redis.get(`gdrive:oauth:state:${state}`);
      expect(JSON.parse(stored as string)).toEqual({ userId, retried: false });
    });

    it('forces prompt=consent and marks the state retried when ?forceConsent=1', async () => {
      const { token, userId } = await createVerifiedUserToken(
        app,
        'gdrive-connect-retry@example.com',
      );

      const res = await app.inject({
        method: 'GET',
        url: '/v1/integrations/google-drive/connect?forceConsent=1',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(302);
      const url = new URL(res.headers.location as string);
      expect(url.searchParams.get('prompt')).toBe('consent');

      const state = url.searchParams.get('state');
      const stored = await app.redis.get(`gdrive:oauth:state:${state}`);
      expect(JSON.parse(stored as string)).toEqual({ userId, retried: true });
    });

    it('forces prompt=consent if the connection was previously revoked', async () => {
      const { token, userId } = await createVerifiedUserToken(
        app,
        'gdrive-force-consent@example.com',
      );
      await app.db.insert(schema.googleDriveConnections).values({
        userId,
        googleEmail: 'gdrive-force-consent@gmail.com',
        refreshTokenEnc: null,
        scope: 'https://www.googleapis.com/auth/drive.file',
        revokedAt: new Date(),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/integrations/google-drive/connect',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(302);
      const url = new URL(res.headers.location as string);
      expect(url.searchParams.get('prompt')).toBe('consent');
    });
  });

  describe('GET /v1/integrations/google-drive/callback', () => {
    it('redirects with error on missing code or state', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/integrations/google-drive/callback',
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('drive_error=invalid_request');
    });

    it('redirects with error on invalid state', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/integrations/google-drive/callback?code=mock-code&state=nonexistent-state',
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('drive_error=invalid_state');
    });

    it('exchanges code, saves connection, and redirects with drive_connected=1', async () => {
      const { userId } = await createVerifiedUserToken(app, 'gdrive-cb-success@example.com');
      const state = 'test-state-valid-cb';
      await app.redis.set(
        `gdrive:oauth:state:${state}`,
        JSON.stringify({ userId, retried: false }),
        'EX',
        300,
      );

      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = input.toString();
        if (urlStr === 'https://oauth2.googleapis.com/token') {
          return new Response(
            JSON.stringify({
              access_token: 'mock-access-token',
              refresh_token: 'mock-refresh-token-from-google',
              scope: 'https://www.googleapis.com/auth/drive.file',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (urlStr === 'https://www.googleapis.com/drive/v3/about?fields=user') {
          return new Response(JSON.stringify({ user: { emailAddress: 'cb-user@gmail.com' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error(`Unhandled fetch to ${urlStr}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/integrations/google-drive/callback?code=good-code&state=${state}`,
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('drive_connected=1');

      const [conn] = await app.db
        .select()
        .from(schema.googleDriveConnections)
        .where(eq(schema.googleDriveConnections.userId, userId));
      expect(conn).toBeDefined();
      expect(conn.googleEmail).toBe('cb-user@gmail.com');
      expect(conn.refreshTokenEnc).toBeTruthy();
      expect(conn.revokedAt).toBeNull();
    });

    it('retries via the BFF connect route with forceConsent when Google omits the refresh token, once', async () => {
      const { userId } = await createVerifiedUserToken(app, 'gdrive-cb-no-refresh@example.com');
      const state = 'test-state-no-refresh';
      await app.redis.set(
        `gdrive:oauth:state:${state}`,
        JSON.stringify({ userId, retried: false }),
        'EX',
        300,
      );

      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        if (input.toString() === 'https://oauth2.googleapis.com/token') {
          return new Response(
            JSON.stringify({
              access_token: 'mock-access-token',
              scope: 'https://www.googleapis.com/auth/drive.file',
              // no refresh_token — the exact case Google omits it on a repeat grant
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`Unhandled fetch to ${input}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/integrations/google-drive/callback?code=code-no-refresh&state=${state}`,
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('/api/integrations/google-drive/connect');
      expect(res.headers.location).toContain('forceConsent=1');
    });

    it('gives up with drive_error=no_refresh_token if the retried attempt still gets no refresh token', async () => {
      const { userId } = await createVerifiedUserToken(app, 'gdrive-cb-no-refresh-2@example.com');
      const state = 'test-state-no-refresh-retried';
      await app.redis.set(
        `gdrive:oauth:state:${state}`,
        JSON.stringify({ userId, retried: true }),
        'EX',
        300,
      );

      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        if (input.toString() === 'https://oauth2.googleapis.com/token') {
          return new Response(
            JSON.stringify({
              access_token: 'mock-access-token',
              scope: 'https://www.googleapis.com/auth/drive.file',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`Unhandled fetch to ${input}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await app.inject({
        method: 'GET',
        url: `/v1/integrations/google-drive/callback?code=code-still-no-refresh&state=${state}`,
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('drive_error=no_refresh_token');
    });
  });

  describe('GET /v1/integrations/google-drive/status', () => {
    it('returns NOT_CONNECTED when no row exists', async () => {
      const { token } = await createVerifiedUserToken(app, 'gdrive-status-none@example.com');
      const res = await app.inject({
        method: 'GET',
        url: '/v1/integrations/google-drive/status',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'NOT_CONNECTED', googleEmail: null });
    });

    it('returns CONNECTED when active connection row exists', async () => {
      const { token, userId } = await createVerifiedUserToken(
        app,
        'gdrive-status-conn@example.com',
      );
      await app.db.insert(schema.googleDriveConnections).values({
        userId,
        googleEmail: 'connected@gmail.com',
        refreshTokenEnc: encryptToken('fake-refresh-tok', TEST_ENC_KEY),
        scope: 'https://www.googleapis.com/auth/drive.file',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/integrations/google-drive/status',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'CONNECTED', googleEmail: 'connected@gmail.com' });
    });

    it('returns REAUTH_REQUIRED when revokedAt is set', async () => {
      const { token, userId } = await createVerifiedUserToken(
        app,
        'gdrive-status-reauth@example.com',
      );
      await app.db.insert(schema.googleDriveConnections).values({
        userId,
        googleEmail: 'reauth@gmail.com',
        refreshTokenEnc: null,
        scope: 'https://www.googleapis.com/auth/drive.file',
        revokedAt: new Date(),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/integrations/google-drive/status',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'REAUTH_REQUIRED', googleEmail: 'reauth@gmail.com' });
    });
  });

  describe('POST /v1/jobs/:id/export/google-drive', () => {
    async function createJobWithOutput(
      userId: string,
      imageBuffer: Buffer = Buffer.from('fake-image-bytes'),
    ) {
      const [job] = await app.db
        .insert(schema.jobs)
        .values({
          userId,
          status: 'COMPLETED',
          type: 'single',
          creditsDeducted: 25,
        })
        .returning();

      const resultKey = `results/${job.id}/image.jpg`;
      await app.storage.putObject(resultKey, imageBuffer, 'image/jpeg');

      await app.db.insert(schema.jobOutputs).values({
        jobId: job.id,
        resultKey,
      });

      return job;
    }

    it('returns 409 GOOGLE_DRIVE_NOT_CONNECTED when user has no drive connection', async () => {
      const { token, userId } = await createVerifiedUserToken(app, 'gdrive-no-conn@example.com');
      const job = await createJobWithOutput(userId);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${job.id}/export/google-drive`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('GOOGLE_DRIVE_NOT_CONNECTED');
    });

    it('returns 404 for a job belonging to a different user', async () => {
      const { token } = await createVerifiedUserToken(app, 'gdrive-user-a@example.com');
      const { userId: userBId } = await createVerifiedUserToken(app, 'gdrive-user-b@example.com');
      const jobB = await createJobWithOutput(userBId);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${jobB.id}/export/google-drive`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    });

    it('happy path: exports result to Google Drive and returns file metadata', async () => {
      const { token, userId } = await createVerifiedUserToken(app, 'gdrive-happy@example.com');
      const job = await createJobWithOutput(userId, Buffer.from('test-image-data-for-drive'));

      await app.db.insert(schema.googleDriveConnections).values({
        userId,
        googleEmail: 'happy@gmail.com',
        refreshTokenEnc: encryptToken('test-refresh-token', TEST_ENC_KEY),
        scope: 'https://www.googleapis.com/auth/drive.file',
      });

      const fetchCalls: Array<{ url: string; method?: string }> = [];
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = input.toString();
        fetchCalls.push({ url: urlStr, method: init?.method ?? 'GET' });

        if (urlStr === 'https://oauth2.googleapis.com/token') {
          return new Response(JSON.stringify({ access_token: 'fresh-drive-access-token' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (
          urlStr.startsWith('https://www.googleapis.com/drive/v3/files') &&
          init?.method !== 'POST'
        ) {
          // find folder
          return new Response(JSON.stringify({ files: [{ id: 'existing-folder-id' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (urlStr.startsWith('https://www.googleapis.com/upload/drive/v3/files')) {
          // upload multipart
          return new Response(
            JSON.stringify({
              id: 'uploaded-drive-file-id-456',
              webViewLink: 'https://drive.google.com/file/d/uploaded-drive-file-id-456/view',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${job.id}/export/google-drive`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        driveFileId: 'uploaded-drive-file-id-456',
        webViewLink: 'https://drive.google.com/file/d/uploaded-drive-file-id-456/view',
      });

      // Verify token refresh was called with proper credentials
      expect(fetchCalls.some((c) => c.url === 'https://oauth2.googleapis.com/token')).toBe(true);
      expect(fetchCalls.some((c) => c.url.includes('/upload/drive/v3/files'))).toBe(true);
    });

    it('creates AI Vastra folder if absent during export', async () => {
      const { token, userId } = await createVerifiedUserToken(app, 'gdrive-newfolder@example.com');
      const job = await createJobWithOutput(userId);

      await app.db.insert(schema.googleDriveConnections).values({
        userId,
        googleEmail: 'newfolder@gmail.com',
        refreshTokenEnc: encryptToken('test-refresh-token', TEST_ENC_KEY),
        scope: 'https://www.googleapis.com/auth/drive.file',
      });

      let folderCreated = false;
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = input.toString();
        if (urlStr === 'https://oauth2.googleapis.com/token') {
          return new Response(JSON.stringify({ access_token: 'fresh-drive-access-token' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (urlStr.startsWith('https://www.googleapis.com/drive/v3/files')) {
          if (init?.method === 'POST') {
            folderCreated = true;
            return new Response(JSON.stringify({ id: 'brand-new-folder-id' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          // list returns empty
          return new Response(JSON.stringify({ files: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (urlStr.startsWith('https://www.googleapis.com/upload/drive/v3/files')) {
          return new Response(
            JSON.stringify({
              id: 'file-in-new-folder',
              webViewLink: 'https://drive.google.com/file/d/file-in-new-folder/view',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${job.id}/export/google-drive`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(folderCreated).toBe(true);
    });

    it('maps dead refresh token (invalid_grant) to 403 GOOGLE_DRIVE_REAUTH_REQUIRED and marks row revoked', async () => {
      const { token, userId } = await createVerifiedUserToken(
        app,
        'gdrive-invalid-grant@example.com',
      );
      const job = await createJobWithOutput(userId);

      await app.db.insert(schema.googleDriveConnections).values({
        userId,
        googleEmail: 'invalid-grant@gmail.com',
        refreshTokenEnc: encryptToken('expired-refresh-token', TEST_ENC_KEY),
        scope: 'https://www.googleapis.com/auth/drive.file',
      });

      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const urlStr = input.toString();
        if (urlStr === 'https://oauth2.googleapis.com/token') {
          return new Response(JSON.stringify({ error: 'invalid_grant' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await app.inject({
        method: 'POST',
        url: `/v1/jobs/${job.id}/export/google-drive`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('GOOGLE_DRIVE_REAUTH_REQUIRED');

      const [conn] = await app.db
        .select()
        .from(schema.googleDriveConnections)
        .where(eq(schema.googleDriveConnections.userId, userId));
      expect(conn.refreshTokenEnc).toBeNull();
      expect(conn.revokedAt).toBeInstanceOf(Date);
    });
  });

  describe('POST /v1/integrations/google-drive/disconnect', () => {
    it('calls Google revoke endpoint, clears refreshTokenEnc and sets revokedAt', async () => {
      const { token, userId } = await createVerifiedUserToken(app, 'gdrive-disconnect@example.com');
      await app.db.insert(schema.googleDriveConnections).values({
        userId,
        googleEmail: 'disconnect@gmail.com',
        refreshTokenEnc: encryptToken('valid-refresh-tok', TEST_ENC_KEY),
        scope: 'https://www.googleapis.com/auth/drive.file',
      });

      let revokeCalledWithToken = '';
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = input.toString();
        if (urlStr === 'https://oauth2.googleapis.com/revoke') {
          const body = init?.body?.toString() ?? '';
          const params = new URLSearchParams(body);
          revokeCalledWithToken = params.get('token') ?? '';
          return new Response('', { status: 200 });
        }
        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/integrations/google-drive/disconnect',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(revokeCalledWithToken).toBe('valid-refresh-tok');

      const [conn] = await app.db
        .select()
        .from(schema.googleDriveConnections)
        .where(eq(schema.googleDriveConnections.userId, userId));
      expect(conn.refreshTokenEnc).toBeNull();
      expect(conn.revokedAt).toBeInstanceOf(Date);
    });

    it('succeeds even if Google revoke endpoint fails (best-effort)', async () => {
      const { token, userId } = await createVerifiedUserToken(
        app,
        'gdrive-disconnect-err@example.com',
      );
      await app.db.insert(schema.googleDriveConnections).values({
        userId,
        googleEmail: 'disconnect-err@gmail.com',
        refreshTokenEnc: encryptToken('tok-that-fails-revoke', TEST_ENC_KEY),
        scope: 'https://www.googleapis.com/auth/drive.file',
      });

      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const urlStr = input.toString();
        if (urlStr === 'https://oauth2.googleapis.com/revoke') {
          return new Response('internal error', { status: 500 });
        }
        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/integrations/google-drive/disconnect',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });

      const [conn] = await app.db
        .select()
        .from(schema.googleDriveConnections)
        .where(eq(schema.googleDriveConnections.userId, userId));
      expect(conn.refreshTokenEnc).toBeNull();
      expect(conn.revokedAt).toBeInstanceOf(Date);
    });
  });

  describe('User erasure (eraseUser hook)', () => {
    it('revokes Google Drive grant when user is deleted by admin', async () => {
      const { token: adminToken, userId: adminId } = await createVerifiedUserToken(
        app,
        'superadmin-gdrive@example.com',
      );
      await app.db.insert(schema.adminUsers).values({ userId: adminId, role: 'SUPER_ADMIN' });

      const { userId: targetUserId } = await createVerifiedUserToken(
        app,
        'target-to-erase@example.com',
      );
      await app.db.insert(schema.googleDriveConnections).values({
        userId: targetUserId,
        googleEmail: 'target-to-erase@gmail.com',
        refreshTokenEnc: encryptToken('target-refresh-tok', TEST_ENC_KEY),
        scope: 'https://www.googleapis.com/auth/drive.file',
      });

      let revokeCalled = false;
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = input.toString();
        if (urlStr === 'https://oauth2.googleapis.com/revoke') {
          revokeCalled = true;
          return new Response('', { status: 200 });
        }
        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const res = await app.inject({
        method: 'DELETE',
        url: `/admin/users/${targetUserId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(revokeCalled).toBe(true);

      const [conn] = await app.db
        .select()
        .from(schema.googleDriveConnections)
        .where(eq(schema.googleDriveConnections.userId, targetUserId));
      expect(conn.refreshTokenEnc).toBeNull();
      expect(conn.revokedAt).toBeInstanceOf(Date);
    });
  });
});

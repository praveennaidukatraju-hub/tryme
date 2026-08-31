import { randomBytes } from 'node:crypto';
import type { GoogleDriveExportResponse, GoogleDriveStatusResponse } from '@tryme/types';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildAuthUrl, exchangeCode, fetchGoogleEmail } from './oauth.js';
import { exportResultToDrive } from './service.js';
import { disconnect, getConnection, saveConnection } from './token.js';

export async function googleDriveRoutes(app: FastifyInstance) {
  if (!app.env.GOOGLE_CLIENT_ID || !app.env.GOOGLE_CLIENT_SECRET) {
    app.log.warn('Google OAuth not configured — /v1/integrations/google-drive/* routes disabled');
    return;
  }
  const clientId = app.env.GOOGLE_CLIENT_ID;
  const clientSecret = app.env.GOOGLE_CLIENT_SECRET;
  const baseUrl = app.env.GOOGLE_CALLBACK_URL || app.env.WEB_URL || 'http://localhost:3000';
  const redirectUri = new URL('/v1/integrations/google-drive/callback', baseUrl).toString();

  app.get(
    '/v1/integrations/google-drive/connect',
    { preHandler: app.requireUser },
    async (req, reply) => {
      const { forceConsent: forceConsentParam } = req.query as { forceConsent?: string };
      const state = randomBytes(32).toString('base64url');
      const row = await getConnection(app, req.userId);
      // Google only reissues a refresh token on prompt=consent once a (user,
      // client_id) pair already has a prior grant of any kind — a plain
      // repeat authorization silently omits it. forceConsentParam is set by
      // the callback below on that exact recoverable case (one retry only,
      // tracked via `retried` on the state value so it can't loop).
      const forceConsent = Boolean(row?.revokedAt) || forceConsentParam === '1';
      await app.redis.set(
        `gdrive:oauth:state:${state}`,
        JSON.stringify({ userId: req.userId, retried: forceConsentParam === '1' }),
        'EX',
        300,
      );
      return reply.redirect(buildAuthUrl(clientId, redirectUri, state, forceConsent), 302);
    },
  );

  app.get('/v1/integrations/google-drive/callback', async (req, reply) => {
    const webUrl = app.env.WEB_URL || 'http://localhost:3000';
    const { code, state } = req.query as { code?: string; state?: string };
    const failRedirect = (reason: string) => {
      const url = new URL('/studio', webUrl);
      url.searchParams.set('drive_error', reason);
      return reply.redirect(url.toString(), 302);
    };
    // Retries through the Next.js BFF connect route (not the API route
    // directly) so the browser re-authenticates via the refresh cookie —
    // this callback has no bearer token of its own to call /connect with.
    const retryWithConsent = () => {
      const url = new URL('/api/integrations/google-drive/connect', webUrl);
      url.searchParams.set('forceConsent', '1');
      return reply.redirect(url.toString(), 302);
    };
    if (!code || !state) return failRedirect('invalid_request');

    const raw = await app.redis.getdel(`gdrive:oauth:state:${state}`);
    if (!raw) return failRedirect('invalid_state');
    const { userId, retried } = JSON.parse(raw) as { userId: string; retried: boolean };

    try {
      const { refreshToken, scope, accessToken } = await exchangeCode(
        clientId,
        clientSecret,
        redirectUri,
        code,
      );
      if (!refreshToken) return retried ? failRedirect('no_refresh_token') : retryWithConsent();
      const email = await fetchGoogleEmail(accessToken);
      await saveConnection(app, userId, email, refreshToken, scope);
    } catch (err) {
      app.log.error({ err }, 'drive connect callback failed');
      return failRedirect('exchange_failed');
    }

    const url = new URL('/studio', webUrl);
    url.searchParams.set('drive_connected', '1');
    return reply.redirect(url.toString(), 302);
  });

  app.get(
    '/v1/integrations/google-drive/status',
    { preHandler: app.requireUser },
    async (req): Promise<GoogleDriveStatusResponse> => {
      const row = await getConnection(app, req.userId);
      if (!row || !row.refreshTokenEnc) {
        return {
          status: row?.revokedAt ? 'REAUTH_REQUIRED' : 'NOT_CONNECTED',
          googleEmail: row?.googleEmail ?? null,
        };
      }
      return { status: 'CONNECTED', googleEmail: row.googleEmail };
    },
  );

  app.post(
    '/v1/integrations/google-drive/disconnect',
    { preHandler: app.requireUser },
    async (req) => {
      await disconnect(app, req.userId);
      return { ok: true };
    },
  );

  app.post(
    '/v1/jobs/:id/export/google-drive',
    { preHandler: app.requireUser, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req): Promise<GoogleDriveExportResponse> => {
      const { id } = req.params as { id: string };
      return exportResultToDrive(app, req.userId, id);
    },
  );
}

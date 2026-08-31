import { randomBytes, randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { Gstin, LoginBody, RegisterBody, WebLoginBody } from '@tryme/types';
import { and, desc, eq, exists, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isCatalogVideoAllowed } from '../../lib/catalog-video-access.js';
import { AppError } from '../../lib/errors.js';
import {
  sendPasswordResetEmail,
  sendVerificationEmail,
  sendWelcomeEmail,
} from '../../lib/mailer.js';
import { resolveMerchantStatus } from '../merchant/status.js';
import { resolveCampaignId } from './campaign.js';
import { parseAcceptedAudiences, verifyGoogleIdToken } from './google-id-token.js';
import { resolveFreeCredits, upsertGoogleUser } from './google-upsert.js';
import {
  hashPassword,
  hashRefresh,
  newRefreshToken,
  signAccess,
  verifyPassword,
} from './service.js';
import { createSessionTokens, parseDuration } from './tokens.js';

const DeviceLoginBody = LoginBody.extend({
  deviceId: z.string().min(1).max(200),
  deviceName: z.string().max(120).optional(),
  platform: z.enum(['mobile', 'kiosk']).default('mobile'),
});

const ForceDeviceLoginBody = z.object({
  forceLogoutToken: z.string().min(1),
  deviceId: z.string().min(1).max(200),
  deviceName: z.string().max(120).optional(),
  platform: z.enum(['mobile', 'kiosk']).default('mobile'),
});

const DeviceRefreshBody = z.object({
  refreshToken: z.string().min(1),
  platform: z.enum(['mobile', 'kiosk']).default('mobile'),
});

const CatalogAppCodeExchangeBody = z.object({
  code: z.string().min(20).max(64),
});

/** Handoff-code lifetime for the WebView code-exchange SSO entry point — long
 * enough to cover the app-to-WebView navigation, short enough that a leaked
 * code (WebView history, a proxy log) is worthless within a minute. */
const CATALOG_APP_CODE_TTL_SEC = 60;

const DeviceLogoutBody = z.object({ refreshToken: z.string().min(1) });

const DeviceGoogleLoginBody = z.object({
  // The `id_token` from Android Credential Manager's GetGoogleIdOption, NOT an
  // OAuth access token — this route verifies it against Google's JWKS itself.
  idToken: z.string().min(1).max(4096),
  deviceId: z.string().min(1).max(200),
  deviceName: z.string().max(120).optional(),
  platform: z.enum(['mobile', 'kiosk']).default('mobile'),
});
const DEVICE_SESSION_PORTALS = ['mobile', 'kiosk'] as const;
const FORCE_LOGOUT_TTL_SECONDS = 5 * 60;

type RefreshOwnerType = 'user' | 'merchant';

type RefreshOwner = {
  ownerType: RefreshOwnerType;
  ownerId: string;
};

type RotationResult =
  | { kind: 'invalid' }
  | ({ kind: 'reissue' } & RefreshOwner)
  | ({
      kind: 'rotated';
      refreshPlain: string;
      expiresAt: Date;
    } & RefreshOwner);

function refreshOwner(row: {
  userId: string | null;
  merchantId: string | null;
}): RefreshOwner | null {
  if (row.userId) return { ownerType: 'user', ownerId: row.userId };
  if (row.merchantId) return { ownerType: 'merchant', ownerId: row.merchantId };
  return null;
}

function refreshOwnerInsert(owner: RefreshOwner) {
  if (owner.ownerType === 'user') return { userId: owner.ownerId };
  return { merchantId: owner.ownerId };
}

export async function rotateTokenFamily(
  app: FastifyInstance,
  plain: string,
  portal: string,
  refreshExpiry = app.env.REFRESH_TOKEN_EXPIRY,
): Promise<RotationResult> {
  const tokenHash = hashRefresh(plain);

  return app.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.refreshTokens)
      .where(eq(schema.refreshTokens.tokenHash, tokenHash))
      .for('update');

    if (!row || row.expiresAt < new Date() || row.revokedAt) return { kind: 'invalid' } as const;
    if (row.portal !== portal) return { kind: 'invalid' } as const;
    const owner = refreshOwner(row);
    if (!owner) return { kind: 'invalid' } as const;

    if (row.usedAt) {
      const ageMs = Date.now() - row.usedAt.getTime();
      const [successor] = await tx
        .select({
          userId: schema.refreshTokens.userId,
          merchantId: schema.refreshTokens.merchantId,
        })
        .from(schema.refreshTokens)
        .where(
          and(
            eq(schema.refreshTokens.familyId, row.familyId),
            isNull(schema.refreshTokens.usedAt),
            isNull(schema.refreshTokens.revokedAt),
          ),
        )
        .orderBy(desc(schema.refreshTokens.generation))
        .limit(1);
      const successorOwner = successor ? refreshOwner(successor) : null;
      if (successorOwner) {
        app.log.info(
          { familyId: row.familyId, generation: row.generation, ageMs },
          'concurrent refresh: reissuing from active successor',
        );
        return { kind: 'reissue', ...successorOwner } as const;
      }
      app.log.warn(
        { familyId: row.familyId, generation: row.generation, ageMs },
        'stale refresh token with no active successor — possible replay attack',
      );
      return { kind: 'invalid' } as const;
    }

    // First use: rotate
    await tx
      .update(schema.refreshTokens)
      .set({ usedAt: new Date() })
      .where(eq(schema.refreshTokens.id, row.id));

    const r = newRefreshToken();
    const expiresAt = new Date(Date.now() + parseDuration(refreshExpiry));
    await tx.insert(schema.refreshTokens).values({
      ...refreshOwnerInsert(owner),
      familyId: row.familyId,
      generation: row.generation + 1,
      tokenHash: r.hash,
      expiresAt,
      portal,
      deviceId: row.deviceId,
      deviceName: row.deviceName,
    });

    return {
      kind: 'rotated',
      ...owner,
      refreshPlain: r.plain,
      expiresAt,
    } as const;
  });
}
function makeToken(): string {
  return randomBytes(32).toString('hex');
}

function publicDeviceSession(row: {
  familyId: string;
  portal: string;
  deviceId: string | null;
  deviceName: string | null;
  createdAt: Date;
  expiresAt: Date;
}) {
  return {
    id: row.familyId,
    platform: row.portal,
    deviceId: row.deviceId,
    deviceName: row.deviceName,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

async function createForceLogoutToken(
  app: FastifyInstance,
  input: { userId: string; deviceId: string; deviceName?: string; platform: 'mobile' | 'kiosk' },
) {
  const token = makeToken();
  await app.redis.set(
    `auth:force-device-login:${token}`,
    JSON.stringify(input),
    'EX',
    FORCE_LOGOUT_TTL_SECONDS,
  );
  return token;
}

// The Android app (kiosk + merchant staff mobile login -- same app, same login,
// no separate kiosk backend) shows this in place of its bundled default logo.
// null means "no merchant logo configured, use your bundled default" -- see
// docs/superpowers/specs/2026-07-27-merchant-logo-android-login-design.md.
async function resolveMerchantLogoUrl(
  app: FastifyInstance,
  userId: string,
): Promise<string | null> {
  const [row] = await app.db
    .select({ logoKey: schema.merchants.logoKey })
    .from(schema.merchants)
    .where(eq(schema.merchants.userId, userId));
  return row?.logoKey ? (await app.storage.presignGet(row.logoKey, 3600)).url : null;
}

async function issueDeviceSession(
  app: FastifyInstance,
  input: { userId: string; deviceId: string; deviceName?: string; platform: 'mobile' | 'kiosk' },
) {
  const secret = new TextEncoder().encode(app.env.JWT_SECRET);
  const accessToken = await signAccess(
    secret,
    input.userId,
    { kind: 'access' },
    app.env.JWT_EXPIRY,
    'device',
  );
  const r = newRefreshToken();
  const expiresAt = new Date(Date.now() + parseDuration(app.env.REFRESH_TOKEN_EXPIRY));
  await app.db.insert(schema.refreshTokens).values({
    userId: input.userId,
    familyId: randomUUID(),
    generation: 1,
    tokenHash: r.hash,
    expiresAt,
    portal: input.platform,
    deviceId: input.deviceId,
    deviceName: input.deviceName ?? null,
  });
  return { accessToken, refreshToken: r.plain };
}

// A user logs in with either their email or their username (username is only
// ever set on admin-created accounts -- see POST /admin/users). Usernames are
// stored lowercase and restricted to [a-z0-9_.] (enforced by the DB CHECK
// constraint and CreateUserBody's regex) so they can never contain '@' -- that
// guarantee is what makes this single OR-lookup unambiguous: a value typed at
// login can match at most one of the two columns, never both/either-of-two-rows.
async function findUserByIdentifier(app: FastifyInstance, identifier: string) {
  const [user] = await app.db
    .select()
    .from(schema.users)
    .where(
      or(eq(schema.users.email, identifier), eq(schema.users.username, identifier.toLowerCase())),
    );
  return user ?? null;
}

async function authenticateDeviceUser(
  app: FastifyInstance,
  dummyHash: string,
  identifier: string,
  password: string,
) {
  const user = await findUserByIdentifier(app, identifier);
  if (!user || user.isBanned) {
    await verifyPassword(dummyHash, password); // constant-time: prevent user enumeration via timing
    throw new AppError('INVALID', 401, 'invalid credentials');
  }
  if (!user.passwordHash) throw new AppError('INVALID', 401, 'invalid credentials');
  if (!(await verifyPassword(user.passwordHash, password))) {
    throw new AppError('INVALID', 401, 'invalid credentials');
  }
  // Only accounts that actually have an email need it verified. Admin-created
  // username-only accounts are created with emailVerified=true regardless (see
  // POST /admin/users) so this branch is defensive, not the primary gate.
  if (user.email && !user.emailVerified) {
    throw new AppError('EMAIL_NOT_VERIFIED', 403, 'email not verified');
  }
  return user;
}

async function activeDeviceSessions(app: FastifyInstance, userId: string) {
  const now = new Date();
  return app.db
    .select({
      familyId: schema.refreshTokens.familyId,
      portal: schema.refreshTokens.portal,
      deviceId: schema.refreshTokens.deviceId,
      deviceName: schema.refreshTokens.deviceName,
      createdAt: schema.refreshTokens.createdAt,
      expiresAt: schema.refreshTokens.expiresAt,
    })
    .from(schema.refreshTokens)
    .where(
      and(
        eq(schema.refreshTokens.userId, userId),
        inArray(schema.refreshTokens.portal, [...DEVICE_SESSION_PORTALS]),
        isNull(schema.refreshTokens.usedAt),
        isNull(schema.refreshTokens.revokedAt),
        gt(schema.refreshTokens.expiresAt, now),
      ),
    );
}

function deviceLoginUserPayload(user: {
  id: string;
  email: string | null;
  displayName: string | null;
  tier: string;
  maxActiveDevices: number;
}) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    tier: user.tier,
    maxActiveDevices: user.maxActiveDevices,
  };
}
export async function authRoutes(app: FastifyInstance) {
  // Pre-computed hash used on the not-found login path to prevent timing-based user enumeration
  const dummyHash = await hashPassword('__timing_dummy__');

  app.post(
    '/v1/auth/register',
    { schema: { body: RegisterBody }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { email, password, displayName, signupSource } = req.body as z.infer<
        typeof RegisterBody
      >;
      const exists = await app.db.select().from(schema.users).where(eq(schema.users.email, email));
      if (exists.length) throw new AppError('EMAIL_TAKEN', 409, 'email already registered');
      const passwordHash = await hashPassword(password);
      const user = await app.db.transaction(async (tx) => {
        const signupCampaignId = await resolveCampaignId(tx, signupSource);
        const [createdUser] = await tx
          .insert(schema.users)
          .values({
            email,
            passwordHash,
            displayName,
            companyName: null,
            tier: 'free',
            signupCampaignId,
          })
          .returning();
        await tx.insert(schema.userCredits).values({ userId: createdUser.id, balance: 0 });
        return createdUser;
      });

      // Send verification email
      const token = makeToken();
      await app.redis.set(`email:verify:${token}`, user.id, 'EX', 86400);
      try {
        await sendVerificationEmail(
          app.env.RESEND_API_KEY,
          app.env.EMAIL_FROM,
          app.env.WEB_URL,
          email,
          token,
        );
      } catch (err) {
        app.log.error({ err }, 'Failed to send verification email');
      }

      reply.code(201);
      return { requiresEmailVerification: true };
    },
  );

  app.post(
    '/v1/auth/login',
    {
      schema: { body: WebLoginBody },
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      // Field is named `email` on the wire (see LoginBody) but may hold a
      // username for admin-created accounts -- see findUserByIdentifier.
      const { email: identifier, password, portal } = req.body as z.infer<typeof WebLoginBody>;
      const user = await findUserByIdentifier(app, identifier);
      if (!user || user.isBanned) {
        await verifyPassword(dummyHash, password); // constant-time: prevent user enumeration via timing
        throw new AppError('INVALID', 401, 'invalid credentials');
      }
      if (!user.passwordHash) throw new AppError('INVALID', 401, 'invalid credentials');
      if (!(await verifyPassword(user.passwordHash, password)))
        throw new AppError('INVALID', 401, 'invalid credentials');
      if (user.email && !user.emailVerified) {
        throw new AppError('EMAIL_NOT_VERIFIED', 403, 'email not verified');
      }
      if (portal === 'catalog-app') {
        const [merchantRow] = await app.db
          .select({ isActive: schema.merchants.isActive })
          .from(schema.merchants)
          .where(eq(schema.merchants.userId, user.id));
        if (!merchantRow?.isActive) {
          throw new AppError('NOT_A_MERCHANT', 403, 'This account has no Try On Library access.');
        }
        return createSessionTokens(app, user.id, reply, 200, 'catalog-app');
      }
      const [adminRow] = await app.db
        .select({ role: schema.adminUsers.role, status: schema.adminUsers.status })
        .from(schema.adminUsers)
        .where(eq(schema.adminUsers.userId, user.id));
      if (adminRow?.status === 'active' && adminRow.role === 'SUPER_ADMIN') {
        throw new AppError('FORBIDDEN', 403, 'Super admin accounts must use the admin panel.');
      }
      return createSessionTokens(app, user.id, reply, 200);
    },
  );

  app.post('/v1/auth/refresh', async (req, reply) => {
    const plain = req.cookies.refresh;
    if (!plain) throw new AppError('NO_REFRESH', 401, 'no refresh token');
    const tokenHash = hashRefresh(plain);

    const result = await app.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.refreshTokens)
        .where(eq(schema.refreshTokens.tokenHash, tokenHash))
        .for('update');

      if (!row || row.expiresAt < new Date() || row.revokedAt) return { kind: 'invalid' } as const;
      if (row.portal !== 'web') return { kind: 'invalid' } as const;
      if (!row.userId) return { kind: 'invalid' } as const;

      if (row.usedAt) {
        const ageMs = Date.now() - row.usedAt.getTime();
        const [successor] = await tx
          .select({ userId: schema.refreshTokens.userId })
          .from(schema.refreshTokens)
          .where(
            and(
              eq(schema.refreshTokens.familyId, row.familyId),
              isNull(schema.refreshTokens.usedAt),
              isNull(schema.refreshTokens.revokedAt),
            ),
          )
          .orderBy(desc(schema.refreshTokens.generation))
          .limit(1);
        if (successor?.userId) {
          app.log.info(
            { familyId: row.familyId, generation: row.generation, ageMs },
            'concurrent refresh: reissuing from active successor',
          );
          return { kind: 'reissue', userId: successor.userId } as const;
        }
        // Reuse of an already-rotated token with NO active successor signals
        // theft (the legitimate chain would have left a live successor). Revoke
        // the entire family so a stolen token can't keep the session alive —
        // forces re-login. (The successor branch above is the benign concurrent-
        // refresh race and is intentionally not revoked.)
        await tx
          .update(schema.refreshTokens)
          .set({ revokedAt: new Date() })
          .where(eq(schema.refreshTokens.familyId, row.familyId));
        app.log.warn(
          { familyId: row.familyId, generation: row.generation, ageMs },
          'stale refresh token reuse — revoking family (possible theft)',
        );
        return { kind: 'invalid' } as const;
      }

      await tx
        .update(schema.refreshTokens)
        .set({ usedAt: new Date() })
        .where(eq(schema.refreshTokens.id, row.id));

      const r = newRefreshToken();
      const expiresAt = new Date(Date.now() + parseDuration(app.env.REFRESH_TOKEN_EXPIRY));
      await tx.insert(schema.refreshTokens).values({
        userId: row.userId,
        familyId: row.familyId,
        generation: row.generation + 1,
        tokenHash: r.hash,
        expiresAt,
        portal: 'web',
      });

      return {
        kind: 'rotated',
        userId: row.userId,
        refreshPlain: r.plain,
        expiresAt,
      } as const;
    });
    const secret = new TextEncoder().encode(app.env.JWT_SECRET);

    if (result.kind === 'invalid') {
      throw new AppError('INVALID_REFRESH', 401, 'refresh invalid');
    }

    if (result.kind === 'reissue') {
      app.log.info(
        { event: 'REFRESH_TOKEN_REISSUE', userId: result.userId },
        'Concurrent refresh reissued',
      );
      return {
        accessToken: await signAccess(
          secret,
          result.userId,
          { kind: 'access' },
          app.env.JWT_EXPIRY,
        ),
      };
    }

    // rotated
    reply.setCookie('refresh', result.refreshPlain, {
      httpOnly: true,
      secure: app.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/v1/auth',
      expires: result.expiresAt,
      signed: false,
    });
    reply.code(200);
    return {
      accessToken: await signAccess(secret, result.userId, { kind: 'access' }, app.env.JWT_EXPIRY),
    };
  });

  app.get('/v1/me', { preHandler: app.requireUser }, async (req) => {
    const [user] = await app.db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        displayName: schema.users.displayName,
        phone: schema.users.phone,
        username: schema.users.username,
        companyName: schema.users.companyName,
        gstin: schema.users.gstin,
        tier: schema.users.tier,
        passwordHash: schema.users.passwordHash,
        defaultResolution: schema.users.defaultResolution,
        defaultAspectRatio: schema.users.defaultAspectRatio,
        defaultPlatform: schema.users.defaultPlatform,
      })
      .from(schema.users)
      .where(eq(schema.users.id, req.userId));
    if (!user) throw new AppError('NOT_FOUND', 404, 'user not found');
    const { passwordHash, ...rest } = user;

    const [{ hasShopifyStore, isMerchant }] = await app.db
      .select({
        hasShopifyStore: exists(
          app.db
            .select()
            .from(schema.shopifyStores)
            .where(
              and(
                eq(schema.shopifyStores.ownerUserId, req.userId),
                isNull(schema.shopifyStores.uninstalledAt),
              ),
            ),
        ),
        isMerchant: exists(
          app.db
            .select()
            .from(schema.merchants)
            .where(
              and(eq(schema.merchants.userId, req.userId), eq(schema.merchants.isActive, true)),
            ),
        ),
      })
      .from(schema.users)
      .where(eq(schema.users.id, req.userId))
      .limit(1);

    return {
      ...rest,
      hasPassword: passwordHash !== null,
      hasShopifyStore,
      isMerchant,
      catalogVideoEnabled: isCatalogVideoAllowed(app.env, rest.email),
    };
  });

  app.patch(
    '/v1/me',
    {
      preHandler: app.requireUser,
      schema: {
        body: z.object({
          displayName: z.string().min(1).max(60).optional(),
          email: z.string().email().max(254).optional(),
          phone: z
            .string()
            .regex(/^\d{10}$/, 'phone must be a 10-digit number')
            .nullable()
            .optional(),
          companyName: z.string().max(160).nullable().optional(),
          gstin: Gstin,
          defaultResolution: z.enum(['HD', '2K', '4K']).optional(),
          defaultAspectRatio: z.enum(['1:1', '2:3', '3:4', '4:5']).optional(),
          defaultPlatform: z.string().max(60).optional(),
        }),
      },
    },
    async (req) => {
      const {
        displayName,
        email,
        phone,
        companyName,
        gstin,
        defaultResolution,
        defaultAspectRatio,
        defaultPlatform,
      } = req.body as {
        displayName?: string;
        email?: string;
        phone?: string | null;
        companyName?: string | null;
        gstin?: string;
        defaultResolution?: string;
        defaultAspectRatio?: string;
        defaultPlatform?: string;
      };
      return app.db.transaction(async (tx) => {
        if (phone) {
          const [conflict] = await tx
            .select({ email: schema.users.email })
            .from(schema.users)
            .where(and(eq(schema.users.phone, phone), sql`${schema.users.id} <> ${req.userId}`))
            .limit(1);
          if (conflict) {
            throw new AppError(
              'PHONE_TAKEN',
              409,
              'This mobile number is already assigned to another email address. Use a different number.',
            );
          }
        }

        if (email) {
          const [conflict] = await tx
            .select({ id: schema.users.id })
            .from(schema.users)
            .where(and(eq(schema.users.email, email), sql`${schema.users.id} <> ${req.userId}`))
            .limit(1);
          if (conflict) {
            throw new AppError(
              'EMAIL_TAKEN',
              409,
              'This email is already registered to another account.',
            );
          }
        }

        const [updated] = await tx
          .update(schema.users)
          .set({
            ...(displayName !== undefined ? { displayName } : {}),
            ...(email !== undefined ? { email } : {}),
            ...(phone !== undefined ? { phone: phone ?? null } : {}),
            ...(companyName !== undefined ? { companyName: companyName?.trim() || null } : {}),
            ...(gstin !== undefined ? { gstin: gstin.trim().toUpperCase() || null } : {}),
            ...(defaultResolution !== undefined ? { defaultResolution } : {}),
            ...(defaultAspectRatio !== undefined ? { defaultAspectRatio } : {}),
            ...(defaultPlatform !== undefined ? { defaultPlatform } : {}),
          })
          .where(eq(schema.users.id, req.userId))
          .returning({
            id: schema.users.id,
            email: schema.users.email,
            displayName: schema.users.displayName,
            phone: schema.users.phone,
            companyName: schema.users.companyName,
            gstin: schema.users.gstin,
            tier: schema.users.tier,
            defaultResolution: schema.users.defaultResolution,
            defaultAspectRatio: schema.users.defaultAspectRatio,
            defaultPlatform: schema.users.defaultPlatform,
            signupCampaignId: schema.users.signupCampaignId,
          });
        if (!updated) throw new AppError('NOT_FOUND', 404, 'user not found');

        const complete = Boolean(updated.phone && /^\d{10}$/.test(updated.phone) && updated.email);
        if (!complete) return updated;

        const [freePlan] = await tx
          .select({ credits: schema.creditPlans.credits })
          .from(schema.creditPlans)
          .where(and(eq(schema.creditPlans.slug, 'free'), eq(schema.creditPlans.isActive, true)));
        let freeCredits = freePlan?.credits ?? 0;
        if (freeCredits > 0 && updated.signupCampaignId) {
          const [campaign] = await tx
            .select({ bonusPercent: schema.signupCampaigns.bonusPercent })
            .from(schema.signupCampaigns)
            .where(eq(schema.signupCampaigns.id, updated.signupCampaignId));
          if (campaign) {
            freeCredits = Math.round(freeCredits * (1 + campaign.bonusPercent / 100));
          }
        }
        if (freeCredits <= 0) return updated;

        const [inserted] = await tx
          .insert(schema.creditLedger)
          .values({ userId: req.userId, delta: freeCredits, reason: 'FREE_TRIAL' })
          .onConflictDoNothing()
          .returning({ id: schema.creditLedger.id });
        if (inserted) {
          await tx
            .insert(schema.userCredits)
            .values({ userId: req.userId, balance: freeCredits })
            .onConflictDoUpdate({
              target: schema.userCredits.userId,
              set: {
                balance: sql`${schema.userCredits.balance} + ${freeCredits}`,
                updatedAt: new Date(),
              },
            });
        }

        return updated;
      });
    },
  );

  app.post('/v1/auth/logout', async (req) => {
    const plain = req.cookies.refresh ?? req.cookies.catalog_app_refresh;
    if (plain) {
      const tokenHash = hashRefresh(plain);
      const [row] = await app.db
        .select({ familyId: schema.refreshTokens.familyId })
        .from(schema.refreshTokens)
        .where(eq(schema.refreshTokens.tokenHash, tokenHash))
        .limit(1);
      if (row) {
        await app.db
          .update(schema.refreshTokens)
          .set({ revokedAt: new Date() })
          .where(eq(schema.refreshTokens.familyId, row.familyId));
      }
    }
    return { ok: true };
  });

  app.post('/v1/auth/catalog-app-refresh', async (req, reply) => {
    const plain = req.cookies.catalog_app_refresh;
    if (!plain) throw new AppError('NO_REFRESH', 401, 'no refresh token');
    const result = await rotateTokenFamily(app, plain, 'catalog-app');
    if (result.kind === 'invalid' || result.ownerType !== 'user') {
      throw new AppError('INVALID_REFRESH', 401, 'refresh invalid');
    }
    const secret = new TextEncoder().encode(app.env.JWT_SECRET);
    if (result.kind === 'reissue') {
      return {
        accessToken: await signAccess(
          secret,
          result.ownerId,
          { kind: 'access' },
          app.env.JWT_EXPIRY,
          'catalog-app',
        ),
      };
    }
    reply.setCookie('catalog_app_refresh', result.refreshPlain, {
      httpOnly: true,
      secure: app.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/v1/auth',
      expires: result.expiresAt,
      signed: false,
    });
    return {
      accessToken: await signAccess(
        secret,
        result.ownerId,
        { kind: 'access' },
        app.env.JWT_EXPIRY,
        'catalog-app',
      ),
    };
  });

  // Shared by both catalog-app device entry points below. requireDeviceUser only
  // checks the user exists and is email-verified — it does NOT check isBanned
  // (unlike the password-based portal: 'catalog-app' branch of /v1/auth/login,
  // which both routes mirror). Left the shared guard unmodified since
  // /v1/merchant/onboarding also relies on it, so the ban check has to live here.
  async function assertCatalogAppEligible(userId: string): Promise<void> {
    const [userRow] = await app.db
      .select({ isBanned: schema.users.isBanned })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    if (userRow?.isBanned) {
      throw new AppError('BANNED', 403, 'account banned');
    }
    const [merchantRow] = await app.db
      .select({ isActive: schema.merchants.isActive })
      .from(schema.merchants)
      .where(eq(schema.merchants.userId, userId));
    if (!merchantRow?.isActive) {
      throw new AppError('NOT_A_MERCHANT', 403, 'This account has no Try On Library access.');
    }
  }

  // Lets the Android app's WebView (already signed into the native device
  // session) pick up a catalog-app cookie session without showing the Try On
  // Library's own login form. requireDeviceUser proves this is a live
  // 'device'-audience session.
  app.post(
    '/v1/auth/catalog-app-device-exchange',
    {
      preHandler: app.requireDeviceUser,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      await assertCatalogAppEligible(req.userId);
      return createSessionTokens(app, req.userId, reply, 200, 'catalog-app');
    },
  );

  // Second entry point into the same catalog-app session, for WebView wrappers
  // that can't set a custom header on the initial navigation (unlike loadUrl's
  // extraHeaders overload above). The app calls this route directly (bearer
  // device token, never in a URL) to mint a short-lived, single-use handoff
  // code, then opens the WebView at /tryon-library-app?code=<code>. Putting
  // only this code — not the device access token itself — in the URL keeps the
  // blast radius small if it ends up in WebView history or a proxy log: it's
  // worthless after one use or 60 seconds, whichever comes first.
  app.post(
    '/v1/auth/catalog-app-device-code',
    {
      preHandler: app.requireDeviceUser,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (req) => {
      await assertCatalogAppEligible(req.userId);
      const code = randomBytes(24).toString('base64url');
      await app.redis.set(
        `catalog-app-handoff:${code}`,
        req.userId,
        'EX',
        CATALOG_APP_CODE_TTL_SEC,
      );
      return { code, expiresInSeconds: CATALOG_APP_CODE_TTL_SEC };
    },
  );

  // Public by necessity — the code itself is the credential (192 bits of
  // randomness, single-use via GETDEL, 60s TTL), same trust model as e.g. a
  // password-reset token. No re-check of ban/merchant status here: the code's
  // existence already proves assertCatalogAppEligible passed within the last
  // 60 seconds, and every other device-session route in this file trusts a
  // token for its full lifetime the same way.
  app.post(
    '/v1/auth/catalog-app-code-exchange',
    {
      schema: { body: CatalogAppCodeExchangeBody },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const { code } = req.body as z.infer<typeof CatalogAppCodeExchangeBody>;
      const userId = await app.redis.getdel(`catalog-app-handoff:${code}`);
      if (!userId) {
        throw new AppError('INVALID_CODE', 401, 'code invalid, expired, or already used');
      }
      return createSessionTokens(app, userId, reply, 200, 'catalog-app');
    },
  );

  // ── Mobile auth (body-based tokens, no cookies) ──────────────────────────

  app.post(
    '/v1/auth/device-login',
    {
      schema: { body: DeviceLoginBody },
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const { email, password, deviceId, deviceName, platform } = req.body as z.infer<
        typeof DeviceLoginBody
      >;
      const user = await authenticateDeviceUser(app, dummyHash, email, password);
      const sessions = await activeDeviceSessions(app, user.id);
      const otherSessions = sessions.filter((session) => session.deviceId !== deviceId);

      // The saree catalogue Android app ('mobile' portal) has no device cap — a
      // merchant's staff routinely share one account across multiple tablets at
      // once. Only 'kiosk' enforces maxActiveDevices (one active kiosk per account).
      if (platform !== 'mobile' && otherSessions.length >= user.maxActiveDevices) {
        const forceLogoutToken = await createForceLogoutToken(app, {
          userId: user.id,
          deviceId,
          deviceName,
          platform,
        });
        return reply.code(409).send({
          error: {
            code: 'DEVICE_LIMIT_REACHED',
            message: 'This account is already active on another device.',
            forceLogoutToken,
            maxActiveDevices: user.maxActiveDevices,
            activeDevices: otherSessions.map(publicDeviceSession),
          },
        });
      }

      await app.db
        .update(schema.refreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.refreshTokens.userId, user.id),
            inArray(schema.refreshTokens.portal, [...DEVICE_SESSION_PORTALS]),
            eq(schema.refreshTokens.deviceId, deviceId),
            isNull(schema.refreshTokens.revokedAt),
          ),
        );

      const tokens = await issueDeviceSession(app, {
        userId: user.id,
        deviceId,
        deviceName,
        platform,
      });
      const [logoUrl, merchantStatus] = await Promise.all([
        resolveMerchantLogoUrl(app, user.id),
        resolveMerchantStatus(app, user.id),
      ]);
      return { ...tokens, user: deviceLoginUserPayload(user), logoUrl, merchantStatus };
    },
  );

  app.post(
    '/v1/auth/device-login/force',
    {
      schema: { body: ForceDeviceLoginBody },
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req) => {
      const { forceLogoutToken, deviceId, deviceName, platform } = req.body as z.infer<
        typeof ForceDeviceLoginBody
      >;
      const raw = await app.redis.getdel(`auth:force-device-login:${forceLogoutToken}`);
      if (!raw) throw new AppError('INVALID_OR_EXPIRED_TOKEN', 400, 'force logout token expired');
      const claim = JSON.parse(raw) as {
        userId: string;
        deviceId: string;
        deviceName?: string;
        platform: 'mobile' | 'kiosk';
      };
      if (claim.deviceId !== deviceId || claim.platform !== platform) {
        throw new AppError('INVALID_OR_EXPIRED_TOKEN', 400, 'force logout token invalid');
      }

      const [user] = await app.db
        .select({
          id: schema.users.id,
          email: schema.users.email,
          displayName: schema.users.displayName,
          tier: schema.users.tier,
          maxActiveDevices: schema.users.maxActiveDevices,
          isBanned: schema.users.isBanned,
          emailVerified: schema.users.emailVerified,
        })
        .from(schema.users)
        .where(eq(schema.users.id, claim.userId));
      if (!user || user.isBanned || !user.emailVerified) {
        throw new AppError('INVALID_OR_EXPIRED_TOKEN', 400, 'force logout token invalid');
      }

      await app.db
        .update(schema.refreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.refreshTokens.userId, user.id),
            inArray(schema.refreshTokens.portal, [...DEVICE_SESSION_PORTALS]),
            isNull(schema.refreshTokens.revokedAt),
          ),
        );

      const tokens = await issueDeviceSession(app, {
        userId: user.id,
        deviceId,
        deviceName: deviceName ?? claim.deviceName,
        platform,
      });
      const merchantStatus = await resolveMerchantStatus(app, user.id);
      return { ...tokens, user: deviceLoginUserPayload(user), merchantStatus };
    },
  );

  // Native Google sign-in for the Android app. The browser flow in google.routes.ts
  // cannot serve this: it is a 302 redirect chain that ends in cookies on the web
  // origin. Here the client already holds a verified ID token, so there is no
  // code exchange and no state cookie — just verify, upsert, issue a device session.
  app.post(
    '/v1/auth/device-login/google',
    {
      schema: { body: DeviceGoogleLoginBody },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const audiences = parseAcceptedAudiences(
        app.env.GOOGLE_CLIENT_ID,
        app.env.GOOGLE_DEVICE_AUDIENCES,
      );
      const { idToken, deviceId, deviceName, platform } = req.body as z.infer<
        typeof DeviceGoogleLoginBody
      >;
      const identity = await verifyGoogleIdToken(idToken, audiences);

      const freeCredits = await resolveFreeCredits(app.db);
      const { userId, isNewUser } = await app.db.transaction((tx) =>
        upsertGoogleUser(tx, identity, freeCredits),
      );

      if (isNewUser) {
        try {
          await sendWelcomeEmail(app.env.RESEND_API_KEY, app.env.EMAIL_FROM, identity.email);
        } catch (err) {
          app.log.error({ err }, 'Failed to send welcome email');
        }
      }

      const [user] = await app.db
        .select({
          id: schema.users.id,
          email: schema.users.email,
          displayName: schema.users.displayName,
          tier: schema.users.tier,
          maxActiveDevices: schema.users.maxActiveDevices,
        })
        .from(schema.users)
        .where(eq(schema.users.id, userId));
      if (!user) throw new AppError('UNAUTH', 401, 'user not found');

      // Cap logic is deliberately identical to the password route above: kiosk is a
      // single shared terminal per account, mobile is staff sharing one account
      // across tablets.
      const sessions = await activeDeviceSessions(app, user.id);
      const otherSessions = sessions.filter((session) => session.deviceId !== deviceId);
      if (platform !== 'mobile' && otherSessions.length >= user.maxActiveDevices) {
        const forceLogoutToken = await createForceLogoutToken(app, {
          userId: user.id,
          deviceId,
          deviceName,
          platform,
        });
        return reply.code(409).send({
          error: {
            code: 'DEVICE_LIMIT_REACHED',
            message: 'This account is already active on another device.',
            forceLogoutToken,
            maxActiveDevices: user.maxActiveDevices,
            activeDevices: otherSessions.map(publicDeviceSession),
          },
        });
      }

      await app.db
        .update(schema.refreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.refreshTokens.userId, user.id),
            inArray(schema.refreshTokens.portal, [...DEVICE_SESSION_PORTALS]),
            eq(schema.refreshTokens.deviceId, deviceId),
            isNull(schema.refreshTokens.revokedAt),
          ),
        );

      const tokens = await issueDeviceSession(app, {
        userId: user.id,
        deviceId,
        deviceName,
        platform,
      });
      const [logoUrl, merchantStatus] = await Promise.all([
        resolveMerchantLogoUrl(app, user.id),
        resolveMerchantStatus(app, user.id),
      ]);

      return {
        ...tokens,
        user: deviceLoginUserPayload(user),
        logoUrl,
        merchantStatus,
        // Prefill for the onboarding form; omitted once a merchants row exists.
        ...(merchantStatus === 'ONBOARDING_REQUIRED'
          ? {
              onboarding: {
                suggestedContactName: identity.name ?? null,
                suggestedCompanyName: identity.name ?? null,
              },
            }
          : {}),
      };
    },
  );

  app.post(
    '/v1/auth/device-refresh',
    {
      schema: { body: DeviceRefreshBody },
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req) => {
      const { refreshToken, platform } = req.body as z.infer<typeof DeviceRefreshBody>;
      const result = await rotateTokenFamily(app, refreshToken, platform);
      if (result.kind === 'invalid' || result.ownerType !== 'user') {
        throw new AppError('INVALID_REFRESH', 401, 'refresh invalid');
      }
      const secret = new TextEncoder().encode(app.env.JWT_SECRET);
      return {
        accessToken: await signAccess(
          secret,
          result.ownerId,
          { kind: 'access' },
          app.env.JWT_EXPIRY,
          'device',
        ),
        refreshToken: result.kind === 'rotated' ? result.refreshPlain : null,
      };
    },
  );

  app.post(
    '/v1/auth/device-logout',
    {
      schema: { body: DeviceLogoutBody },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req) => {
      const { refreshToken } = req.body as z.infer<typeof DeviceLogoutBody>;
      const tokenHash = hashRefresh(refreshToken);
      const [row] = await app.db
        .select({ familyId: schema.refreshTokens.familyId, portal: schema.refreshTokens.portal })
        .from(schema.refreshTokens)
        .where(eq(schema.refreshTokens.tokenHash, tokenHash))
        .limit(1);
      if (
        row &&
        DEVICE_SESSION_PORTALS.includes(row.portal as (typeof DEVICE_SESSION_PORTALS)[number])
      ) {
        await app.db
          .update(schema.refreshTokens)
          .set({ revokedAt: new Date() })
          .where(eq(schema.refreshTokens.familyId, row.familyId));
      }
      return { ok: true };
    },
  );
  app.post(
    '/v1/auth/login-mobile',
    {
      schema: { body: LoginBody },
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req) => {
      const { email, password } = req.body as z.infer<typeof LoginBody>;
      const [user] = await app.db.select().from(schema.users).where(eq(schema.users.email, email));
      if (!user || user.isBanned) throw new AppError('INVALID', 401, 'invalid credentials');
      if (!user.emailVerified) throw new AppError('EMAIL_NOT_VERIFIED', 403, 'email not verified');

      const [adminRow] = await app.db
        .select({ passwordHash: schema.adminUsers.passwordHash, status: schema.adminUsers.status })
        .from(schema.adminUsers)
        .where(eq(schema.adminUsers.userId, user.id));
      if (adminRow?.status !== 'active') throw new AppError('INVALID', 401, 'invalid credentials');
      if (!adminRow.passwordHash) throw new AppError('INVALID', 401, 'invalid credentials');
      if (!(await verifyPassword(adminRow.passwordHash, password)))
        throw new AppError('INVALID', 401, 'invalid credentials');

      const secret = new TextEncoder().encode(app.env.JWT_SECRET);
      const accessToken = await signAccess(
        secret,
        user.id,
        { kind: 'access' },
        app.env.JWT_EXPIRY,
        'admin',
      );

      const r = newRefreshToken();
      const expiresAt = new Date(Date.now() + parseDuration(app.env.REFRESH_TOKEN_EXPIRY));
      await app.db.insert(schema.refreshTokens).values({
        userId: user.id,
        familyId: randomUUID(),
        generation: 1,
        tokenHash: r.hash,
        expiresAt,
        portal: 'mobile',
      });

      return { accessToken, refreshToken: r.plain };
    },
  );

  app.post(
    '/v1/auth/refresh-body',
    {
      schema: { body: z.object({ refreshToken: z.string() }) },
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req) => {
      const { refreshToken } = req.body as { refreshToken: string };
      const result = await rotateTokenFamily(app, refreshToken, 'mobile');
      const secret = new TextEncoder().encode(app.env.JWT_SECRET);

      if (result.kind === 'invalid') {
        throw new AppError('INVALID_REFRESH', 401, 'refresh invalid');
      }
      if (result.ownerType !== 'user') {
        throw new AppError('INVALID_REFRESH', 401, 'refresh invalid');
      }

      if (result.kind === 'reissue') {
        return {
          accessToken: await signAccess(
            secret,
            result.ownerId,
            { kind: 'access' },
            app.env.JWT_EXPIRY,
            'admin',
          ),
          refreshToken: null,
        };
      }

      return {
        accessToken: await signAccess(
          secret,
          result.ownerId,
          { kind: 'access' },
          app.env.JWT_EXPIRY,
          'admin',
        ),
        refreshToken: result.refreshPlain,
      };
    },
  );

  app.post(
    '/v1/auth/logout-mobile',
    {
      schema: { body: z.object({ refreshToken: z.string() }) },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req) => {
      const { refreshToken } = req.body as { refreshToken: string };
      const tokenHash = hashRefresh(refreshToken);
      const [row] = await app.db
        .select({ familyId: schema.refreshTokens.familyId, portal: schema.refreshTokens.portal })
        .from(schema.refreshTokens)
        .where(eq(schema.refreshTokens.tokenHash, tokenHash))
        .limit(1);
      if (row?.portal === 'mobile') {
        await app.db
          .update(schema.refreshTokens)
          .set({ revokedAt: new Date() })
          .where(eq(schema.refreshTokens.familyId, row.familyId));
      }
      return { ok: true };
    },
  );

  // ── Email verification ─────────────────────────────────────────────────────

  app.get(
    '/v1/auth/verify-email',
    { schema: { querystring: z.object({ token: z.string().min(1) }) } },
    async (req, reply) => {
      const { token } = req.query as { token: string };
      const userId = await app.redis.getdel(`email:verify:${token}`);
      if (!userId) throw new AppError('INVALID_OR_EXPIRED_TOKEN', 400, 'invalid or expired token');
      const [verifiedUser] = await app.db
        .update(schema.users)
        .set({ emailVerified: true })
        .where(eq(schema.users.id, userId))
        .returning({ email: schema.users.email });

      try {
        if (verifiedUser?.email) {
          await sendWelcomeEmail(app.env.RESEND_API_KEY, app.env.EMAIL_FROM, verifiedUser.email);
        }
      } catch (err) {
        app.log.error({ err }, 'Failed to send welcome email');
      }

      return createSessionTokens(app, userId, reply, 200);
    },
  );

  app.post(
    '/v1/auth/resend-verification',
    {
      schema: { body: z.object({ email: z.string().email() }) },
      config: { rateLimit: { max: 3, timeWindow: '1 hour' } },
    },
    async (req) => {
      const { email } = req.body as { email: string };
      const [user] = await app.db
        .select({ id: schema.users.id, emailVerified: schema.users.emailVerified })
        .from(schema.users)
        .where(eq(schema.users.email, email));
      // Always return 200 — no email enumeration
      if (!user || user.emailVerified) return { sent: true };
      const token = makeToken();
      await app.redis.set(`email:verify:${token}`, user.id, 'EX', 86400);
      try {
        await sendVerificationEmail(
          app.env.RESEND_API_KEY,
          app.env.EMAIL_FROM,
          app.env.WEB_URL,
          email,
          token,
        );
      } catch (err) {
        app.log.error({ err }, 'Failed to resend verification email');
      }
      return { sent: true };
    },
  );

  // ── Password reset ─────────────────────────────────────────────────────────

  app.patch(
    '/v1/me/password',
    {
      preHandler: app.requireUser,
      schema: {
        body: z.object({
          currentPassword: z.string().min(1).optional(),
          newPassword: z.string().min(8),
        }),
      },
    },
    async (req) => {
      const { currentPassword, newPassword } = req.body as {
        currentPassword?: string;
        newPassword: string;
      };
      const [user] = await app.db
        .select({ passwordHash: schema.users.passwordHash })
        .from(schema.users)
        .where(eq(schema.users.id, req.userId));
      if (user?.passwordHash) {
        if (!currentPassword) throw new AppError('INVALID', 400, 'current password required');
        if (!(await verifyPassword(user.passwordHash, currentPassword)))
          throw new AppError('WRONG_PASSWORD', 400, 'current password is incorrect');
      }
      const passwordHash = await hashPassword(newPassword);
      await app.db
        .update(schema.users)
        .set({ passwordHash })
        .where(eq(schema.users.id, req.userId));
      await app.db
        .update(schema.refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(schema.refreshTokens.userId, req.userId));
      return { ok: true };
    },
  );

  app.post(
    '/v1/auth/forgot-password',
    {
      schema: { body: z.object({ email: z.string().email() }) },
      config: { rateLimit: { max: 3, timeWindow: '1 hour' } },
    },
    async (req) => {
      const { email } = req.body as { email: string };
      const [user] = await app.db
        .select({ id: schema.users.id, passwordHash: schema.users.passwordHash })
        .from(schema.users)
        .where(eq(schema.users.email, email));
      // Always return 200 — no email enumeration
      if (!user?.passwordHash) return { sent: true };
      const token = makeToken();
      await app.redis.set(`email:reset:${token}`, user.id, 'EX', 3600);
      try {
        await sendPasswordResetEmail(
          app.env.RESEND_API_KEY,
          app.env.EMAIL_FROM,
          app.env.WEB_URL,
          email,
          token,
        );
      } catch (err) {
        app.log.error({ err }, 'Failed to send password reset email');
      }
      return { sent: true };
    },
  );

  app.post(
    '/v1/auth/reset-password',
    {
      schema: {
        body: z.object({
          token: z.string().min(1),
          newPassword: z.string().min(8),
        }),
      },
    },
    async (req) => {
      const { token, newPassword } = req.body as { token: string; newPassword: string };
      const userId = await app.redis.getdel(`email:reset:${token}`);
      if (!userId) throw new AppError('INVALID_OR_EXPIRED_TOKEN', 400, 'invalid or expired token');
      const passwordHash = await hashPassword(newPassword);
      await app.db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, userId));
      // Revoke all existing sessions for security
      await app.db
        .update(schema.refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(schema.refreshTokens.userId, userId));
      return { ok: true };
    },
  );

  // Admin request
  app.post('/v1/auth/request-admin', { preHandler: app.requireUser }, async (req, reply) => {
    const [existing] = await app.db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.userId, req.userId));

    if (existing) {
      if (existing.status === 'active') {
        throw new AppError('CONFLICT', 409, 'already an active admin');
      }
      if (existing.status === 'pending') {
        return { status: 'pending', role: existing.role };
      }
      await app.db
        .update(schema.adminUsers)
        .set({ status: 'pending' })
        .where(eq(schema.adminUsers.userId, req.userId));
      reply.code(200);
      return { status: 'pending', role: existing.role };
    }

    await app.db.insert(schema.adminUsers).values({
      userId: req.userId,
      role: 'ADMIN',
      status: 'pending',
    });
    reply.code(201);
    return { status: 'pending', role: 'ADMIN' };
  });
}

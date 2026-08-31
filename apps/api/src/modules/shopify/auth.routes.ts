import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { encryptToken } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { writeWidgetKeyMetafield } from './metafields.js';
import { numericIdFromGid, shopifyGraphQL, verifyQueryHmac } from './service.js';
import { type TokenGrant, toTokenGrant } from './token.js';
import { markWidgetConfigUnsynced, publishLatestConfig } from './widget-config.routes.js';

export interface ShopDetails {
  shopifyShopId: number;
  shopDomain: string;
  myshopifyDomain: string;
  primaryDomain?: string;
  name: string;
  shopOwner?: string;
  email: string;
  phone?: string;
  address?: string;
  ianaTimezone?: string;
  /** shop.plan.partnerDevelopment — see the column comment in the db schema. */
  partnerDevelopment: boolean;
}

export async function upsertShopifyStore(
  app: FastifyInstance,
  shop: ShopDetails,
  accessToken: string,
  scope: string,
  grant?: TokenGrant,
) {
  const encKey = app.env.SHOPIFY_TOKEN_ENC_KEY;
  if (!encKey) throw new AppError('CONFIG', 500, 'SHOPIFY_TOKEN_ENC_KEY missing');
  const enc = encryptToken(accessToken, encKey);
  // Absent grant means a caller that predates expiring tokens (tests, mostly).
  // Null out the refresh half rather than leaving a previous install's values
  // behind, where they would point at a rotated-away token.
  const refreshCols = {
    refreshToken: grant?.refreshToken ? encryptToken(grant.refreshToken, encKey) : null,
    tokenExpiresAt: grant?.expiresAt ?? null,
    refreshTokenExpiresAt: grant?.refreshTokenExpiresAt ?? null,
  };
  const origins = [
    `https://${shop.myshopifyDomain}`,
    ...(shop.primaryDomain ? [`https://${shop.primaryDomain}`] : []),
  ];

  return app.db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.shopifyShopId, shop.shopifyShopId))
      .limit(1);

    if (existing) {
      const [store] = await tx
        .update(schema.shopifyStores)
        .set({
          accessToken: enc,
          ...refreshCols,
          scope,
          ianaTimezone: shop.ianaTimezone ?? null,
          shopEmail: shop.email,
          allowedOrigins: origins,
          // Refreshed rather than left at the install-time value: a store can
          // stop being a development store (a partner transfers it to a real
          // merchant), and continuing to treat it as one would keep issuing
          // test charges that never collect money.
          partnerDevelopment: shop.partnerDevelopment,
          uninstalledAt: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.shopifyStores.id, existing.id))
        .returning();
      return store;
    }

    const [store] = await tx
      .insert(schema.shopifyStores)
      .values({
        shopDomain: shop.shopDomain,
        shopifyShopId: shop.shopifyShopId,
        accessToken: enc,
        ...refreshCols,
        scope,
        ianaTimezone: shop.ianaTimezone ?? null,
        shopEmail: shop.email,
        allowedOrigins: origins,
        partnerDevelopment: shop.partnerDevelopment,
      })
      .returning();
    return store;
  });
}

// Where apps/shopify's own router (src/main.tsx's BrowserRouter basename)
// picks up routes — NOT `application_url`'s `/shopify-admin/embedded` suffix;
// that `/embedded` segment is only a one-time landing redirect to `/` (see
// App.tsx), not a routing prefix. Verified live on staging 2026-08-21: for a
// bare `/apps/{apiKey}` (empty `path` below) Shopify embeds `application_url`
// correctly, but for `/apps/{apiKey}{path}` with a non-empty `path` it does
// NOT append that path onto `application_url` — it appends onto the app's
// bare origin instead, silently dropping the whole `/shopify-admin/embedded`
// prefix. A purchase return that passed bare `/billing/callback` landed the
// iframe at `staging-admin.tryme.com/billing/callback`, which nginx's
// catch-all sent to the wrong app entirely (admin-web), rendered by the
// browser as an `X-Frame-Options` block that looks identical to a connection
// refusal. Any non-empty `path` passed to buildPostInstallRedirect must
// include this prefix itself — never rely on Shopify reconstructing it from
// `application_url`.
export const EMBEDDED_SPA_PATH = '/shopify-admin';

/**
 * Where to send the merchant once OAuth completes — or, via the optional
 * `path` param, back into a specific SPA route after a Shopify billing
 * approval redirect (see purchase.routes.ts / autorefill.routes.ts's `/return`
 * routes, which must prefix their `path` with `EMBEDDED_SPA_PATH`).
 *
 * This must hand control back to Shopify rather than point at our own SPA. Only
 * Shopify can mint the `host` and `id_token` query params that App Bridge needs
 * to reach the parent admin frame, and it only supplies them when it opens the
 * app itself. Redirecting straight at the SPA leaves App Bridge with no parent
 * coordinates, and every call into it — `idToken()` included — then hangs
 * forever: no resolve, no reject, no console error, just a permanent loading
 * spinner for the merchant.
 */
export function buildPostInstallRedirect(shop: string, apiKey: string, path = ''): string {
  const storeHandle = shop.replace(/\.myshopify\.com$/, '');
  return `https://admin.shopify.com/store/${storeHandle}/apps/${apiKey}${path}`;
}

const SHOP_DETAILS = `
  query ShopDetails {
    shop {
      id
      name
      email
      myshopifyDomain
      primaryDomain { host }
      shopOwnerName
      billingAddress { phone address1 city country }
      ianaTimezone
      plan { partnerDevelopment }
    }
  }
`;

interface ShopDetailsData {
  shop: {
    id: string;
    name: string;
    email: string;
    myshopifyDomain: string;
    primaryDomain?: { host?: string | null } | null;
    shopOwnerName?: string | null;
    billingAddress?: {
      phone?: string | null;
      address1?: string | null;
      city?: string | null;
      country?: string | null;
    } | null;
    ianaTimezone?: string | null;
    plan?: { partnerDevelopment?: boolean | null } | null;
  };
}

/**
 * Everything that turns a freshly-issued access token into a usable install.
 *
 * Shared by the two ways a token can arrive: the authorization-code callback
 * below, and the managed-installation token exchange in the
 * `requireShopifySession` plugin. Both need the identical follow-on work, and
 * an install provisioned by one path must be indistinguishable from the other
 * — so this lives in one place rather than being mirrored.
 *
 * Post-upsert steps are deliberately tolerant: a metafield mirror or webhook
 * registration that fails must not discard a valid token and leave the store
 * with no row at all. Postgres stays authoritative; those mirrors reconcile
 * later.
 */
export async function provisionShopifyStore(
  app: FastifyInstance,
  shop: string,
  accessToken: string,
  scope: string,
  grant: TokenGrant | undefined,
  log: FastifyBaseLogger,
) {
  const { shop: s } = await shopifyGraphQL<ShopDetailsData>(shop, accessToken, SHOP_DETAILS);
  const details: ShopDetails = {
    shopifyShopId: numericIdFromGid(s.id),
    shopDomain: s.myshopifyDomain,
    myshopifyDomain: s.myshopifyDomain,
    primaryDomain: s.primaryDomain?.host ?? undefined,
    name: s.name,
    shopOwner: s.shopOwnerName ?? undefined,
    email: s.email,
    phone: s.billingAddress?.phone ?? undefined,
    address: [s.billingAddress?.address1, s.billingAddress?.city, s.billingAddress?.country]
      .filter(Boolean)
      .join(', '),
    ianaTimezone: s.ianaTimezone ?? undefined,
    // Defaults to false when the field is absent for any reason: a missing
    // answer must never be read as "test charges are fine here", because that
    // is the reading that gives credits away.
    partnerDevelopment: s.plan?.partnerDevelopment === true,
  };

  const store = await upsertShopifyStore(app, details, accessToken, scope, grant);
  await writeWidgetKeyMetafield(shop, accessToken, details.shopifyShopId, store.storeKey, log);
  // Reauthorization can be reached only after a widget-config PATCH has
  // already committed Postgres and Shopify rejected the old token. Publish
  // that authoritative row with the newly issued token before returning to
  // the app; otherwise the reloaded design page looks clean while Liquid is
  // still rendering the previous metafield value.
  await markWidgetConfigUnsynced(app, store.id);
  await publishLatestConfig(app, store.id, log).catch((err) => {
    // Match widget-key/webhook installation tolerance. A post-install mirror
    // problem must not consume a valid grant without provisioning the store;
    // the saved Postgres config remains authoritative.
    log.error(
      { err, storeId: store.id, shop },
      'failed to republish widget config after shopify authorization',
    );
    return false;
  });
  await app.shopifyRegisterWebhooks?.(shop, accessToken);

  log.info({ storeId: store.id, shop }, 'shopify store installed');
  return store;
}

export async function shopifyAuthRoutes(app: FastifyInstance) {
  // Kept for token recovery (SHOPIFY_REAUTH_REQUIRED), not for installation.
  // Managed installation means Shopify installs the app itself and the store is
  // provisioned from the first session token — nothing in the app should route
  // a fresh install through here.
  app.get('/v1/shopify/auth', async (req, reply) => {
    const shop = (req.query as { shop?: string }).shop;
    if (!shop || !/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) {
      throw new AppError('BAD_REQUEST', 400, 'invalid shop');
    }
    const state = randomUUID();
    await app.redis.set(`shopify:nonce:${state}`, shop, 'EX', 600);
    const scopes = app.env.SHOPIFY_SCOPES;
    const redirectUri = `${app.env.SHOPIFY_APP_URL}/v1/shopify/auth/callback`;
    const url =
      `https://${shop}/admin/oauth/authorize?client_id=${app.env.SHOPIFY_API_KEY}` +
      `&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
    return reply.redirect(url);
  });

  app.get('/v1/shopify/auth/callback', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (!verifyQueryHmac(q, app.env.SHOPIFY_API_SECRET ?? '')) {
      throw new AppError('FORBIDDEN', 403, 'bad hmac');
    }
    const savedShop = await app.redis.get(`shopify:nonce:${q.state}`);
    if (!savedShop || savedShop !== q.shop) throw new AppError('FORBIDDEN', 403, 'bad state');
    await app.redis.del(`shopify:nonce:${q.state}`);
    // q.shop is already pinned to the value /v1/shopify/auth validated and stored
    // under this nonce, but it is interpolated into Shopify API URLs and the
    // return-to-admin redirect below — assert the format here so that safety is
    // local rather than inferred through a Redis round-trip.
    if (!/^[a-z0-9-]+\.myshopify\.com$/.test(q.shop)) {
      throw new AppError('BAD_REQUEST', 400, 'invalid shop');
    }

    // Exchange code → token. This is the one-click reauth flow's callback
    // (initial install is managed-installation, no code flow) — a network
    // blip here is rare but happens during the single most failure-sensitive
    // moment of repairing a store's access, so a raw fetch() throw (DNS
    // failure, TLS error) is mapped to the same SHOPIFY/502 the !ok branch
    // below already uses, instead of surfacing as an opaque 500.
    let tokenRes: Response;
    try {
      tokenRes = await fetch(`https://${q.shop}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: app.env.SHOPIFY_API_KEY,
          client_secret: app.env.SHOPIFY_API_SECRET,
          code: q.code,
          expiring: 1, // Shopify rejects non-expiring offline tokens as of API 2026-07
        }),
      });
    } catch {
      throw new AppError('SHOPIFY', 502, 'Could not reach Shopify to complete authorization');
    }
    if (!tokenRes.ok) throw new AppError('SHOPIFY', 502, 'token exchange failed');
    const tokenBody = (await tokenRes.json()) as {
      access_token: string;
      scope: string;
      refresh_token?: string;
      expires_in?: number;
      refresh_token_expires_in?: number;
    };
    const { access_token, scope } = tokenBody;
    // `expiring: 1` above makes access_token die in ~1h; the refresh half is
    // the only way back without sending the merchant through OAuth again, so
    // it has to be captured here — this is the one place Shopify hands it over.
    const grant = toTokenGrant(tokenBody);

    await provisionShopifyStore(app, q.shop, access_token, scope, grant, req.log);

    // Not `?? ''`: a missing key would build a silently malformed redirect, which
    // is the exact failure mode this redirect exists to avoid.
    if (!app.env.SHOPIFY_API_KEY) throw new AppError('CONFIG', 500, 'SHOPIFY_API_KEY missing');
    return reply.redirect(buildPostInstallRedirect(q.shop, app.env.SHOPIFY_API_KEY));
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    shopifyRegisterWebhooks?: (shop: string, accessToken: string) => Promise<void>;
  }
}

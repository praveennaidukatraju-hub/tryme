import { schema } from '@tryme/db';
import { and, eq, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

export type ShopperRow = typeof schema.shopifyShoppers.$inferSelect;

export interface ShopperIdentityInput {
  clientId: string;
  shopifyCustomerId?: number | null;
  email?: string | null;
}

export type CountingIdentity =
  | { kind: 'customer'; value: number }
  | { kind: 'email'; value: string }
  | { kind: 'client'; value: string };

/** Lowercase + trim, so "A@b.com" and "a@b.com" cannot fork one shopper into
 *  two counting buckets. Returns null for blank/absent input. */
export function normalizeEmail(email?: string | null): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/**
 * The strongest identity signal available for this shopper.
 *
 * Counting spans every row in the store sharing this signal, which is what
 * makes an anonymous -> email upgrade tighten a shopper's limit instead of
 * resetting it. Supplying identity can only ever narrow the bucket a shopper
 * counts against, never widen it — so a forged value cannot loosen a limit.
 */
export function countingIdentity(row: ShopperRow): CountingIdentity {
  if (row.shopifyCustomerId != null) return { kind: 'customer', value: row.shopifyCustomerId };
  const email = normalizeEmail(row.email);
  if (email) return { kind: 'email', value: email };
  return { kind: 'client', value: row.clientId };
}

/** Drizzle predicate matching every shopper row in the store that shares this identity. */
export function shopperIdFilter(storeId: string, id: CountingIdentity): SQL {
  const col =
    id.kind === 'customer'
      ? eq(schema.shopifyShoppers.shopifyCustomerId, id.value)
      : id.kind === 'email'
        ? eq(schema.shopifyShoppers.email, id.value)
        : eq(schema.shopifyShoppers.clientId, id.value);
  return and(eq(schema.shopifyShoppers.storeId, storeId), col) as SQL;
}

/**
 * Upsert this browser's shopper row and stamp last_seen_at.
 *
 * Row identity is (storeId, clientId) — one row per browser, never merged.
 * A stronger signal (customer id / email) enriches the existing row rather
 * than creating a second one. Never nulls a previously-known signal: a
 * logged-in shopper who logs out must not shed the identity they already gave.
 */
export async function resolveShopper(
  app: FastifyInstance,
  storeId: string,
  input: ShopperIdentityInput,
): Promise<ShopperRow> {
  const email = normalizeEmail(input.email);
  const now = new Date();

  const patch: Record<string, unknown> = { lastSeenAt: now };
  if (input.shopifyCustomerId != null) patch.shopifyCustomerId = input.shopifyCustomerId;
  if (email) {
    patch.email = email;
    patch.emailCapturedAt = now;
  }

  const [row] = await app.db
    .insert(schema.shopifyShoppers)
    .values({
      storeId,
      clientId: input.clientId,
      shopifyCustomerId: input.shopifyCustomerId ?? null,
      email,
      emailCapturedAt: email ? now : null,
    })
    .onConflictDoUpdate({
      target: [schema.shopifyShoppers.storeId, schema.shopifyShoppers.clientId],
      set: patch,
    })
    .returning();

  return row;
}

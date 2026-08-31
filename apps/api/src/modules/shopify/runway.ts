import { schema } from '@tryme/db';
import { SIMPLE_TRYON_COST } from '@tryme/types';
import { and, count, eq, gte, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getTryonCreditCost } from '../../lib/resolution-config.js';

/**
 * How close a store is to running out. Ordered — see ALERT_LEVEL_RANK — so the
 * scheduler can ask "is this worse than what we last told them?" numerically
 * rather than with a chain of comparisons that would need editing every time a
 * level is added.
 */
export type AlertLevel = 'ok' | 'warning' | 'critical' | 'empty';

export const ALERT_LEVEL_RANK: Record<AlertLevel, number> = {
  ok: 0,
  warning: 1,
  critical: 2,
  empty: 3,
};

/** Days of runway at or below which each level starts. */
const WARNING_DAYS = 7;
const CRITICAL_DAYS = 2;

/**
 * Absolute-credit fallbacks, used only when there is no spend in the trailing
 * window to divide by. 200 credits is 40 try-ons and 50 is 10 — deliberately
 * generous, because a store with no recent activity is the one most likely to
 * get a burst it hasn't planned for.
 */
const COLD_START_WARNING_CREDITS = 200;
const COLD_START_CRITICAL_CREDITS = 50;

/** Trailing window the burn rate is averaged over. */
export const BURN_WINDOW_DAYS = 7;

export interface Runway {
  balance: number;
  tryOnsRemaining: number;
  /** Trailing-window average, credits per day. Zero when nothing was spent. */
  dailyBurnCredits: number;
  /** Null when there is no burn to divide by — never Infinity. */
  daysRemaining: number | null;
  level: AlertLevel;
  lifetimeJobs: number;
}

/**
 * The single definition of "low". Pure, so the thresholds are testable without
 * a database — which matters because these numbers are the whole feature and a
 * regression in them is silent.
 *
 * A flat credit threshold was rejected: 50 credits is 10 try-ons, which against
 * a 10,000-credit balance is no warning at all, and against an 800-credit one
 * is constant noise.
 *
 * `tryonCost` defaults to the compile-time SIMPLE_TRYON_COST so existing
 * callers/tests that don't pass one keep the historical boundary. Real callers
 * should pass the live, admin-tunable cost (`getTryonCreditCost`) — see
 * `computeRunway` below.
 */
export function deriveLevel(input: {
  balance: number;
  dailyBurnCredits: number;
  lifetimeJobs: number;
  tryonCost?: number;
}): { level: AlertLevel; daysRemaining: number | null } {
  const { balance, dailyBurnCredits, lifetimeJobs, tryonCost = SIMPLE_TRYON_COST } = input;

  // 'empty' means "can no longer afford a try-on", not "balance is exactly
  // zero" — the storefront (customer.routes.ts's requireStoreHasCredits)
  // already blocks a shopper once balance < jobCost, which is a higher bar
  // than <= 0. A store with, say, 3 credits and a 5-credit job cost is fully
  // blocked but would otherwise still show as 'critical' with a misleading
  // "about 1 day left".
  if (balance < tryonCost) return { level: 'empty', daysRemaining: 0 };

  // A store that has never run a job is mid-onboarding. Its balance is the
  // free-tier grant and it has no spend history to judge against, so any alert
  // here is about a problem the merchant does not yet have.
  if (lifetimeJobs === 0) return { level: 'ok', daysRemaining: null };

  if (dailyBurnCredits <= 0) {
    // Ran jobs at some point, but nothing in the trailing window. There is no
    // rate to divide by, so daysRemaining stays null rather than becoming
    // Infinity, and the level comes from absolute credits instead.
    if (balance < COLD_START_CRITICAL_CREDITS) return { level: 'critical', daysRemaining: null };
    if (balance < COLD_START_WARNING_CREDITS) return { level: 'warning', daysRemaining: null };
    return { level: 'ok', daysRemaining: null };
  }

  const daysRemaining = balance / dailyBurnCredits;
  if (daysRemaining < CRITICAL_DAYS) return { level: 'critical', daysRemaining };
  if (daysRemaining < WARNING_DAYS) return { level: 'warning', daysRemaining };
  return { level: 'ok', daysRemaining };
}

/**
 * Burn is the trailing-window sum of what was actually charged, not a job
 * count times an assumed price — `jobs.credits_charged` is the real number and
 * survives an admin retuning `tryon.creditCost` mid-window.
 *
 * FAILED jobs are excluded because they are refunded, so their net spend is
 * zero; counting them would overstate burn and warn merchants early on the
 * strength of work they were never billed for.
 *
 * Uses the existing `jobs_shopify_store_created_idx` on
 * (shopify_store_id, created_at) — no new index required.
 */
export async function computeRunway(app: FastifyInstance, storeId: string): Promise<Runway> {
  const windowStart = new Date(Date.now() - BURN_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [creditRow] = await app.db
    .select({ balance: schema.shopifyStoreCredits.balance })
    .from(schema.shopifyStoreCredits)
    .where(eq(schema.shopifyStoreCredits.storeId, storeId))
    .limit(1);
  const balance = creditRow?.balance ?? 0;

  const [spendRow] = await app.db
    .select({
      spent: sql<number>`COALESCE(SUM(${schema.jobs.creditsCharged}), 0)::int`,
    })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.shopifyStoreId, storeId),
        ne(schema.jobs.status, 'FAILED'),
        gte(schema.jobs.createdAt, windowStart),
      ),
    );

  const [lifetimeRow] = await app.db
    .select({ n: count() })
    .from(schema.jobs)
    .where(eq(schema.jobs.shopifyStoreId, storeId));

  const dailyBurnCredits = (spendRow?.spent ?? 0) / BURN_WINDOW_DAYS;
  const lifetimeJobs = lifetimeRow?.n ?? 0;
  // Live, admin-tunable value — the same one the storefront actually charges
  // per try-on (customer.routes.ts). SIMPLE_TRYON_COST is only the fallback
  // getTryonCreditCost uses when nothing has been configured; using the
  // compile-time constant directly here would drift from that fallback the
  // moment an admin retunes tryon.creditCost, quoting a wrong try-on count in
  // every banner and email by the ratio between the two values.
  const tryonCost = await getTryonCreditCost(app);
  const { level, daysRemaining } = deriveLevel({
    balance,
    dailyBurnCredits,
    lifetimeJobs,
    tryonCost,
  });

  return {
    balance,
    tryOnsRemaining: Math.floor(balance / tryonCost),
    dailyBurnCredits,
    daysRemaining,
    level,
    lifetimeJobs,
  };
}

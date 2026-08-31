// Display copy only. The credit-granting source of truth is
// apps/api/src/modules/shopify/packs.ts, kept deliberately separate so a copy
// change here can never silently change what a merchant is actually granted.
// If these numbers drift from the API's, the API wins, and the merchant sees
// the API's figure in their balance.
export interface PackDisplay {
  id: 'pack_10' | 'pack_25' | 'pack_50' | 'pack_100';
  label: string;
  priceUsd: number;
  credits: number;
  /**
   * What an auto-refill purchase of this pack actually grants (the API's
   * +10% bonus, baked into the number rather than computed here) — read this
   * directly for any auto-refill-facing display instead of deriving it from
   * `credits`. The two are a flat 1.1x apart today, but only because that's
   * what apps/api/src/modules/shopify/packs.ts's CREDIT_PACKS happens to be
   * tuned to; an admin can retune `credits` and `autorefillCredits`
   * independently via the Shopify Credits settings tab, and a client-side
   * `credits * 1.1` would silently drift from what the merchant is actually
   * granted the moment that ratio stops being exactly 10%.
   */
  autorefillCredits: number;
  tryOns: number;
  bestValue?: boolean;
}

export const PACK_DISPLAY: PackDisplay[] = [
  {
    id: 'pack_10',
    label: 'Starter',
    priceUsd: 10,
    credits: 800,
    autorefillCredits: 880,
    tryOns: 160,
  },
  {
    id: 'pack_25',
    label: 'Growth',
    priceUsd: 25,
    credits: 2250,
    autorefillCredits: 2475,
    tryOns: 450,
    bestValue: true,
  },
  {
    id: 'pack_50',
    label: 'Pro',
    priceUsd: 50,
    credits: 4800,
    autorefillCredits: 5280,
    tryOns: 960,
  },
  {
    id: 'pack_100',
    label: 'Enterprise',
    priceUsd: 100,
    credits: 10000,
    autorefillCredits: 11000,
    tryOns: 2000,
  },
];

export const SHARED_FEATURE_BULLETS = [
  'Unlimited products',
  'AI Virtual Try-On',
  'Outfit Builder',
  'Customer Photo Upload',
  'Shopify Integration',
  'Try-On Button',
  'Multiple Garment Categories',
  'Realistic AI Rendering',
  'Try-On History',
  'Mobile & Desktop Support',
];

/**
 * Credits never expire, so this is the merchant's whole runway, not a monthly
 * allowance. The divisor is the compile-time default try-on cost, not the
 * live admin-tunable value (tryon.creditCost) — this figure can drift from
 * the API's if an admin retunes the cost.
 *
 * Fallback only: `/v1/shopify/me` now returns `runway.tryOnsRemaining`,
 * computed server-side from the live cost — prefer that wherever `me` is
 * already loaded (see PricingPage). This function exists for the rare spot
 * with no `me` response to read from; it has no live-config access of its
 * own and inventing an endpoint just for this display number wasn't worth
 * the plumbing. The API-side charge name shown to the merchant at purchase
 * time (apps/api/src/modules/shopify/purchase.ts) always uses the live value
 * and is the one that's actually money-relevant.
 */
export function tryOnsFromCredits(credits: number): number {
  return Math.floor(credits / 5);
}

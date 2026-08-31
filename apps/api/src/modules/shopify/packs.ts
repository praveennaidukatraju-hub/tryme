/**
 * The credit packs a Shopify merchant can buy. Unlike the Shopify App Pricing
 * plan names this replaces, pack ids are ours end to end — Shopify never echoes
 * one back to us — so this needs no case-insensitive matching and no Partner
 * Dashboard coordination. An unknown id resolves to null and sells nothing
 * rather than guessing which pack the merchant meant.
 *
 * Credits never expire and are not cycle-scoped: a merchant may spend a pack
 * over ten days or forty.
 *
 * `priceUsd` is what gets sent to Shopify in the charge mutation, so it lives
 * here and only here — deliberately NOT admin-tunable, because config that
 * changes what a merchant is *charged* is a different risk class from config
 * that changes what they *receive*. `credits` and `autorefillCredits` are
 * admin-tunable via getShopifyPackCredits.
 *
 * Shopify rejects an application charge under $0.50 USD. No pack is close, so
 * this is a comment rather than a runtime check — prices are static.
 */
export const CREDIT_PACK_IDS = ['pack_10', 'pack_25', 'pack_50', 'pack_100'] as const;
export type CreditPackId = (typeof CREDIT_PACK_IDS)[number];

export interface CreditPack {
  id: CreditPackId;
  priceUsd: number;
  /** Granted on a manual one-time purchase. */
  credits: number;
  /**
   * Granted on an auto-refill purchase — a flat +10% bonus. Auto-refill has to
   * be strictly better than repeat manual buying or no merchant would hand over
   * a standing charge authorization. Stored and tested from phase 1; nothing
   * writes an 'autorefill' purchase until phase 3.
   */
  autorefillCredits: number;
  label: string;
}

export const CREDIT_PACKS: Record<CreditPackId, CreditPack> = {
  pack_10: { id: 'pack_10', priceUsd: 10, credits: 800, autorefillCredits: 880, label: 'Starter' },
  pack_25: { id: 'pack_25', priceUsd: 25, credits: 2250, autorefillCredits: 2475, label: 'Growth' },
  pack_50: { id: 'pack_50', priceUsd: 50, credits: 4800, autorefillCredits: 5280, label: 'Pro' },
  pack_100: {
    id: 'pack_100',
    priceUsd: 100,
    credits: 10000,
    autorefillCredits: 11000,
    label: 'Enterprise',
  },
};

/** The pack, or null when the id is not one we sell. */
export function getPack(id: string): CreditPack | null {
  return (CREDIT_PACKS as Record<string, CreditPack>)[id] ?? null;
}

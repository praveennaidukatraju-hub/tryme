export interface ShopifyStoreLimits {
  /** null = off. Hard ceiling on generations per store-local day. */
  storeDailyCap?: number | null;
  /** null = off. Soft — defeatable by a fresh browser; see the design doc. */
  perShopperCap?: number | null;
  perShopperWindow?: 'day' | 'week' | 'month';
  /** null = never ask. 0 = ask before the first generation. */
  emailAfterNTryOns?: number | null;
}

export interface ShopifyStoreRetention {
  /** null = off, for all three. Days until deletion. */
  shopperPhotoDays?: number | null;
  resultDays?: number | null;
  shopperRecordDays?: number | null;
}

export interface ShopifyActivationSettings {
  mode: 'global' | 'selective';
}

export interface ShopifyStoreSettings {
  workflowTemplateId?: string;
  themeBlockConfirmed?: boolean;
  emailBonusClaimed?: boolean;
  emailBonusClaimedAt?: string;
  limits?: ShopifyStoreLimits;
  retention?: ShopifyStoreRetention;
  widget?: ShopifyWidgetConfig;
  widgetConfigSynced?: boolean;
  activation?: ShopifyActivationSettings;
}

export interface ShopifyWidgetTheme {
  accentColor?: string | null;
}

export interface ShopifyWidgetCopy {
  heading?: string | null;
  subheading?: string | null;
  uploadTitle?: string | null;
  uploadLead?: string | null;
  chooseLabel?: string | null;
  ctaLabel?: string | null;
  legalText?: string | null;
  generatingText?: string | null;
  errorText?: string | null;
}

export interface ShopifyWidgetBehavior {
  addToCart?: boolean;
  addToCartLabel?: string | null;
  share?: boolean;
  shareLabel?: string | null;
}

export interface ShopifyWidgetConfig {
  theme?: ShopifyWidgetTheme;
  copy?: ShopifyWidgetCopy;
  behavior?: ShopifyWidgetBehavior;
}

export interface ShopifyWidgetConfigResponse {
  widget: ShopifyWidgetConfig;
  synced: boolean;
}

export interface ShopifyStats {
  totalTryOns: number;
  syncedProductCount: number;
  enabledProductCount: number;
  statusCounts: { active: number; processing: number; failed: number; disabled: number };
  todayTryOns: number;
  storeDailyCap: number | null;
  capturedEmailCount: number;
}

export interface ShopifyMe {
  store: {
    shopDomain: string;
    shopEmail: string | null;
    settings: ShopifyStoreSettings;
    connectedSince: string;
  };
  creditBalance: number;
  hasPurchasedPack: boolean;
  runway: {
    balance: number;
    tryOnsRemaining: number;
    dailyBurnCredits: number;
    daysRemaining: number | null;
    level: 'ok' | 'warning' | 'critical' | 'empty';
  };
  autorefill: {
    enabled: boolean;
    status: 'PENDING' | 'ACTIVE' | 'CANCELLED' | 'DECLINED' | 'CAP_REACHED' | null;
    packId: string | null;
    triggerCredits: number | null;
    cappedAmountUsdCents: number | null;
    balanceUsedUsdCents: number | null;
  };
  stats: ShopifyStats;
}

export interface ShopifyOnboardingConfirmResponse {
  settings: ShopifyStoreSettings;
}

export interface ShopifyEmailBonusClaimResponse {
  creditsGranted: number;
  creditBalance: number;
  settings: ShopifyStoreSettings;
}

export interface ShopifyProductListItem {
  shopifyProductId: number;
  title: string | null;
  thumbnailUrl: string;
  status: string;
  enabled: boolean;
  excluded: boolean;
}

export interface ShopifyProductImage {
  id: number;
  src: string;
}

export interface ShopifyShopperListItem {
  id: string;
  email: string;
  emailConsent: boolean;
  firstSeenAt: string;
  tryOnCount: number;
}

export interface ShopifyAnalyticsCards {
  tryOns: number;
  uniqueShoppers: number;
  addedToCart: number;
  addToCartRate: number;
  emailsCaptured: number;
  turnedAway: { total: number; storeCap: number; shopperCap: number; emailGate: number };
}

export interface ShopifyAnalyticsFunnel {
  buttonClick: number;
  upload: number;
  tryOn: number;
  resultView: number;
  addToCart: number;
  unattributed: number;
}

export interface ShopifyAnalyticsProduct {
  shopifyProductId: number;
  title: string | null;
  tryOns: number;
  uniqueShoppers: number;
  addedToCart: number;
  addToCartRate: number;
}

export interface ShopifyAnalytics {
  range: { from: string; to: string; timezone: string };
  cards: ShopifyAnalyticsCards;
  daily: { day: string; tryOns: number }[];
  funnel: ShopifyAnalyticsFunnel;
  products: ShopifyAnalyticsProduct[];
}

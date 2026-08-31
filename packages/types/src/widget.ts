import { z } from 'zod';

export const MerchantStatusSchema = z.enum(['ONBOARDING_REQUIRED', 'PENDING_ACTIVATION', 'ACTIVE']);
export type MerchantStatusSchema = z.infer<typeof MerchantStatusSchema>;

// Phone is the only mandatory field: contactName falls back to the Google
// display name, companyName to contactName, businessAddress to 'Not Provided'.
export const MerchantOnboardingBody = z.object({
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9]{10,15}$/, 'Enter a valid mobile number'),
  contactName: z.string().max(120).optional(),
  companyName: z.string().max(200).optional(),
  businessAddress: z.string().max(500).optional(),
});
export type MerchantOnboardingBody = z.infer<typeof MerchantOnboardingBody>;

/**
 * Authoritative merchant plan billing data — the single source of truth for
 * money. The API computes order amounts from THIS, never from client input.
 * The web pricing UI merges display-only metadata on top of these by slug.
 */
export interface MerchantPlanBilling {
  slug: string;
  name: string;
  /** Base price in INR, excluding GST */
  priceInr: number;
  credits: number;
}

export const MERCHANT_PLAN_SLUGS = ['basic', 'advanced', 'pro', 'ultra'] as const;
export type MerchantPlanSlug = (typeof MERCHANT_PLAN_SLUGS)[number];

export const MERCHANT_PLAN_BILLING: Record<MerchantPlanSlug, MerchantPlanBilling> = {
  basic: { slug: 'basic', name: 'Basic', priceInr: 25000, credits: 10000 },
  advanced: { slug: 'advanced', name: 'Advanced', priceInr: 50000, credits: 25000 },
  pro: { slug: 'pro', name: 'Pro', priceInr: 75000, credits: 40000 },
  ultra: { slug: 'ultra', name: 'Ultra', priceInr: 150000, credits: 100000 },
};

export const MerchantCheckoutBody = z.object({
  planSlug: z.enum(MERCHANT_PLAN_SLUGS),
});
export type MerchantCheckoutBody = z.infer<typeof MerchantCheckoutBody>;

export const MerchantPaymentVerify = z.object({
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
});
export type MerchantPaymentVerify = z.infer<typeof MerchantPaymentVerify>;

export const MerchantCatalogModerationStatus = z.enum(['approved', 'rejected']);
export type MerchantCatalogModerationStatus = z.infer<typeof MerchantCatalogModerationStatus>;

export const MerchantCatalogPresignBody = z.object({
  assetId: z.string().uuid().optional(),
  kind: z.enum(['image', 'thumbnail', 'flat']),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  contentLength: z
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024),
});
export type MerchantCatalogPresignBody = z.infer<typeof MerchantCatalogPresignBody>;

export const MerchantCatalogCreateBody = z.object({
  subcategoryId: z.string().uuid(),
  label: z.string().min(1).max(200),
  sku: z.string().max(120).optional(),
  actualPrice: z.number().int().min(0), // rupees — converted to paise at the route layer
  offerPrice: z.number().int().min(0), // rupees — converted to paise at the route layer
  r2Key: z.string().min(1),
  thumbnailKey: z.string().min(1),
  // Pallu image for a two-input saree product uploaded directly — both optional and
  // present together, or both absent. Route-layer validates that pairing.
  secondR2Key: z.string().min(1).optional(),
  secondThumbnailKey: z.string().min(1).optional(),
});
export type MerchantCatalogCreateBody = z.infer<typeof MerchantCatalogCreateBody>;

export const MerchantCatalogUpdateBody = z
  .object({
    subcategoryId: z.string().uuid().optional(),
    label: z.string().min(1).max(200).optional(),
    sku: z.string().max(120).nullable().optional(),
    actualPrice: z.number().int().min(0).optional(),
    offerPrice: z.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(999999).optional(),
  })
  .refine(
    (body) =>
      body.subcategoryId !== undefined ||
      body.label !== undefined ||
      body.sku !== undefined ||
      body.actualPrice !== undefined ||
      body.offerPrice !== undefined ||
      body.isActive !== undefined ||
      body.sortOrder !== undefined,
    { message: 'at least one field is required' },
  );
export type MerchantCatalogUpdateBody = z.infer<typeof MerchantCatalogUpdateBody>;

export const MerchantCatalogImportBody = z.object({
  jobId: z.string().uuid(),
  subcategoryId: z.string().uuid(),
});
export type MerchantCatalogImportBody = z.infer<typeof MerchantCatalogImportBody>;

export const MerchantCatalogSourceKind = z.enum(['uploaded', 'generated', 'imported']);
export type MerchantCatalogSourceKind = z.infer<typeof MerchantCatalogSourceKind>;

export const MerchantCatalogItem = z.object({
  id: z.string().uuid(),
  merchantId: z.string().uuid(),
  subcategoryId: z.string().uuid(),
  label: z.string(),
  sku: z.string().nullable(),
  actualPrice: z.number().int(), // rupees — converted from paise by the route layer
  offerPrice: z.number().int(),
  r2Key: z.string(),
  thumbnailKey: z.string(),
  imageUrl: z.string().url().nullable(),
  thumbnailUrl: z.string().url().nullable(),
  secondR2Key: z.string().nullable(),
  secondThumbnailKey: z.string().nullable(),
  secondImageUrl: z.string().url().nullable(),
  sourceJobId: z.string().uuid().nullable(),
  sourceKind: MerchantCatalogSourceKind,
  flatSourceKey: z.string().nullable(),
  isActive: z.boolean(),
  moderationStatus: MerchantCatalogModerationStatus,
  moderationNote: z.string().nullable(),
  sortOrder: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Present and true only for admin-authored demo rows appended by the demo
  // catalog reader. Absent on the merchant's own rows.
  isDemo: z.boolean().optional(),
  readOnly: z.boolean().optional(),
});
export type MerchantCatalogItem = z.infer<typeof MerchantCatalogItem>;

export const MerchantCatalogListResponse = z.object({
  items: z.array(MerchantCatalogItem),
});
export type MerchantCatalogListResponse = z.infer<typeof MerchantCatalogListResponse>;

export const MerchantCatalogCategory = z.enum(['men', 'women', 'boys', 'girls']);
export type MerchantCatalogCategory = z.infer<typeof MerchantCatalogCategory>;

export const MerchantCatalogSubcategoryCreateBody = z.object({
  category: MerchantCatalogCategory,
  name: z.string().min(1).max(160),
  garmentSubcategoryId: z.string().uuid(),
});
export type MerchantCatalogSubcategoryCreateBody = z.infer<
  typeof MerchantCatalogSubcategoryCreateBody
>;

export const MerchantCatalogSubcategoryUpdateBody = z
  .object({
    name: z.string().min(1).max(160).optional(),
    garmentSubcategoryId: z.string().uuid().optional(),
    sortOrder: z.number().int().min(0).max(999999).optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.garmentSubcategoryId !== undefined ||
      body.sortOrder !== undefined,
    { message: 'at least one field is required' },
  );
export type MerchantCatalogSubcategoryUpdateBody = z.infer<
  typeof MerchantCatalogSubcategoryUpdateBody
>;

export const MerchantCatalogSubcategory = z.object({
  id: z.string().uuid(),
  merchantId: z.string().uuid(),
  category: MerchantCatalogCategory,
  name: z.string(),
  garmentSubcategoryId: z.string().uuid(),
  // True only when the linked garment type both requires the mannequin step AND has a
  // two-input (body + pallu) step-1 workflow configured. Drives whether ProductModal
  // shows a second "Pallu" upload box for this subcategory — see docs/superpowers/plans/
  // 2026-08-20-merchant-catalog-saree-two-input.md.
  supportsTwoInputMannequin: z.boolean(),
  // True only when garmentSubcategories.twoInputTryonWorkflowTemplateId is set — gates
  // whether ProductModal's "Catalogue Image" (direct upload) mode shows a second Pallu
  // upload box. Independent of supportsTwoInputMannequin (that one gates the "Flat Image"
  // AI-generate mode's Pallu box instead) — a garment type can have either, both, or
  // neither configured.
  supportsTwoInputDirectTryon: z.boolean(),
  sortOrder: z.number().int(),
  productCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Present and true only for admin-authored demo rows appended by the demo
  // catalog reader. Absent on the merchant's own rows.
  isDemo: z.boolean().optional(),
  readOnly: z.boolean().optional(),
});
export type MerchantCatalogSubcategory = z.infer<typeof MerchantCatalogSubcategory>;

export const MerchantCatalogSubcategoryListResponse = z.object({
  items: z.array(MerchantCatalogSubcategory),
});
export type MerchantCatalogSubcategoryListResponse = z.infer<
  typeof MerchantCatalogSubcategoryListResponse
>;

export const MerchantCatalogGenerateBody = z.object({
  subcategoryId: z.string().uuid(),
  flatImageKey: z.string().min(1),
  // When true, skip the normal pose/background/face compositing (step 2) and
  // finalize the job with the mannequin-drape (step 1) output directly. Only
  // valid for garment types with requires_mannequin_step = true.
  mannequinOnly: z.boolean().optional(),
  // Selects which mannequin (step-1) workflow template generates this job —
  // matched against saree_mannequin_styles.label (case-insensitive), not the
  // row's id, so callers can send the human-readable style name shown in
  // admin/the app instead of looking up a UUID. Omitted = falls back to the
  // garment type's own mannequinWorkflowTemplateId (unchanged behavior).
  // When secondFlatImageKey is also present, the style must have its own
  // two-input workflow configured (mannequinTwoInputWorkflowTemplateId on
  // saree_mannequin_styles) — that takes precedence over the garment type's
  // default two-input workflow, mirroring single-input precedence.
  sareeStyleId: z.string().min(1).optional(),
  // Pallu image for the "Body & Pallu" two-input upload mode. Only valid for
  // garment types with mannequinTwoInputWorkflowTemplateId configured
  // (enforced server-side), unless sareeStyleId is also supplied — then the
  // style's own two-input workflow is used instead of the garment type's,
  // and the style must have one configured or the request is rejected.
  // Presigned the same way as flatImageKey, via POST /v1/merchant/catalog/presign
  // called a second time.
  secondFlatImageKey: z.string().min(1).optional(),
});
export type MerchantCatalogGenerateBody = z.infer<typeof MerchantCatalogGenerateBody>;

export const MerchantCatalogGenerateBulkBody = z.object({
  subcategoryId: z.string().uuid(),
  flatImageKeys: z.array(z.string().min(1)).min(1).max(50),
});
export type MerchantCatalogGenerateBulkBody = z.infer<typeof MerchantCatalogGenerateBulkBody>;

export const MerchantCatalogGenerateStatus = z.object({
  jobId: z.string().uuid(),
  status: z.string(),
  resultUrl: z.string().url().nullable(),
  errorCode: z.string().nullable(),
});
export type MerchantCatalogGenerateStatus = z.infer<typeof MerchantCatalogGenerateStatus>;

export const MerchantSareeStyle = z.object({
  id: z.string().uuid(),
  label: z.string(),
  previewUrl: z.string().url().nullable(),
  sortOrder: z.number().int(),
  supportsTwoInput: z.boolean(),
});
export type MerchantSareeStyle = z.infer<typeof MerchantSareeStyle>;

export const MerchantSareeStyleListResponse = z.object({
  items: z.array(MerchantSareeStyle),
});
export type MerchantSareeStyleListResponse = z.infer<typeof MerchantSareeStyleListResponse>;

export const MerchantCatalogGenerateBulkStatusResponse = z.object({
  items: z.array(MerchantCatalogGenerateStatus),
});
export type MerchantCatalogGenerateBulkStatusResponse = z.infer<
  typeof MerchantCatalogGenerateBulkStatusResponse
>;

export const MerchantCatalogueStudioJob = z.object({
  jobId: z.string().uuid(),
  catalogueId: z.string().uuid(),
  label: z.string(),
  thumbnailUrl: z.string().url().nullable(),
  createdAt: z.string(),
  imported: z.boolean(),
});
export type MerchantCatalogueStudioJob = z.infer<typeof MerchantCatalogueStudioJob>;

export const MerchantCatalogueStudioGroup = z.object({
  catalogueId: z.string().uuid(),
  label: z.string(),
  createdAt: z.string(),
  jobs: z.array(MerchantCatalogueStudioJob),
});
export type MerchantCatalogueStudioGroup = z.infer<typeof MerchantCatalogueStudioGroup>;

export const MerchantCataloguesResponse = z.object({
  catalogues: z.array(MerchantCatalogueStudioGroup),
});
export type MerchantCataloguesResponse = z.infer<typeof MerchantCataloguesResponse>;

export const MerchantTryonPresignBody = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  contentLength: z
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024),
});
export type MerchantTryonPresignBody = z.infer<typeof MerchantTryonPresignBody>;

export const MerchantTryonJobCreateBody = z.object({
  merchantCatalogItemId: z.string().uuid(),
  customerPhotoKey: z.string().min(1),
});
export type MerchantTryonJobCreateBody = z.infer<typeof MerchantTryonJobCreateBody>;

export const MerchantTryonJobDetailResponse = z.object({
  id: z.string().uuid(),
  status: z.string(),
  merchantId: z.string().uuid(),
  resultKey: z.string().nullable(),
  shareUrl: z.string().url().nullable(),
  errorCode: z.string().nullable(),
  liked: z.boolean(),
  inCart: z.boolean(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type MerchantTryonJobDetailResponse = z.infer<typeof MerchantTryonJobDetailResponse>;

export const MerchantTryonHistoryQuery = z.object({
  before: z.string().date().optional(),
  limit: z.coerce.number().int().min(1).max(90).default(30),
});
export type MerchantTryonHistoryQuery = z.infer<typeof MerchantTryonHistoryQuery>;

export const MerchantTryonHistoryDay = z.object({
  date: z.string(),
  inputCount: z.number().int(),
  generatedCount: z.number().int(),
  failedCount: z.number().int(),
});
export type MerchantTryonHistoryDay = z.infer<typeof MerchantTryonHistoryDay>;

export const MerchantTryonHistoryResponse = z.object({
  days: z.array(MerchantTryonHistoryDay),
  nextCursor: z.string().nullable(),
});
export type MerchantTryonHistoryResponse = z.infer<typeof MerchantTryonHistoryResponse>;

export const MerchantUploadSessionCreateResponse = z.object({
  token: z.string(),
  qrUrl: z.string().url(),
  expiresIn: z.number().int(),
});
export type MerchantUploadSessionCreateResponse = z.infer<
  typeof MerchantUploadSessionCreateResponse
>;

export const MerchantUploadSessionStatusResponse = z.object({
  status: z.enum(['pending', 'uploaded']),
  r2Key: z.string().nullable(),
});
export type MerchantUploadSessionStatusResponse = z.infer<
  typeof MerchantUploadSessionStatusResponse
>;

export const PublicUploadSessionPresignBody = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  contentLength: z
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024),
});
export type PublicUploadSessionPresignBody = z.infer<typeof PublicUploadSessionPresignBody>;

export const PublicUploadSessionPresignResponse = z.object({
  uploadUrl: z.string().url(),
  expiresIn: z.number().int(),
});
export type PublicUploadSessionPresignResponse = z.infer<typeof PublicUploadSessionPresignResponse>;

// Public "download all" QR flow (kiosk android app): the QR encodes a comma-joined
// list of job IDs (short, unlike presigned URLs) rather than the images themselves —
// this endpoint re-mints presigned URLs for them on demand.
export const KioskDownloadBatchQuery = z.object({
  jobIds: z.string().min(1),
});
export type KioskDownloadBatchQuery = z.infer<typeof KioskDownloadBatchQuery>;

export const KioskDownloadBatchResponse = z.object({
  items: z.array(
    z.object({
      jobId: z.string().uuid(),
      url: z.string().url(),
    }),
  ),
});
export type KioskDownloadBatchResponse = z.infer<typeof KioskDownloadBatchResponse>;

export const AdminMerchantCatalogUpdateBody = z
  .object({
    isActive: z.boolean().optional(),
    moderationStatus: MerchantCatalogModerationStatus.optional(),
    moderationNote: z.string().max(1000).nullable().optional(),
  })
  .refine(
    (body) =>
      body.isActive !== undefined ||
      body.moderationStatus !== undefined ||
      body.moderationNote !== undefined,
    { message: 'at least one field is required' },
  );
export type AdminMerchantCatalogUpdateBody = z.infer<typeof AdminMerchantCatalogUpdateBody>;

export const AdminMerchantUpdateBody = z
  .object({
    isActive: z.boolean().optional(),
    companyName: z.string().min(1).max(160).optional(),
    contactName: z.string().min(1).max(120).optional(),
    phone: z.string().min(1).max(40).optional(),
    businessAddress: z.string().min(1).optional(),
    demoData: z.boolean().optional(),
    webhookUrl: z.string().url().nullable().optional(),
    webhookSecret: z.string().max(512).nullable().optional(),
    // Null clears the override back to DEFAULT_JOB_RATE_LIMIT_PER_MIN.
    jobRateLimitPerMin: z.number().int().min(1).max(500).nullable().optional(),
    logoKey: z.string().max(500).nullable().optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'at least one field is required',
  });
export type AdminMerchantUpdateBody = z.infer<typeof AdminMerchantUpdateBody>;

export const ShopifyCustomerPresignRequest = z.object({
  contentType: z.string(),
  // Matches the storefront widget's own MAX_PHOTO_BYTES check
  // (tryon-widget.js) so a shopper never gets a presigned URL for a photo the
  // widget would have already rejected client-side.
  contentLength: z
    .number()
    .int()
    .positive()
    .max(25 * 1024 * 1024),
  clientId: z.string().uuid().optional(),
});
export type ShopifyCustomerPresignRequest = z.infer<typeof ShopifyCustomerPresignRequest>;

export const ShopifyCustomerJobRequest = z.object({
  customerPhotoKey: z.string(),
  shopifyProductId: z.number().int().positive(),
  // All three are client-supplied and forgeable. That is acceptable because
  // supplying identity can only narrow the bucket a shopper counts against,
  // never widen it — no authorization decision depends on them.
  clientId: z.string().uuid().optional(),
  shopifyCustomerId: z.number().int().positive().optional(),
  email: z.string().email().max(320).optional(),
  emailConsent: z.boolean().optional(),
});
export type ShopifyCustomerJobRequest = z.infer<typeof ShopifyCustomerJobRequest>;

export const ShopifyCustomerPhotoPreviewRequest = z.object({
  r2Key: z.string().min(1),
});
export type ShopifyCustomerPhotoPreviewRequest = z.infer<typeof ShopifyCustomerPhotoPreviewRequest>;

// Fixed option sets, not free ranges. A dropdown of allowed values eliminates
// the "2000 instead of 200" typo class, and an out-of-set value is a 400
// rather than something that lands silently in JSONB.
export const STORE_DAILY_CAP_OPTIONS = [50, 100, 250, 500, 1000, 2500, 5000] as const;
export const PER_SHOPPER_CAP_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export const EMAIL_AFTER_N_OPTIONS = [0, 1, 2, 3, 5] as const;
export const SHOPPER_PHOTO_RETENTION_DAYS = [7, 30, 90] as const;
export const RESULT_RETENTION_DAYS = [30, 90, 180, 365] as const;
export const SHOPPER_RECORD_RETENTION_DAYS = [90, 180, 365] as const;

const optionOrOff = <T extends number>(options: readonly T[]) =>
  z.union([z.literal(null), z.number().refine((n) => (options as readonly number[]).includes(n))]);

export const ShopifyStoreLimitsPatch = z.object({
  storeDailyCap: optionOrOff(STORE_DAILY_CAP_OPTIONS).optional(),
  perShopperCap: optionOrOff(PER_SHOPPER_CAP_OPTIONS).optional(),
  perShopperWindow: z.enum(['day', 'week', 'month']).optional(),
  emailAfterNTryOns: optionOrOff(EMAIL_AFTER_N_OPTIONS).optional(),
});

export const ShopifyStoreRetentionPatch = z.object({
  shopperPhotoDays: optionOrOff(SHOPPER_PHOTO_RETENTION_DAYS).optional(),
  resultDays: optionOrOff(RESULT_RETENTION_DAYS).optional(),
  shopperRecordDays: optionOrOff(SHOPPER_RECORD_RETENTION_DAYS).optional(),
});

export const ShopifyStoreSettingsPatch = z.object({
  limits: ShopifyStoreLimitsPatch.optional(),
  retention: ShopifyStoreRetentionPatch.optional(),
});
export type ShopifyStoreSettingsPatch = z.infer<typeof ShopifyStoreSettingsPatch>;

/**
 * Merchant-editable try-on modal config. Every field is optional and nullable:
 * absent means "leave whatever is stored", null means "clear back to the
 * Liquid default". Maximums exist so a merchant cannot paste an essay into a
 * 400px-wide modal — over-length is a 400, never a silent truncate.
 */
const widgetText = (max: number) => z.string().max(max).nullable().optional();

export const ShopifyWidgetConfigPatch = z.object({
  theme: z
    .object({
      accentColor: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb hex color')
        .nullable()
        .optional(),
    })
    .optional(),
  copy: z
    .object({
      heading: widgetText(60),
      subheading: widgetText(80),
      uploadTitle: widgetText(80),
      uploadLead: widgetText(160),
      chooseLabel: widgetText(40),
      ctaLabel: widgetText(40),
      legalText: widgetText(300),
      generatingText: widgetText(80),
      errorText: widgetText(160),
    })
    .optional(),
  behavior: z
    .object({
      addToCart: z.boolean().optional(),
      addToCartLabel: widgetText(30),
      share: z.boolean().optional(),
      shareLabel: widgetText(30),
    })
    .optional(),
});
export type ShopifyWidgetConfigPatch = z.infer<typeof ShopifyWidgetConfigPatch>;

/**
 * Event types the storefront widget may report. Deliberately excludes the
 * `refused_*` types: those are written server-side where the refusal is
 * actually decided, and accepting them from a client would let a shopper
 * fabricate the "shoppers you turned away" number a merchant acts on.
 */
export const SHOPIFY_CLIENT_EVENT_TYPES = [
  'button_click',
  'upload',
  'result_view',
  'add_to_cart',
  'share',
] as const;

export const SHOPIFY_REFUSAL_EVENT_TYPES = [
  'refused_store_cap',
  'refused_shopper_cap',
  'refused_email_gate',
] as const;

export const ShopifyWidgetEventRequest = z.object({
  type: z.enum(SHOPIFY_CLIENT_EVENT_TYPES),
  clientId: z.string().uuid().optional(),
  shopifyProductId: z.number().int().positive().optional(),
  device: z.enum(['mobile', 'desktop']).optional(),
});
export type ShopifyWidgetEventRequest = z.infer<typeof ShopifyWidgetEventRequest>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `from` and `to` are bare calendar dates naming days in the STORE's timezone,
 * both inclusive from the merchant's point of view. The server resolves them to
 * instants; see localDayStart.
 */
export const ShopifyAnalyticsQuery = z
  .object({
    from: z.string().regex(ISO_DATE, 'must be YYYY-MM-DD'),
    to: z.string().regex(ISO_DATE, 'must be YYYY-MM-DD'),
  })
  .refine((q) => q.to >= q.from, { message: 'to must not be before from' })
  .refine(
    (q) => {
      // Compared as UTC purely to bound the span — a few hours of timezone
      // skew cannot matter against a 400-day ceiling.
      const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
      return days <= 400;
    },
    { message: 'range must not exceed 400 days' },
  );
export type ShopifyAnalyticsQuery = z.infer<typeof ShopifyAnalyticsQuery>;

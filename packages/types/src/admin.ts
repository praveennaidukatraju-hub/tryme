import { z } from 'zod';
export const AdminRole = z.enum(['SUPER_ADMIN', 'MODERATOR', 'SUPPORT']);
export const GrantCreditsBody = z.object({
  userId: z.string().uuid(),
  amount: z.number().int().positive().max(10_000),
  reason: z.string().max(200).optional(),
});
export const BulkGrantBody = z.object({
  tier: z.string().min(1).max(64),
  amount: z.number().int().positive().max(10_000),
  reason: z.string().min(1).max(200),
});
export const DeductCreditsBody = GrantCreditsBody;
export const UpdateUserBody = z.object({
  tier: z.string().min(1).max(64).optional(),
  maxActiveDevices: z.number().int().min(1).max(50).optional(),
  isBanned: z.boolean().optional(),
  banReason: z.string().max(500).nullable().optional(),
  forceLogout: z.boolean().optional(),
});
export const BulkDeleteUsersBody = z.object({
  ids: z.array(z.string().uuid()).min(1),
});
export const CreateUserBody = z.object({
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9_.]+$/, 'Username may only contain letters, numbers, underscores, and dots'),
  password: z
    .string()
    .min(8)
    .max(128)
    .regex(/[a-zA-Z]/, 'Password must contain at least one letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
  displayName: z.string().min(1).max(80),
  email: z.string().email().max(254).optional(),
  phone: z
    .string()
    .regex(/^\d{10}$/, 'phone must be a 10-digit number')
    .optional(),
  companyName: z.string().max(160).optional(),
});
export const ResetPasswordBody = z.object({
  newPassword: z
    .string()
    .min(8)
    .max(128)
    .regex(/[a-zA-Z]/, 'Password must contain at least one letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
});
export const CategoryTag = z.enum(['featured', 'trending', 'popular']);
export const CreateCategoryBody = z.object({
  typeId: z.number().int().positive(),
  parentId: z.number().int().positive().nullable(),
  slug: z.string().min(1).max(80),
  label: z.string().min(1).max(120),
  genderSlug: z.enum(['men', 'women', 'boys', 'girls']).optional(),
  thumbnailKey: z.string().optional(),
  sortOrder: z.number().int().default(0),
});
export const PatchCategoryBody = z.object({
  label: z.string().min(1).max(120).optional(),
  genderSlug: z.enum(['men', 'women', 'boys', 'girls']).nullable().optional(),
  thumbnailKey: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});
export const BulkCatalogSubcatsBody = z.object({
  ids: z.array(z.string().uuid()).min(1),
  subcategoryIds: z.array(z.string().uuid()),
});
const CoercedPositiveInt = z.union([
  z.number().int().positive(),
  z.string().regex(/^\d+$/).transform(Number),
]);
const CatalogTypeSlug = z.enum(['lower', 'shoe']);

export const PresignCatalogItemBody = z.object({
  typeSlug: CatalogTypeSlug,
  label: z.string().min(1).max(120).optional(),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  // Legacy — still accepted but ignored if typeSlug provided
  categoryId: CoercedPositiveInt.optional(),
});
export const ConfirmCatalogItemBody = z.object({
  typeSlug: CatalogTypeSlug,
  genderSlug: z.enum(['men', 'women', 'boys', 'girls']).nullable().optional(),
  label: z.string().min(1).max(120),
  r2Key: z.string().min(1),
  thumbnailKey: z.string().min(1),
  sortOrder: z.number().int().default(0),
  subcategoryIds: z.array(z.string().uuid()).optional(),
  categoryId: CoercedPositiveInt.optional(),
});
const ResolutionConfig = z.object({
  enabled: z.boolean(),
  creditCost: z.number().int().positive().max(1_000),
});

export const SystemConfigBody = z.object({
  resolutions: z
    .object({
      HD: ResolutionConfig.optional(),
      '2K': ResolutionConfig.optional(),
      '4K': ResolutionConfig.optional(),
    })
    .optional(),
  // Platform-wide ceiling on requested output long edge (px). Not per-workflow —
  // final image resolution is a product/pricing decision, unlike latentMaxPx
  // (per-template, VRAM-bound diffusion canvas size).
  maxOutputPx: z.number().int().min(512).max(4096).optional(),
  // Ceiling on jobs per Studio batch submission (createBatch.ts) — same number
  // GET /v1/catalogues?batchId uses to size its row cap, so the two stay in sync.
  maxBatchJobs: z.number().int().min(1).max(2000).optional(),
  // Ceiling on QUEUED jobs across source IN ('catalog','saree','saree_mannequin') —
  // see assertQueueCapacity in apps/api/src/lib/queue-capacity-config.ts. Exists so
  // a burst of submissions the current worker pool can't drain is rejected up front
  // instead of accepted and left to queue indefinitely.
  maxQueueDepth: z.number().int().min(1).max(5000).optional(),
  // Admin-fixed inputs for merchant catalogue-manager's constrained "flat garment
  // -> catalogue image" generation. Keyed by category so studio-style face/background
  // variety per gender is preserved without per-merchant or per-item picking.
  merchantCatalogDefaults: z
    .record(
      z.enum(['men', 'women', 'boys', 'girls']),
      z.object({
        faceId: z.string().uuid(),
        backgroundId: z.string().uuid(),
        lowerCatalogId: z.string().uuid().optional(),
        shoeCatalogId: z.string().uuid().optional(),
      }),
    )
    .optional(),
  merchantCatalogAspectRatio: z.enum(['1:1', '2:3', '3:4', '4:5']).optional(),
  tryon: z
    .object({
      creditCost: z.number().int().positive().max(1_000),
    })
    .optional(),
  sareeMannequinDev: z
    .object({
      creditCost: z.number().int().positive().max(1_000),
    })
    .optional(),
  pixverse: z.object({ creditCost: z.number().int().positive().max(1_000) }).optional(),
  shopify: z
    .object({
      trialCredits: z.number().int().min(0).max(99999).optional(),
      packCredits: z
        .object({
          pack_10: z
            .object({
              credits: z.number().int().positive().max(1_000_000),
              autorefillCredits: z.number().int().positive().max(1_000_000),
            })
            .partial(),
          pack_25: z
            .object({
              credits: z.number().int().positive().max(1_000_000),
              autorefillCredits: z.number().int().positive().max(1_000_000),
            })
            .partial(),
          pack_50: z
            .object({
              credits: z.number().int().positive().max(1_000_000),
              autorefillCredits: z.number().int().positive().max(1_000_000),
            })
            .partial(),
          pack_100: z
            .object({
              credits: z.number().int().positive().max(1_000_000),
              autorefillCredits: z.number().int().positive().max(1_000_000),
            })
            .partial(),
        })
        .partial()
        .optional(),
    })
    .optional(),
  // Admin-configurable per-surface upload size ceilings. Each replaces a previously
  // hardcoded byte constant (see apps/api/src/lib/upload-limits-config.ts for
  // defaults/readers). Omitted = fall back to the hardcoded default. No minimum
  // floor is enforced deliberately — only a positive integer is required.
  uploadLimits: z
    .object({
      merchantCatalogMaxBytes: z.number().int().positive().max(52_428_800).optional(),
      webGarmentMaxBytes: z.number().int().positive().max(52_428_800).optional(),
      merchantTryonMaxBytes: z.number().int().positive().max(52_428_800).optional(),
      devApiMaxBytes: z.number().int().positive().max(52_428_800).optional(),
      shopifyCatalogSourceMaxBytes: z.number().int().positive().max(52_428_800).optional(),
      shopifyCustomerPhotoMaxBytes: z.number().int().positive().max(52_428_800).optional(),
      shopifyProductImageMaxBytes: z.number().int().positive().max(52_428_800).optional(),
      shopifyProductSyncMaxBytes: z.number().int().positive().max(52_428_800).optional(),
      // Different ceiling: this is a ZIP of many images (admin bulk asset import),
      // not a single photo.
      bulkImportMaxBytes: z.number().int().positive().max(3_221_225_472).optional(),
    })
    .optional(),
  // Seller details printed on every GST invoice (issueInvoiceIfNeeded,
  // apps/api/src/modules/payments/invoice.ts). All optional — invoices
  // render with blank fields until an admin fills these in.
  seller: z
    .object({
      gstin: z.string().max(15).optional(),
      legalName: z.string().max(200).optional(),
      address: z.string().max(500).optional(),
      pan: z.string().max(15).optional(),
      tan: z.string().max(15).optional(),
      udyamRegNo: z.string().max(30).optional(),
    })
    .optional(),
});

// ── Model asset upload schemas ────────────────────────────────────────────

export const AssetContentType = z.enum(['image/jpeg', 'image/png', 'image/webp']);
const GenderEnum = z.enum(['men', 'women', 'boys', 'girls']);

// Studio "Choose AI Model" picker groups faces by continent. Null/omitted =
// unassigned, shown under the "Global" bucket until an admin categorizes it.
// Continents are admin-defined slugs, not a fixed enum -- admins can add new
// ones from the admin UI (Faces tab) without a migration.
export const ContinentSlug = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(
    /^[a-z0-9]+(_[a-z0-9]+)*$/,
    'continent must be lowercase letters, numbers, and underscores',
  );

export const PresignModelFaceBody = z.object({
  contentType: AssetContentType,
});
/**
 * Opts an asset into the public developer API and names it there.
 *
 * null / omitted-as-null = withdraw the asset from /v1/dev/*. Setting a value is a
 * publishing action: third-party integrations will hard-code it, so treat a rename
 * as a breaking change for those callers rather than a cosmetic edit.
 */
export const PublicApiSlugField = z
  .union([
    // A cleared admin form field submits '' rather than null. Accept it and
    // normalize below, so "withdraw this asset" works from the UI without every
    // route handler having to special-case the empty string.
    z.literal(''),
    z
      .string()
      .min(1)
      .max(64)
      .regex(
        /^[a-z0-9]+(-[a-z0-9]+)*$/,
        'must be lowercase alphanumeric words separated by hyphens',
      ),
  ])
  .nullable()
  .optional()
  .transform((v) => (v === '' ? null : v));

export const ConfirmModelFaceBody = z.object({
  label: z.string().min(1).max(120),
  gender: GenderEnum,
  continent: ContinentSlug.nullable().optional(),
  r2Key: z.string().min(1),
  thumbnailKey: z.string().min(1),
  faceSideR2Key: z.string().min(1).optional(),
  sortOrder: z.number().int().default(0),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  publicApiSlug: PublicApiSlugField,
});

export const PatchModelFaceBody = z.object({
  label: z.string().min(1).max(120).optional(),
  gender: GenderEnum.optional(),
  continent: ContinentSlug.nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  r2Key: z.string().optional(),
  thumbnailKey: z.string().optional(),
  faceSideR2Key: z.string().nullable().optional(),
  publicApiSlug: PublicApiSlugField,
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
});

// Backgrounds are now global — no faceId
export const PresignModelBackgroundBody = z.object({
  contentType: AssetContentType,
});
export const ConfirmModelBackgroundBody = z.object({
  label: z.string().min(1).max(120),
  r2Key: z.string().min(1),
  bgComfyR2Key: z.string().min(1).optional(),
  sortOrder: z.number().int().default(0),
  genderSlug: GenderEnum.optional(),
  isWhiteBg: z.boolean().optional(),
  categoryId: CoercedPositiveInt.nullable().optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  specialTag: CategoryTag.nullable().optional(),
  // 'template' = uploaded from a catalogue template's looks builder — hidden from the
  // admin Backgrounds tab and studio "create your own look". Defaults to 'general'.
  scope: z.enum(['general', 'template']).optional(),
});
export const PatchModelBackgroundBody = z.object({
  label: z.string().min(1).max(120).optional(),
  genderSlug: GenderEnum.nullable().optional(),
  isActive: z.boolean().optional(),
  isWhiteBg: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  r2Key: z.string().optional(),
  bgComfyR2Key: z.string().nullable().optional(),
  categoryId: CoercedPositiveInt.nullable().optional(),
  specialTag: CategoryTag.nullable().optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  publicApiSlug: PublicApiSlugField,
});

export const PresignSampleVideoBody = z.object({
  videoContentType: z.literal('video/mp4'),
  // Thumbnail is always a client-generated animated preview GIF (see gif.ts) — no
  // manual poster upload, so this is fixed rather than reusing the image AssetContentType enum.
  thumbnailContentType: z.literal('image/gif'),
});
export const ConfirmSampleVideoBody = z.object({
  title: z.string().min(1).max(120),
  videoR2Key: z.string().min(1),
  thumbnailR2Key: z.string().min(1),
  prompt: z.string().min(1).max(5000),
  sortOrder: z.number().int().default(0),
});
export const PatchSampleVideoBody = z.object({
  title: z.string().min(1).max(120).optional(),
  prompt: z.string().min(1).max(5000).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const PresignAppVideoBody = z.object({
  contentType: z.literal('video/mp4'),
});

// ── Workflow template schemas ─────────────────────────────────────────────

export const CreateWorkflowBody = z
  .object({
    slug: z
      .string()
      .regex(
        /^[a-z0-9_]+$/,
        'Slug must be snake_case (lowercase letters, digits, underscores only)',
      ),
    label: z.string().min(1).max(120),
    jsonContent: z.record(z.any()),
    workflowType: z
      .enum(['regular', 'tryon', 'saree_step1', 'saree_step1_two_input', 'two_stage'])
      .default('regular'),
    // Regular workflow fields (required when workflowType = 'regular')
    faceNodeId: z.string().min(1).optional(),
    poseNodeId: z.string().min(1).optional(),
    bgNodeId: z.string().min(1).optional(),
    // No .min(1) here — an empty array is how the client represents a
    // lower-only workflow (upperNodeIds omitted in favor of lowerNodeId).
    // "at least one garment role" is enforced below by superRefine instead.
    upperNodeIds: z.array(z.string().min(1)).max(8).optional(),
    lowerNodeId: z.string().min(1).optional(),
    shoeNodeId: z.string().min(1).optional(),
    thirdNodeId: z.string().min(1).optional(),
    sizeNodeIds: z.array(z.string().min(1)).optional(),
    // Dual-size-group templates (build_model_main v2+) — server-computed from node
    // titles at parse time, not manually edited via the admin form.
    latentSizeNodeIds: z.array(z.string().min(1)).length(2).optional(),
    latentMaxPx: z.number().int().positive().optional(),
    outputSizeNodeIds: z.array(z.string().min(1)).length(2).optional(),
    outputMaxPx: z.number().int().positive().optional(),
    resultNodeId: z.string().min(1).optional(),
    facePhasePromptNode: z.string().min(1).optional(),
    garmentPhasePromptNode: z.string().min(1).optional(),
    // Tryon workflow fields (required when workflowType = 'tryon')
    tryonPersonNodeId: z.string().min(1).optional(),
    tryonGarmentNodeId: z.string().min(1).optional(),
    tryonGarmentNodeId2: z.string().min(1).optional(),
    tryonOutputNodeId: z.string().min(1).optional(),
    // Two-stage workflow fields (required when workflowType = 'two_stage'). Stage 2's
    // prompt pair reuses facePhasePromptNode (negative) / garmentPhasePromptNode
    // (positive) above — same convention as tryon/saree — so only stage 1 needs its
    // own dedicated fields.
    stage1PositivePromptNode: z.string().min(1).optional(),
    stage1NegativePromptNode: z.string().min(1).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.workflowType === 'two_stage') {
      for (const field of [
        'faceNodeId',
        'poseNodeId',
        'bgNodeId',
        'facePhasePromptNode',
        'garmentPhasePromptNode',
        'stage1PositivePromptNode',
        'stage1NegativePromptNode',
      ] as const) {
        if (!val[field]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} is required for two_stage workflows`,
          });
        }
      }
      if ((val.upperNodeIds?.length ?? 0) === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['upperNodeIds'],
          message: 'garment node is required for two_stage workflows',
        });
      }
      return;
    }
    if (
      val.workflowType === 'tryon' ||
      val.workflowType === 'saree_step1' ||
      val.workflowType === 'saree_step1_two_input'
    ) {
      for (const field of ['facePhasePromptNode', 'garmentPhasePromptNode'] as const) {
        if (!val[field]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} is required for ${val.workflowType} workflows`,
          });
        }
      }
      return;
    }
    if (!val.poseNodeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['poseNodeId'],
        message: 'poseNodeId is required for regular workflows',
      });
    }
    if (!val.garmentPhasePromptNode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['garmentPhasePromptNode'],
        message: 'garmentPhasePromptNode is required for regular workflows',
      });
    }
    const hasUpper = (val.upperNodeIds?.length ?? 0) > 0;
    const hasLower = !!val.lowerNodeId;
    if (!hasUpper && !hasLower) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['upperNodeIds'],
        message: 'at least one garment role (upperNodeIds or lowerNodeId) is required',
      });
    }
    if (val.faceNodeId && !val.facePhasePromptNode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['facePhasePromptNode'],
        message: 'facePhasePromptNode is required when faceNodeId is set',
      });
    }
  });

export const ReplaceWorkflowBody = z.intersection(
  CreateWorkflowBody,
  z.object({
    password: z.string().min(1, 'password is required to replace a workflow'),
  }),
);

export const ParseWorkflowBody = z.object({
  jsonContent: z.record(z.any()),
  workflowType: z
    .enum(['regular', 'tryon', 'saree_step1', 'saree_step1_two_input', 'two_stage'])
    .optional(),
});

export const UpdateWorkflowBody = z.object({
  label: z.string().min(1).max(120).optional(),
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9_]+$/, 'slug must be lowercase alphanumeric with underscores')
    .optional(),
  isActive: z.boolean().optional(),
  // Regular workflow node mappings (not the JSON itself)
  faceNodeId: z.string().min(1).optional(),
  poseNodeId: z.string().min(1).optional(),
  bgNodeId: z.string().min(1).optional(),
  // No .min(1) here — [] is how the client clears/represents "no upper role",
  // e.g. converting to lower-only. The route handler enforces "at least one
  // garment role remains" using the merged upperNodeIds/lowerNodeId together.
  upperNodeIds: z.array(z.string().min(1)).max(8).optional(),
  lowerNodeId: z.string().min(1).nullable().optional(),
  shoeNodeId: z.string().min(1).nullable().optional(),
  thirdNodeId: z.string().min(1).nullable().optional(),
  sizeNodeId: z.string().min(1).nullable().optional(),
  sizeNodeIds: z.array(z.string().min(1)).optional(),
  latentSizeNodeIds: z.array(z.string().min(1)).length(2).optional(),
  latentMaxPx: z.number().int().positive().optional(),
  outputSizeNodeIds: z.array(z.string().min(1)).length(2).optional(),
  outputMaxPx: z.number().int().positive().optional(),
  resultNodeId: z.string().min(1).nullable().optional(),
  facePhasePromptNode: z.string().min(1).optional(),
  garmentPhasePromptNode: z.string().min(1).optional(),
  stage1PositivePromptNode: z.string().min(1).optional(),
  stage1NegativePromptNode: z.string().min(1).optional(),
  // Prompt TEXT (not which node holds it — see facePhasePromptNode/garmentPhasePromptNode
  // above for that). No .min(1) here on purpose: emptiness rules differ per field and are
  // enforced in the route handler (garmentPhasePrompt must be non-empty, facePhasePrompt may
  // be empty).
  garmentPhasePrompt: z.string().optional(),
  facePhasePrompt: z.string().optional(),
  // Admin-curated (reason -> alternate prompt) pairs offered on regenerate —
  // same graph, different prompt text chosen by the reason the user picked.
  // A blank prompt is valid and deliberate: it means "no override configured
  // yet" for that reason, so regenerateJob() falls back to rerunning the
  // original prompt (see DEFAULT_REGENERATION_REASON_PROMPTS below, which
  // ships every new/not-yet-configured workflow with 5 reasons and blank
  // prompts).
  // Prompt has no length cap — these are often a full original prompt plus
  // added corrective clauses, which can run well past a short user-hint's
  // length; reason is a short label shown verbatim in the reason picker.
  regenerationReasonPrompts: z
    .array(z.object({ reason: z.string().min(1).max(100), prompt: z.string() }))
    .max(50)
    .optional(),
  // Same TEXT vs node-id-column distinction as above, for two_stage's own stage-1
  // pair. stage1PositivePrompt must be non-empty (same reason as garmentPhasePrompt);
  // stage1NegativePrompt may be empty (same as facePhasePrompt).
  stage1PositivePrompt: z.string().optional(),
  stage1NegativePrompt: z.string().optional(),
  // KSampler settings — targeted by node ID rather than "the" KSampler, since a
  // workflow can have more than one (two_stage: build-person + dress-garment each
  // have their own). steps<1 means no generation happens; denoise is bounded to its
  // defined semantic range [0,1]; cfg has no fixed ceiling since it varies by
  // model/LoRA; seed has no ceiling either (ComfyUI accepts any non-negative int).
  ksamplerOverrides: z
    .array(
      z.object({
        nodeId: z.string().min(1),
        steps: z.number().int().min(1).optional(),
        cfg: z.number().min(0).optional(),
        denoise: z.number().min(0).max(1).optional(),
        seed: z.number().int().min(0).optional(),
      }),
    )
    .optional(),
  // Tryon workflow node IDs
  tryonPersonNodeId: z.string().min(1).nullable().optional(),
  tryonGarmentNodeId: z.string().min(1).nullable().optional(),
  tryonGarmentNodeId2: z.string().min(1).nullable().optional(),
  tryonOutputNodeId: z.string().min(1).nullable().optional(),
});

// Seeded onto every newly-created workflow template (POST /admin/workflows
// only — never on /replace, which must never overwrite an already-curated
// list) so the regenerate reason picker is never empty for a brand-new
// workflow. Blank prompts mean "no override yet"; an admin fills them in
// later from the workflow's edit screen. Existing pre-this-feature workflows
// were backfilled once via migration 0178_seed_default_regen_reasons.
export const DEFAULT_REGENERATION_REASON_PROMPTS: { reason: string; prompt: string }[] = [
  { reason: 'Multiple body parts', prompt: '' },
  { reason: 'Nudity', prompt: '' },
  { reason: 'Draping issue', prompt: '' },
  { reason: 'Additional assets', prompt: '' },
  { reason: 'Texture issue', prompt: '' },
];

export const ReassignWorkflowBody = z.object({
  targetWorkflowId: z.string().uuid(),
});

// ── Pose schemas ──────────────────────────────────────────────────────────

// Poses are per (garment type × face × background) combo, e.g. m1bg1p1
export const PresignModelPoseBody = z
  .object({
    garmentTypeId: z.string().uuid(),
    // Exactly one of faceId (existing) or newFaceContentType (upload new)
    faceId: z.string().uuid().optional(),
    newFaceContentType: AssetContentType.optional(),
    // Exactly one of backgroundId (existing) or newBgContentType (upload new)
    backgroundId: z.string().uuid().optional(),
    newBgContentType: AssetContentType.optional(),
    // Pose body image
    contentType: AssetContentType,
    // Side/tilt face for ComfyUI (optional — batch uploads omit this and the processor falls back to the display face)
    faceSideContentType: AssetContentType.optional(),
    // Per-pose background image for ComfyUI (optional — batch uploads omit this and the processor falls back to the display background)
    bgComfyContentType: AssetContentType.optional(),
  })
  .refine((d) => Boolean(d.faceId) !== Boolean(d.newFaceContentType), {
    message: 'Provide either faceId or newFaceContentType, not both',
    path: ['faceId'],
  })
  .refine((d) => Boolean(d.backgroundId) !== Boolean(d.newBgContentType), {
    message: 'Provide either backgroundId or newBgContentType, not both',
    path: ['backgroundId'],
  });

export const ConfirmModelPoseBody = z
  .object({
    garmentTypeId: z.string().uuid(),
    // Exactly one of faceId (existing) or newFace (inline upload)
    faceId: z.string().uuid().optional(),
    newFace: z
      .object({
        r2Key: z.string().min(1),
        thumbnailKey: z.string().min(1),
        filename: z.string().min(1),
      })
      .optional(),
    // Exactly one of backgroundId (existing) or newBackground (inline upload)
    backgroundId: z.string().uuid().optional(),
    newBackground: z
      .object({
        r2Key: z.string().min(1),
        thumbnailKey: z.string().min(1),
        filename: z.string().min(1),
      })
      .optional(),
    // Pose body image
    label: z.string().min(1).max(120),
    r2Key: z.string().min(1),
    thumbnailKey: z.string().min(1),
    // Side/tilt face (optional — if absent the processor falls back to the display face r2Key)
    faceSideR2Key: z.string().min(1).optional(),
    // Per-pose background for ComfyUI (optional — if absent the processor falls back to the display background)
    bgComfyR2Key: z.string().min(1).optional(),
    // Workflow — now a UUID FK instead of an enum string
    workflowTemplateId: z.string().uuid(),
    // Optional — if absent or empty the workflow template's own prompt text is used
    promptFacePhase: z.string().optional(),
    promptGarmentPhase: z.string().optional(),
    sortOrder: z.number().int().default(0),
  })
  .refine((d) => Boolean(d.faceId) !== Boolean(d.newFace), {
    message: 'Provide either faceId or newFace, not both',
    path: ['faceId'],
  })
  .refine((d) => Boolean(d.backgroundId) !== Boolean(d.newBackground), {
    message: 'Provide either backgroundId or newBackground, not both',
    path: ['backgroundId'],
  });

export const ClonePoseBody = z.object({
  targetGarmentTypeIds: z.array(z.string().uuid()).min(1),
});
export const ClonePosesBulkBody = z.object({
  poseIds: z.array(z.string().uuid()).min(1),
  targetGarmentTypeIds: z.array(z.string().uuid()).min(1),
});

export const PatchModelPoseBody = z.object({
  label: z.string().min(1).max(120).optional(),
  faceId: z.string().uuid().optional(),
  backgroundId: z.string().uuid().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  showsLower: z.boolean().optional(),
  showsShoes: z.boolean().optional(),
  workflowTemplateId: z.string().uuid().optional(),
  promptFacePhase: z.string().optional(),
  promptGarmentPhase: z.string().optional(),
  /** Updated after re-uploading the side/tilt face via presign-faceside */
  faceSideR2Key: z.string().min(1).optional(),
  /** Updated after re-uploading the pose image via presign-pose */
  r2Key: z.string().min(1).optional(),
  thumbnailKey: z.string().min(1).optional(),
  /** Updated after re-uploading the ComfyUI background via presign-bgcomfy */
  bgComfyR2Key: z.string().min(1).optional(),
});

// Garment types (formerly subcategories)
export const CreateGarmentTypeBody = z.object({
  genderSlug: GenderEnum,
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens'),
  label: z.string().min(1).max(120),
  // Omitted = append at the end (server computes max(sortOrder) + 1 for this
  // gender). Provided = insert at that position, shifting anything already
  // there (and after) up by one - see the route handler.
  sortOrder: z.number().int().optional(),
  thumbnailKey: z.string().optional(),
  requiresLowerUpload: z.boolean().optional().default(false),
  requiresThirdUpload: z.boolean().optional().default(false),
  tryonCategoryId: z.string().uuid().nullable().optional(),
});
export const PatchGarmentTypeBody = z.object({
  label: z.string().min(1).max(120).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  thumbnailKey: z.string().nullable().optional(),
  requiresLowerUpload: z.boolean().optional(),
  upperUploadLabel: z.string().max(80).nullable().optional(),
  lowerUploadLabel: z.string().max(80).nullable().optional(),
  requiresThirdUpload: z.boolean().optional(),
  thirdUploadLabel: z.string().max(80).nullable().optional(),
  defaultLowerCatalogId: z.string().uuid().nullable().optional(),
  defaultShoeCatalogId: z.string().uuid().nullable().optional(),
  tryonCategoryId: z.string().uuid().nullable().optional(),
  instructionImageKey: z.string().nullable().optional(),
  defaultPoseId: z.string().uuid().nullable().optional(),
  requiresMannequinStep: z.boolean().optional(),
  mannequinWorkflowTemplateId: z.string().uuid().nullable().optional(),
  sareeStep2WorkflowTemplateId: z.string().uuid().nullable().optional(),
  mannequinTwoInputWorkflowTemplateId: z.string().uuid().nullable().optional(),
  twoInputTryonWorkflowTemplateId: z.string().uuid().nullable().optional(),
  publicApiSlug: PublicApiSlugField,
});
export const PresignGarmentTypeBody = z.object({
  contentType: AssetContentType,
});
export const PresignGarmentTypeInstructionBody = z.object({
  contentType: AssetContentType,
});

// ── Catalogue template schemas ────────────────────────────────────────────

export const CreateCatalogueTemplateBody = z.object({
  genderSlug: GenderEnum,
  label: z.string().min(1).max(120),
  thumbnailKey: z.string().optional(),
  sortOrder: z.number().int().default(0),
});
export const PatchCatalogueTemplateBody = z.object({
  label: z.string().min(1).max(120).optional(),
  thumbnailKey: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});
export const PutCatalogueTemplateLooksBody = z.object({
  looks: z
    .array(
      z.object({
        poseAssetId: z.string().uuid(),
        backgroundId: z.string().uuid(),
        // Optional: retags the pose's shot type in place (no re-upload needed).
        // Omitted/undefined leaves the pose's existing shot_type untouched.
        shotType: z.enum(['full', 'half', 'closeup']).optional(),
      }),
    )
    .max(20),
});
export const PresignCatalogueTemplateThumbnailBody = z.object({
  contentType: AssetContentType,
});

export const AdminHeldJobsResponse = z.object({
  total: z.number().int(),
  byUser: z.array(
    z.object({
      userId: z.string().uuid().nullable(),
      email: z.string().nullable(),
      count: z.number().int(),
      oldestCreatedAt: z.string(),
    }),
  ),
});
export type AdminHeldJobsResponse = z.infer<typeof AdminHeldJobsResponse>;

export const AdminHeldJobsReleaseResponse = z.object({
  released: z.number().int(),
  remaining: z.number().int(),
});
export type AdminHeldJobsReleaseResponse = z.infer<typeof AdminHeldJobsReleaseResponse>;

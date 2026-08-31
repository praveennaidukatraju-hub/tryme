import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { catalogCategories, catalogItems } from './catalog.js';
import { users } from './users.js';

export const modelFaces = pgTable('model_faces', {
  id: uuid('id').primaryKey().defaultRandom(),
  gender: text('gender').notNull(), // 'men' | 'women' | 'boys' | 'girls'
  label: text('label').notNull(),
  // Free-form slug (lowercase letters/digits/underscores), admin-defined — not a
  // fixed enum, so admins can add new continents from the admin UI. Null = unassigned;
  // shown under the "Global" bucket in the studio model picker. See ContinentSlug in
  // @tryme/types.
  continent: text('continent'),
  r2Key: text('r2_key').notNull(),
  thumbnailKey: text('thumbnail_key').notNull(),
  faceSideR2Key: text('face_side_r2_key'), // ComfyUI-specific face image (moved from model_pose_assets)
  tags: text('tags').array().notNull().default(sql`ARRAY[]::text[]`), // free-form entity tags, e.g. "warm tone", "closeup"
  // Public developer-API exposure. NULL = not reachable from /v1/dev/*; non-null =
  // exposed to third-party API callers under this slug. Curation flag and public
  // identifier in one column so they cannot drift apart. Partial-unique among
  // non-null values only — see migration 0130.
  publicApiSlug: text('public_api_slug'),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Global pool — no faceId FK
export const modelBackgrounds = pgTable(
  'model_backgrounds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    label: text('label').notNull(),
    r2Key: text('r2_key').notNull(),
    thumbnailKey: text('thumbnail_key').notNull(),
    bgComfyR2Key: text('bg_comfy_r2_key'), // ComfyUI-specific background (moved from model_pose_assets)
    categoryId: integer('category_id').references(() => catalogCategories.id), // nullable — null means uncategorized (pre-existing backgrounds)
    tags: text('tags').array().notNull().default(sql`ARRAY[]::text[]`), // free-form entity tags, independent of category (e.g. "warm tone")
    specialTag: text('special_tag'), // 'featured' | 'trending' | 'popular' | null — per-asset, moved off category level
    genderSlug: text('gender_slug'), // nullable — null means shown for all genders
    // 'general' = visible in the admin Backgrounds tab and studio "create your own look";
    // 'template' = uploaded from within a catalogue template's looks builder, hidden from
    // both (managed only via the template that owns it); 'user' = uploaded by a user into
    // their own personal library (studio "create your own look" -> "My backgrounds"), scoped
    // by userId below, hidden from everyone else and from the admin-curated pool. See scope
    // column on modelPoseAssets.
    scope: text('scope').notNull().default('general'),
    // Only set when scope='user' — the owning user. ON DELETE CASCADE so a deleted user's
    // private backgrounds are cleaned up automatically.
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    // See modelFaces.publicApiSlug.
    publicApiSlug: text('public_api_slug'),
    isActive: boolean('is_active').notNull().default(true),
    isWhiteBg: boolean('is_white_bg').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('model_backgrounds_user_id_idx')
      .on(table.userId)
      .where(sql`${table.userId} is not null`),
  }),
);

// Admin-curated PixVerse video templates. Each row is a sample clip shown to
// the user as a picker option; its prompt is what gets sent to PixVerse.
export const sampleVideos = pgTable('sample_videos', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  videoR2Key: text('video_r2_key').notNull(),
  thumbnailR2Key: text('thumbnail_r2_key').notNull(),
  prompt: text('prompt').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// e.g. { genderSlug: 'men', slug: 'fullsleeveshirt', label: 'Full Sleeve Shirt' }
export const garmentSubcategories = pgTable('garment_subcategories', {
  id: uuid('id').primaryKey().defaultRandom(),
  genderSlug: text('gender_slug').notNull(),
  slug: text('slug').notNull(),
  // Deliberately NOT the `slug` above: that one is internal, non-unique (per-gender),
  // and Studio-facing, so an internal rename would silently break a third-party
  // integration. See modelFaces.publicApiSlug.
  publicApiSlug: text('public_api_slug'),
  label: text('label').notNull(),
  thumbnailKey: text('thumbnail_key'),
  instructionImageKey: text('instruction_image_key'),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  requiresLowerUpload: boolean('requires_lower_upload').notNull().default(false),
  upperUploadLabel: text('upper_upload_label'),
  lowerUploadLabel: text('lower_upload_label'),
  requiresThirdUpload: boolean('requires_third_upload').notNull().default(false),
  thirdUploadLabel: text('third_upload_label'),
  defaultLowerCatalogId: uuid('default_lower_catalog_id').references(() => catalogItems.id, {
    onDelete: 'set null',
  }),
  defaultShoeCatalogId: uuid('default_shoe_catalog_id').references(() => catalogItems.id, {
    onDelete: 'set null',
  }),
  // FK to tryon_categories.id enforced in SQL only — see migration 0074. Not a
  // typed drizzle reference to avoid a circular import with schema/tryon.ts.
  tryonCategoryId: uuid('tryon_category_id'),
  // Admin-fixed pose used by merchant catalogue-manager's constrained "flat garment
  // -> catalogue image" generation. Null = generation unavailable for this type.
  defaultPoseId: uuid('default_pose_id'),
  // Flat Saree (and any future two-pass garment type): gates a one-time,
  // 0-credit "mannequin" generation job before the normal per-pose jobs run.
  // See docs/superpowers/specs/2026-07-14-flat-saree-two-step-workflow-design.md.
  requiresMannequinStep: boolean('requires_mannequin_step').notNull().default(false),
  // Step-1 workflow: drapes the uploaded garment onto the selected face, once per job.
  mannequinWorkflowTemplateId: uuid('mannequin_workflow_template_id').references(
    () => workflowTemplates.id,
    { onDelete: 'set null' },
  ),
  // Step-2 workflow: used for EVERY pose in a job for this garment type, overriding
  // the normal per-pose pose_garment_configs/model_pose_assets.workflowTemplateId lookup.
  sareeStep2WorkflowTemplateId: uuid('saree_step2_workflow_template_id').references(
    () => workflowTemplates.id,
    { onDelete: 'set null' },
  ),
  // Optional second step-1 workflow: takes two garment images (body + pallu)
  // instead of one. Presence of this column is what gates the studio wizard's
  // "Full Saree / Body & Pallu" upload-mode dropdown for this garment type.
  // See docs/superpowers/specs/2026-07-29-saree-two-input-upload-design.md.
  mannequinTwoInputWorkflowTemplateId: uuid('mannequin_two_input_workflow_template_id').references(
    () => workflowTemplates.id,
    { onDelete: 'set null' },
  ),
  // Independent of mannequinTwoInputWorkflowTemplateId above (that one drives catalogue-
  // image GENERATION from a model-gallery face; this one drives DIRECT customer try-on
  // from a merchant catalog item that has a second/pallu image, patching the real
  // customer photo — not a model face — into the same person-node role). See
  // resolveTryonGarment.ts and docs/superpowers/plans/
  // 2026-08-20-merchant-catalog-two-input-direct-tryon.md.
  twoInputTryonWorkflowTemplateId: uuid('two_input_tryon_workflow_template_id').references(
    () => workflowTemplates.id,
    { onDelete: 'set null' },
  ),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Workflow templates — defined BEFORE modelPoses because modelPoses has a FK to this table
export const workflowTemplates = pgTable('workflow_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  label: text('label').notNull(),
  jsonContent: jsonb('json_content').notNull().$type<Record<string, unknown>>(),

  // Node ID mappings (ComfyUI node IDs as strings — may contain colons e.g. "1345:111")
  faceNodeId: text('face_node_id'),
  poseNodeId: text('pose_node_id').notNull(),
  bgNodeId: text('bg_node_id'),
  upperNodeIds: text('upper_node_ids').array().notNull(),
  lowerNodeId: text('lower_node_id'), // nullable — some workflows have no lower garment
  shoeNodeId: text('shoe_node_id'), // nullable — some workflows have no shoe garment
  thirdNodeId: text('third_node_id'), // nullable — a 3rd, generically-named uploaded garment role
  sizeNodeId: text('size_node_id'), // kept for backward compat — use sizeNodeIds
  sizeNodeIds: text('size_node_ids').array().notNull().default(sql`ARRAY[]::text[]`), // all nodes controlling output dimensions

  // Dual-size-group templates (build_model_main v2+) — both groups derive their width/height
  // from the same aspectRatio enum, just at different max edges. Empty = use sizeNodeIds above.
  latentSizeNodeIds: text('latent_size_node_ids').array().notNull().default(sql`ARRAY[]::text[]`), // [widthNodeId, heightNodeId]
  latentMaxPx: integer('latent_max_px').notNull().default(2048),
  outputSizeNodeIds: text('output_size_node_ids').array().notNull().default(sql`ARRAY[]::text[]`), // [widthNodeId, heightNodeId]
  outputMaxPx: integer('output_max_px').notNull().default(2048), // matches latentMaxPx by default — full resolution, not downscaled
  resultNodeId: text('result_node_id'), // SaveImage node holding the final deliverable image, when ambiguous

  // Prompt node IDs
  facePhasePromptNode: text('face_phase_prompt_node'),
  garmentPhasePromptNode: text('garment_phase_prompt_node').notNull(),
  // 'two_stage' only — the person-build stage's own prompt pair, distinct from
  // facePhasePromptNode/garmentPhasePromptNode which (for this type) hold the
  // second, garment-dressing stage's negative/positive nodes. Two-stage graphs
  // run a person-build KSampler followed by a separate garment-dress KSampler
  // in one ComfyUI submission; each stage's prompt is independently editable.
  stage1PositivePromptNode: text('stage1_positive_prompt_node'),
  stage1NegativePromptNode: text('stage1_negative_prompt_node'),

  // Default prompts extracted from JSON at upload time
  defaultFacePhasePrompt: text('default_face_phase_prompt').notNull().default(''),
  defaultGarmentPhasePrompt: text('default_garment_phase_prompt').notNull().default(''),
  defaultStage1PositivePrompt: text('default_stage1_positive_prompt').notNull().default(''),
  defaultStage1NegativePrompt: text('default_stage1_negative_prompt').notNull().default(''),

  // Admin-curated (reason -> alternate prompt) pairs offered when a user
  // regenerates a result produced by this template — same graph, different
  // prompt text chosen by which reason the user picked. The user's submitted
  // reason string is matched exactly against `reason` here; no match (e.g. the
  // user picked "Other") falls back to rerunning the original prompt unchanged
  // (see regenerateJob in apps/api). Empty array = no alternates configured.
  regenerationReasonPrompts: jsonb('regeneration_reason_prompts')
    .notNull()
    .default(sql`'[]'::jsonb`)
    .$type<{ reason: string; prompt: string }[]>(),

  // 'regular' = catalogue-creation (pose-based) workflows; 'tryon' = person + garment
  // try-on workflows, used by both the studio Try-On feature and kiosk.
  workflowType: text('workflow_type').notNull().default('regular'), // 'regular' | 'tryon'

  // Tryon workflow node IDs — only set when workflowType = 'tryon'
  tryonPersonNodeId: text('tryon_person_node_id'),
  tryonGarmentNodeId: text('tryon_garment_node_id'),
  // Second garment node (pallu) — only set when workflowType = 'saree_step1_two_input'.
  // tryonGarmentNodeId carries the body image in that case.
  tryonGarmentNodeId2: text('tryon_garment_node_id_2'),
  tryonOutputNodeId: text('tryon_output_node_id'),

  // Bumped by 1 on every confirmed "replace" (POST /admin/workflows/:id/replace).
  // Jobs stamp the version they resolved at creation time into
  // job_inputs.params.dispatchTemplateVersion; the dispatcher compares that
  // stamp against this column to decide whether to use this row's live
  // content or an archived one. See docs/superpowers/specs/
  // 2026-08-26-workflow-template-replace-design.md.
  version: integer('version').notNull().default(1),

  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Holds at most one archived (draining) version per template — enforced by the
// unique index below, not just application logic. A row here means "this
// template has a replace in progress; jobs stamped with this version should
// resolve against this row's content, not workflow_templates' live row."
// Deleted once no non-terminal job references it (see
// apps/dispatcher/src/workflow/drain-cleanup.ts).
export const workflowTemplateArchives = pgTable(
  'workflow_template_archives',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowTemplateId: uuid('workflow_template_id')
      .notNull()
      .references(() => workflowTemplates.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    jsonContent: jsonb('json_content').notNull().$type<Record<string, unknown>>(),
    faceNodeId: text('face_node_id'),
    poseNodeId: text('pose_node_id').notNull(),
    bgNodeId: text('bg_node_id'),
    upperNodeIds: text('upper_node_ids').array().notNull(),
    lowerNodeId: text('lower_node_id'),
    shoeNodeId: text('shoe_node_id'),
    thirdNodeId: text('third_node_id'),
    sizeNodeId: text('size_node_id'),
    sizeNodeIds: text('size_node_ids').array().notNull().default(sql`ARRAY[]::text[]`),
    latentSizeNodeIds: text('latent_size_node_ids').array().notNull().default(sql`ARRAY[]::text[]`),
    latentMaxPx: integer('latent_max_px').notNull().default(2048),
    outputSizeNodeIds: text('output_size_node_ids').array().notNull().default(sql`ARRAY[]::text[]`),
    outputMaxPx: integer('output_max_px').notNull().default(2048),
    resultNodeId: text('result_node_id'),
    facePhasePromptNode: text('face_phase_prompt_node'),
    garmentPhasePromptNode: text('garment_phase_prompt_node').notNull(),
    stage1PositivePromptNode: text('stage1_positive_prompt_node'),
    stage1NegativePromptNode: text('stage1_negative_prompt_node'),
    defaultFacePhasePrompt: text('default_face_phase_prompt').notNull().default(''),
    defaultGarmentPhasePrompt: text('default_garment_phase_prompt').notNull().default(''),
    defaultStage1PositivePrompt: text('default_stage1_positive_prompt').notNull().default(''),
    defaultStage1NegativePrompt: text('default_stage1_negative_prompt').notNull().default(''),
    workflowType: text('workflow_type').notNull().default('regular'),
    tryonPersonNodeId: text('tryon_person_node_id'),
    tryonGarmentNodeId: text('tryon_garment_node_id'),
    tryonGarmentNodeId2: text('tryon_garment_node_id_2'),
    tryonOutputNodeId: text('tryon_output_node_id'),
    archivedAt: timestamp('archived_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // At most one archived (draining) version per template — a second
    // concurrent replace on the same template must fail, not silently create
    // a second archive row the drain-cleanup logic would have to disambiguate.
    oneActiveArchivePerTemplate: unique('workflow_template_archives_template_unique').on(
      t.workflowTemplateId,
    ),
    byTemplateVersion: index('workflow_template_archives_template_version_idx').on(
      t.workflowTemplateId,
      t.version,
    ),
  }),
);

// Merchant-catalogue mannequin drape styles — orthogonal to garment_subcategories.
// Any style can generate any saree-eligible garment subcategory; each style just
// points at a different step-1 (mannequin) workflow template (different prompt/
// LoRA weights). See docs/superpowers/specs/2026-07-21-saree-mannequin-style-selection-design.md.
export const sareeMannequinStyles = pgTable('saree_mannequin_styles', {
  id: uuid('id').primaryKey().defaultRandom(),
  label: text('label').notNull(),
  previewImageKey: text('preview_image_key'),
  mannequinWorkflowTemplateId: uuid('mannequin_workflow_template_id')
    .notNull()
    .references(() => workflowTemplates.id),
  // Optional second workflow for the "Body & Pallu" two-input upload mode —
  // when set, this style can be picked for either mode; when null, the style
  // is single-input only and two-input requests must fall back to the
  // garment type's own mannequinTwoInputWorkflowTemplateId instead.
  mannequinTwoInputWorkflowTemplateId: uuid('mannequin_two_input_workflow_template_id').references(
    () => workflowTemplates.id,
  ),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Centralised pose image asset — single source of truth for poses, filtered by genderSlug.
// Replaces model_poses: no longer tied to garment type mappings.
export const modelPoseAssets = pgTable('model_pose_assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  label: text('label').notNull(),
  displayName: text('display_name'),
  poseVariant: text('pose_variant'),
  // 'full' | 'half' | 'closeup' - validated at the Zod layer, not a DB enum, so
  // adding a category later is a one-line change, not a migration. Set once at
  // pose-upload time; drives garment_shot_type_workflows auto-resolution for
  // template-scoped poses.
  shotType: text('shot_type'),
  r2Key: text('r2_key').notNull(),
  thumbnailKey: text('thumbnail_key').notNull(),
  genderSlug: text('gender_slug'),
  workflowTemplateId: uuid('workflow_template_id').references(() => workflowTemplates.id, {
    onDelete: 'set null',
  }),
  promptGarmentPhase: text('prompt_garment_phase'),
  promptFacePhase: text('prompt_face_phase'),
  // 'general' = visible in the admin Pose Assets tab and studio "create your own look";
  // 'template' = uploaded from within a catalogue template's looks builder, hidden from
  // both (managed only via the template that owns it).
  scope: text('scope').notNull().default('general'),
  // See modelFaces.publicApiSlug.
  publicApiSlug: text('public_api_slug'),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Per-garment-type workflow/prompt/active overrides for a pose asset.
// Null fields mean "use the pose asset's default".
export const poseGarmentConfigs = pgTable(
  'pose_garment_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    poseAssetId: uuid('pose_asset_id')
      .notNull()
      .references(() => modelPoseAssets.id, { onDelete: 'cascade' }),
    subcategoryId: uuid('subcategory_id')
      .notNull()
      .references(() => garmentSubcategories.id, { onDelete: 'cascade' }),
    workflowTemplateId: uuid('workflow_template_id').references(() => workflowTemplates.id, {
      onDelete: 'set null',
    }),
    promptGarmentPhase: text('prompt_garment_phase'),
    promptFacePhase: text('prompt_face_phase'),
    // Null = inherit model_pose_assets.is_active (the global flag). Non-null overrides
    // it for this garment type only — it can only narrow (hide a globally-active pose
    // for one type), never widen a globally-inactive pose back into visibility.
    isActive: boolean('is_active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqPoseSubcat: unique('pose_garment_configs_pose_subcat_unique').on(
      table.poseAssetId,
      table.subcategoryId,
    ),
    poseIdx: index('pose_garment_configs_pose_asset_id_idx').on(table.poseAssetId),
    subcatIdx: index('pose_garment_configs_subcategory_id_idx').on(table.subcategoryId),
  }),
);

// Many-to-many: which garment subcategories a lower/shoe catalog item targets
export const catalogItemSubcategories = pgTable(
  'catalog_item_subcategories',
  {
    catalogItemId: uuid('catalog_item_id').notNull(),
    subcategoryId: uuid('subcategory_id')
      .notNull()
      .references(() => garmentSubcategories.id, { onDelete: 'cascade' }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.catalogItemId, table.subcategoryId] }),
  }),
);

export const catalogueTemplates = pgTable('catalogue_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  genderSlug: text('gender_slug').notNull(), // 'men' | 'women' | 'boys' | 'girls'
  label: text('label').notNull(),
  thumbnailKey: text('thumbnail_key'),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// One (pose, background) pairing — a "look" — within a catalogue template. Pose/background
// FKs are NO ACTION: both are soft-deleted (deletedAt / isActive=false), never hard-deleted,
// so a look can never dangle from an actual row removal. A look whose pose or background has
// been deactivated is filtered out at read time (GET /v1/models/catalogue-templates), not here.
export const catalogueTemplateLooks = pgTable(
  'catalogue_template_looks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => catalogueTemplates.id, { onDelete: 'cascade' }),
    poseAssetId: uuid('pose_asset_id')
      .notNull()
      .references(() => modelPoseAssets.id),
    backgroundId: uuid('background_id')
      .notNull()
      .references(() => modelBackgrounds.id),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (table) => ({
    templateIdx: index('catalogue_template_looks_template_id_idx').on(table.templateId),
  }),
);

// A concrete template-to-garment-type mapping. Its generated ID scopes pose workflows,
// allowing the same global template to render differently for Shirt, Suit, or another type.
export const catalogueTemplateSubcategories = pgTable(
  'catalogue_template_subcategories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => catalogueTemplates.id, { onDelete: 'cascade' }),
    subcategoryId: uuid('subcategory_id')
      .notNull()
      .references(() => garmentSubcategories.id, { onDelete: 'cascade' }),
  },
  (table) => ({
    uniqTemplateSubcategory: unique(
      'catalogue_template_subcategories_template_subcategory_unique',
    ).on(table.templateId, table.subcategoryId),
    subcategoryIdx: index('catalogue_template_subcategories_subcategory_id_idx').on(
      table.subcategoryId,
    ),
  }),
);

// A look is enabled for every mapped garment type by default. This table stores
// only the exceptions: a look an admin has hidden for one concrete
// template-to-garment-type mapping. Deleting the row restores the default.
export const catalogueTemplateLookExclusions = pgTable(
  'catalogue_template_look_exclusions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mappingId: uuid('mapping_id')
      .notNull()
      .references(() => catalogueTemplateSubcategories.id, { onDelete: 'cascade' }),
    lookId: uuid('look_id')
      .notNull()
      .references(() => catalogueTemplateLooks.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqMappingLook: unique('catalogue_template_look_exclusions_mapping_look_unique').on(
      table.mappingId,
      table.lookId,
    ),
    mappingIdx: index('catalogue_template_look_exclusions_mapping_id_idx').on(table.mappingId),
  }),
);
// Workflow selection for one pose inside one mapped template. Global templates
// deliberately carry no workflow; the same template pose can therefore use a
// different workflow when the template is mapped to Shirt, Suit, or another type.
export const catalogueTemplatePoseWorkflows = pgTable(
  'catalogue_template_pose_workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mappingId: uuid('mapping_id')
      .notNull()
      .references(() => catalogueTemplateSubcategories.id, { onDelete: 'cascade' }),
    poseAssetId: uuid('pose_asset_id')
      .notNull()
      .references(() => modelPoseAssets.id, { onDelete: 'cascade' }),
    workflowTemplateId: uuid('workflow_template_id')
      .notNull()
      .references(() => workflowTemplates.id, { onDelete: 'cascade' }),
    promptGarmentPhase: text('prompt_garment_phase'),
    // 'auto' = written or last refreshed by the shot-type-default resolver; safe to
    // overwrite on the next resolve. 'manual' = an admin picked this explicitly via
    // the per-pose dropdown; the resolver's ON CONFLICT ... WHERE source = 'auto'
    // guard means it will never touch this row again until the admin clears it.
    source: text('source').notNull().default('manual'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqMappingPose: unique('catalogue_template_pose_workflows_mapping_pose_unique').on(
      table.mappingId,
      table.poseAssetId,
    ),
    mappingIdx: index('catalogue_template_pose_workflows_mapping_id_idx').on(table.mappingId),
  }),
);

// The 3-slot default per garment type: "poses tagged X use workflow Y". A join
// table, not fixed columns on garment_subcategories - a 4th shot type later is new
// rows, not a migration. Setting/changing a row here immediately re-resolves every
// matching pose across every template mapped to this garment type - see
// apps/api/src/modules/admin/shot-type-resolve.ts.
export const garmentShotTypeWorkflows = pgTable(
  'garment_shot_type_workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    garmentTypeId: uuid('garment_type_id')
      .notNull()
      .references(() => garmentSubcategories.id, { onDelete: 'cascade' }),
    shotType: text('shot_type').notNull(), // 'full' | 'half' | 'closeup'
    workflowTemplateId: uuid('workflow_template_id')
      .notNull()
      .references(() => workflowTemplates.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqGarmentTypeShotType: unique('garment_shot_type_workflows_garment_type_shot_type_unique').on(
      table.garmentTypeId,
      table.shotType,
    ),
    garmentTypeIdx: index('garment_shot_type_workflows_garment_type_id_idx').on(
      table.garmentTypeId,
    ),
  }),
);

// Per-user saved pose sets for the studio wizard's pose step. isLastUsed rows
// are auto-managed by createJob (apps/api/src/modules/jobs/create.ts) after
// every /v1/jobs/tryon submission — never user-created or user-deleted.
// Named presets are explicit, capped at 10 per (user, gender, garmentType)
// scope in the API layer (arrays can't carry a DB-level count constraint).
// poseIds has no FK to model_pose_assets — Postgres can't FK-constrain array
// elements, so staleness (a pose later deactivated) is filtered out at read
// time instead. gender/garmentTypeId scope every preset to the exact context
// its poses were picked under — poses are gender-partitioned and have
// per-garment-type active/inactive overrides (see model_pose_assets,
// pose_garment_configs), so a preset saved under one context is meaningless
// (or silently wrong) under another.
export const userPosePresets = pgTable(
  'user_pose_presets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name'), // null only for the isLastUsed row
    gender: text('gender').notNull(), // 'men' | 'women' | 'boys' | 'girls' — matches model_pose_assets.genderSlug
    garmentTypeId: uuid('garment_type_id')
      .notNull()
      .references(() => garmentSubcategories.id, { onDelete: 'cascade' }),
    poseIds: uuid('pose_ids').array().notNull(),
    isLastUsed: boolean('is_last_used').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At most one last-used row per (user, gender, garmentType) context.
    uniqueIndex('user_pose_presets_one_last_used_idx')
      .on(t.userId, t.gender, t.garmentTypeId)
      .where(sql`${t.isLastUsed}`),
    // Exact-match safety net against the create-time case-insensitive app check
    // (Task 3) racing itself — not a full case-insensitive constraint (no
    // functional-index precedent elsewhere in this schema), just enough to stop
    // two concurrent requests from both landing the exact same name within the
    // same (user, gender, garmentType) scope. The same name is reusable across
    // different scopes.
    uniqueIndex('user_pose_presets_unique_name_idx')
      .on(t.userId, t.gender, t.garmentTypeId, t.name)
      .where(sql`NOT ${t.isLastUsed}`),
    index('user_pose_presets_user_id_idx').on(t.userId),
    index('user_pose_presets_scope_idx').on(t.userId, t.gender, t.garmentTypeId),
  ],
);

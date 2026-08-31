# Garment Taxonomy & Generation Pipeline Architecture

**Status:** Approved design, not yet implemented.
**Date:** 2026-07-16

## 1. Problem Statement

The platform generates poor results for lower-garment and innerwear try-on/catalogue jobs. The root cause is architectural, not a workflow-quality bug: the entire data model, admin configuration surface, and job-creation logic assume every garment type is an upper garment, with lower garments and shoes treated as optional catalog-sourced attachments — never as peers, never as the user's own primary upload (except through one narrow, boolean-gated escape hatch).

This document defines the taxonomy and pipeline architecture that removes that assumption, generalizing primitives that already exist in embryonic form rather than replacing the system wholesale.

## 2. Current State (verified against code, not assumed)

- `garment_subcategories.requiresLowerUpload` (boolean) already routes the user's single upload into `jobInputs.lowerGarmentKey` instead of `jobInputs.upperGarmentKey` when the resolved workflow has no upper nodes (`apps/api/src/modules/jobs/create.ts:486-499`, `packages/db/src/schema/jobs.ts:56-64`). This is a working but minimal precedent for "family-aware upload routing" — a single boolean instead of a real taxonomy.
- `jobInputs` already stores `upperGarmentKey` and `lowerGarmentKey` as **independent nullable columns**, and validation already accepts both being user-uploaded on the same job. There is no `shoeGarmentKey` column — shoes are catalog-sourced only, never a primary upload, today.
- `workflow_templates` node-ID mappings (`upperNodeIds[]`, `lowerNodeId`, `shoeNodeId`, `faceNodeId`, `bgNodeId`) are a small, fixed, independently-nullable set. `apps/dispatcher/src/workflow/patcher.ts`'s `applyWorkflowPatch` hardcodes one validation/patch branch per node type.
- `hasLower`/`hasShoes`, as surfaced by `GET /v1/models/poses` (`apps/api/src/modules/models/routes.ts:296-298`), are **derived** from whether the resolved workflow template has `lowerNodeId`/`shoeNodeId` set — not declared by the garment type itself.
- The saree two-step flow required three bespoke columns bolted onto `garment_subcategories`: `requiresMannequinStep`, `mannequinWorkflowTemplateId`, `sareeStep2WorkflowTemplateId` (`packages/db/src/schema/models.ts:76-90`). This is the pattern this design eliminates: every new special case was becoming a new column.
- `garment_shot_type_workflows` already generalizes one axis correctly — it's a join table (`garmentTypeId`, `shotType`, `workflowTemplateId`), not fixed columns, specifically so "a 4th shot type later is new rows, not a migration" (existing schema comment). This design extends that same philosophy to the garment-type axis itself.
- `catalog_items.type` is free text (`'lower' | 'shoe'`, stored directly, no DB enum) — already low-friction to extend.

## 3. Architectural Principles

These are the guardrails for every decision below, and for future contributors extending this system:

1. **Runtime resolution is deterministic.** No inference, no runtime AI/LLM calls, no heuristic fallback.
2. **Admin configuration is explicit.** Every garment type has an admin-assigned family and workflow profile — never an auto-derived one.
3. **Capability flags never determine workflow routing.** They drive validation, prompt composition, and UI filtering only.
4. **Garment Families and Workflow Profiles are independent axes.** Family owns upload-slot semantics; Profile owns pipeline/execution behavior. Many garment types share one profile; a family's technical upload slot and its semantic label are also independent (see §5).
5. **New garment-specific behavior extends Workflow Profiles or `capabilities`, never a new bespoke column on `garment_subcategories`.** If a future special case seems to need its own column, that is a signal to add a Workflow Profile stage or a capability flag instead.
6. **Compliance-sensitive fields are real typed columns with DB-level constraints, not jsonb.** Correctness matters more than flexibility for these fields; friction to change them is intentional.
7. **New tables, columns, or abstraction layers are added only once a second concrete use case exists** — not for a hypothetical future garment type, presentation mode, or policy category.
8. **Any exception to these principles requires updating this document with the reasoning, before implementation** — not a silent one-off `if (garmentType === 'saree')` in application code. This repo has no separate ADR process; this spec file *is* the architecture decision record for this system, so deviations get appended here as a dated addendum, not tracked elsewhere.

## 4. Core Concepts

- **Garment Family** (`garment_families`) — a small, admin-managed lookup table declaring which upload slot a garment type's user-uploaded image fills. Semantic label and technical slot are decoupled: two families can share the same technical `primaryUploadSlot` while remaining administratively distinct (see §5 seed data).
- **Capabilities** (`garment_subcategories.capabilities` jsonb) — generation-affecting flags (e.g. `requiresLegAlignment`, `drapePreservation`, `preserveSleeves`). Drive pose-compatibility validation and prompt-fragment composition. Never consulted for workflow routing.
- **Audience** (`garment_subcategories.audience` column) — compliance classification, kept structurally separate from `capabilities` because correctness here has legal/safety consequences, not just render-quality consequences.
- **Workflow Profile** (`workflow_profiles` + `workflow_profile_stages`) — a reusable, admin-defined, ordered pipeline. Generalizes the saree two-step special case into an N-stage mechanism usable by any future multi-pass garment family, and lets multiple garment types (Shirt, Polo, T-shirt) share one profile instead of duplicating configuration per type.
- **Workflow Profile shot-type defaults** (`workflow_profile_shot_types`) — generalizes `garment_shot_type_workflows` from per-garment-type scoping to per-profile scoping.
- **Pose capabilities** (`model_pose_assets.poseCapabilities` jsonb) — the pose-side half of the compatibility check (e.g. `showsLegs`, `showsWaist`, `showsFullBody`).
- `pose_garment_configs` is unchanged — it remains the finest-grained per-(pose, garment type) override, sitting above the profile's shot-type default.

## 5. Database Schema

### New table: `garment_families`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `slug` | text, unique, not null | |
| `label` | text, not null | |
| `primaryUploadSlot` | text, not null | `'upper' \| 'lower'` — Zod-validated, not a DB enum (matches the existing `shotType` convention: "adding a category later is a one-line change, not a migration") |
| `sortOrder` | integer, not null, default 0 | |
| `createdAt` | timestamp, not null, default now() | |

Seed data (4 rows — not 5; footwear is excluded, see §13):

| slug | label | primaryUploadSlot |
|---|---|---|
| `upper` | Upper Garment | `upper` |
| `lower` | Lower Garment | `lower` |
| `full_body_draped` | Full-Body Draped (Saree, Lehenga) | `upper` |
| `full_body_fitted` | Full-Body Fitted (Dress, Jumpsuit, Gown) | `upper` |

`full_body_*` families share `primaryUploadSlot = 'upper'` deliberately: `jobInputs` has exactly two upload-key columns (`upperGarmentKey`, `lowerGarmentKey`), and mechanically a full-body upload has always flowed through the `upperGarmentKey` column (confirmed: `CreateSareeMannequinJobRequest.garmentKey` and `CreateTryOnJobInputs.upperGarmentKey`/`mannequinJobId` are the only fields saree jobs use today — never `lowerGarmentKey`). What actually distinguishes a full-body-draped garment from a plain upper garment is its Workflow Profile (multi-stage) and its capabilities (`drapePreservation: true`), not which DB column receives the raw upload. Family answers "which column"; Profile answers "what pipeline"; they are allowed to disagree in granularity.

### New table: `workflow_profiles`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `slug` | text, unique, not null | |
| `label` | text, not null | |
| `isActive` | boolean, not null, default true | |
| `createdAt` / `updatedAt` | timestamp | |

### New table: `workflow_profile_stages`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `profileId` | uuid, not null, FK → `workflow_profiles.id` onDelete cascade | |
| `stageOrder` | integer, not null | 1-based |
| `workflowTemplateId` | uuid, not null, FK → `workflow_templates.id` | |
| `inputSource` | text, not null, default `'previous_stage'` | `'primary_upload' \| 'previous_stage'` — Zod-validated. Stage 1 of every profile must be `'primary_upload'`; no other value exists today because no third case does — extend the enum when a real one shows up (§13). |
| `createdAt` / `updatedAt` | timestamp | |
| unique | `(profileId, stageOrder)` | |

Stage N>1's `'previous_stage'` input is stage N-1's own completed job output — this generalizes today's `resolveMannequinGarmentKey` (`apps/api/src/modules/jobs/create.ts:34-58`) beyond saree.

### New table: `workflow_profile_shot_types`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `profileId` | uuid, not null, FK → `workflow_profiles.id` onDelete cascade | |
| `shotType` | text, not null | `'full' \| 'half' \| 'closeup'`, Zod-validated (matches `model_pose_assets.shotType` convention) |
| `workflowTemplateId` | uuid, not null, FK → `workflow_templates.id` | |
| `createdAt` / `updatedAt` | timestamp | |
| unique | `(profileId, shotType)` | |

Replaces `garment_shot_type_workflows` (`garmentTypeId`-scoped) with the same shape, profile-scoped. The resolver mechanics that consume this table (`apps/api/src/modules/admin/shot-type-resolve.ts`) carry over unchanged in shape, repointed from garment-type-scoped to profile-scoped — exact reimplementation detail belongs in the implementation plan that touches this file, not this spec.

### `garment_subcategories` — new columns

| Column | Type | Notes |
|---|---|---|
| `familyId` | uuid, FK → `garment_families.id` | Nullable in Phase 1, backfilled Phase 2, `NOT NULL` from Phase 4 |
| `workflowProfileId` | uuid, FK → `workflow_profiles.id` | Same nullable → backfilled → `NOT NULL` lifecycle |
| `capabilities` | jsonb, not null, default `'{}'` | Generation-affecting flags only |
| `audience` | text, not null, default `'all'` | `CHECK (audience IN ('all', 'adult'))` |

Additional constraint on `garment_subcategories`:

```sql
ALTER TABLE garment_subcategories
  ADD CONSTRAINT garment_subcategories_audience_minor_guard
  CHECK (NOT (audience = 'adult' AND gender_slug IN ('boys', 'girls')));
```

This is a hard DB-level guarantee, not just application-level validation — it holds even if the admin API is bypassed.

Deprecated, dropped in Phase 4 (§11) after cutover is verified: `requiresLowerUpload`, `requiresMannequinStep`, `mannequinWorkflowTemplateId`, `sareeStep2WorkflowTemplateId`.

Unchanged, orthogonal, kept as-is: `defaultLowerCatalogId`, `defaultShoeCatalogId`, `tryonCategoryId`, `defaultPoseId`.

### `model_pose_assets` — new column

| Column | Type | Notes |
|---|---|---|
| `poseCapabilities` | jsonb, not null, default `'{}'` | e.g. `{"showsLegs": true, "showsWaist": true, "showsFullBody": false}` |

### Unchanged

`pose_garment_configs`, `catalog_items` (type stays `'lower' \| 'shoe'` — see §13), `catalogue_template_pose_workflows`, `tryon_categories`.

## 6. Resolution Algorithm

**Upload routing:** `garmentSubcategories.familyId → garmentFamilies.primaryUploadSlot` determines whether the studio's single garment upload is submitted as `upperGarmentKey` or `lowerGarmentKey`. Replaces the `requiresLowerUpload` boolean check everywhere it's read today.

**Workflow routing (per pose, per stage):** `garmentSubcategories.workflowProfileId → workflow_profiles → workflow_profile_stages` (ordered by `stageOrder`) gives the stage list for a job. For each stage, the effective `workflow_template` for a specific pose follows the same most-specific-wins precedence this codebase already uses today: `pose_garment_configs` per-(pose, garment type) override → `workflow_profile_shot_types` shot-type default → the pose's own default `workflowTemplateId` on `model_pose_assets`.

**Multi-stage execution:** stage 1 consumes the primary upload (per the upload routing above). Stage N>1 consumes stage N-1's own completed job output. Every profile has at least one stage; single-stage is the common case, multi-stage is opt-in per profile (not a `requiresMannequinStep` special case).

This is a lookup, not an inference — no step in this chain guesses; every step either finds an explicit admin-set value or falls through to the next explicit default.

## 7. Validation Rules

**Capability ↔ pose compatibility.** Before a pose is offered by `GET /v1/models/poses?garmentTypeId=`, and again at job creation (mirroring the existing pattern where `create.ts` re-validates what the studio UI already filtered), compare `garmentSubcategories.capabilities` against the candidate pose's `poseCapabilities`. A pose is compatible with a garment type when every `requiresX: true` capability has a correspondingly-satisfied pose flag. The exact flag-name pairing table (which `requires*` capability maps to which pose flag) is defined in the implementation plan that builds this check, not this spec — it is a small, enumerable mapping, not a general rule engine.

**Audience.** Enforced twice: the DB CHECK constraint (§5, holds unconditionally) and an explicit 400 response from the admin `PATCH`/`POST` garment-type routes when an admin attempts to save `audience: 'adult'` against `genderSlug` in `('boys', 'girls')`, so the failure is a clear API error rather than a raw constraint-violation message.

## 8. Prompt Composition

Unchanged: `workflow_templates.defaultGarmentPhasePrompt` (template default) and `pose_garment_configs.promptGarmentPhase` (per-type/per-pose override) remain exactly as they work today.

New: a small, fixed lookup from capability flag → reusable prompt fragment string (e.g. `drapePreservation: true` appends a fixed drape-preservation instruction), composed into the final prompt sent to ComfyUI. This is not a new entity, not LoRA-aware, and not admin-editable in v1 — it is a short static table in code, extended the same way `ASPECT_DIMENSIONS` or similar fixed lookups are extended in this codebase today (a one-line addition, not a migration).

## 9. Admin Portal UX

- **New "Garment Families" screen** (`apps/admin-web`) — minimal CRUD (slug, label, primaryUploadSlot, sortOrder). Rarely used; not a priority for polish.
- **New "Workflow Profiles" screens** — list profiles; create/edit a profile with its ordered stage list (each stage: pick a `workflow_template`, `inputSource` defaults to `primary_upload` for stage 1 and `previous_stage` thereafter); a shot-type-defaults sub-panel per profile. This replaces the current per-garment-type shot-type panel in `GarmentTypesTab.tsx`, now shared across every type assigned to the profile instead of duplicated per type.
- **`EditGarmentTypeModal.tsx` changes:** replace the `requiresLowerUpload` toggle and the "Two-Step Generation" (saree) panel with: a Family dropdown, a Workflow Profile dropdown, a Capabilities form (checkboxes backed by `capabilities` jsonb), and an Audience dropdown that disables/warns on `'adult'` when `genderSlug` is `boys`/`girls`.

## 10. Studio / Catalogue Flow

- **Step 0 (garment upload):** the upload target (`upperGarmentKey` vs `lowerGarmentKey`) is driven by the selected garment type's resolved `family.primaryUploadSlot`, read from an extended `GET /v1/models/garment-types` response, replacing the current `requiresLowerUpload`-boolean-driven logic.
- **Step 3 (pose selection):** `GET /v1/models/poses` gains capability-compatibility filtering (§7) as an additional exclusion on top of — not a replacement for — the existing `hasLower`/`hasShoes`-driven catalog-picker visibility.
- Catalog pickers (lower/shoe) keep their current visibility rule (shown only when the resolved workflow has the corresponding node) — unchanged by this design, per the standalone-rendering decision in §13.

## 11. Migration & Rollout Strategy

Four phases, each independently shippable, using this codebase's existing nullable-column-with-fallback idiom (the same pattern `pose_garment_configs` and `catalogueTemplatePoseWorkflows.source` already use) rather than introducing feature-flag infrastructure that doesn't otherwise exist in this codebase.

**Phase 1 — Additive schema.** Create `garment_families`, `workflow_profiles`, `workflow_profile_stages`, `workflow_profile_shot_types`. Add nullable `familyId`, `workflowProfileId`, `capabilities`, `audience` to `garment_subcategories`; nullable `poseCapabilities` to `model_pose_assets`. Seed the 4 `garment_families` rows. No application code reads these yet — zero behavior change.

**Phase 2 — Backfill.** A script populates, for every existing active `garment_subcategories` row:
- `familyId`: `'full_body_draped'` if `requiresMannequinStep`; else `'lower'` if `requiresLowerUpload`; else `'upper'`. (`requiresMannequinStep` is checked first — a saree row could theoretically have both flags set, and `full_body_draped` is the semantically correct label even though it happens to share the same mechanical `primaryUploadSlot` as plain `'upper'`. No existing row maps to `full_body_fitted`; that family exists for future new garment types such as dresses, which have no equivalent signal in today's schema to backfill from.)
- A generated (or reused, when identical) `workflow_profile`: for `requiresMannequinStep = true` rows, a 2-stage profile (stage 1 = `mannequinWorkflowTemplateId`, `inputSource = 'primary_upload'`; stage 2 = `sareeStep2WorkflowTemplateId`, `inputSource = 'previous_stage'`); for all other rows, a 1-stage profile referencing that type's existing default workflow resolution, plus a migrated copy of that type's `garment_shot_type_workflows` rows into `workflow_profile_shot_types`.
- Verified before Phase 3 begins by a read-only comparison query confirming old-path and new-path workflow resolution agree for every active row.

**Phase 3 — Cutover.** API and dispatcher switch reads to the new path, falling back to the legacy columns when `familyId`/`workflowProfileId` is null (should not occur post-backfill, but keeps rollout safe). Ship the admin UX (§9) and studio UX (§10) changes.

**Phase 4 — Cleanup.** Verify 100% of active `garment_subcategories` rows have non-null `familyId`/`workflowProfileId` (monitoring query). Make those columns `NOT NULL`. Drop `requiresLowerUpload`, `requiresMannequinStep`, `mannequinWorkflowTemplateId`, `sareeStep2WorkflowTemplateId`, and the `garment_shot_type_workflows` table.

## 12. Observability

Extends existing infrastructure (`@tryme/observability` Prometheus registry, `@tryme/logger` pino child-loggers) rather than introducing new observability infrastructure:

- Add `familyId`, `workflowProfileId`, `stageIndex` as labels on the existing ComfyUI generation-duration counter/histogram.
- Add `familyId`, `workflowProfileId`, `stageIndex` to the existing per-job child-logger bindings (alongside `jobId`/`userId`).
- Two new counters, chosen because they have no existing analog and directly measure whether this architecture is solving the original problem: `capability_validation_failures_total` (labels: `garmentTypeId`, `missingCapability`) and `pose_compatibility_rejections_total` (labels: `garmentTypeId`, `poseId`).

## 13. Explicitly Out of Scope

Each of these was considered and deliberately deferred, with a reason — not missed:

- **AI-assisted admin form suggestions.** Garment types are created rarely, by trained admins, for dozens of rows total. Not worth an LLM integration at this volume.
- **LoRA / separate "Prompt Strategy" entity.** Zero LoRA usage exists anywhere in `apps/dispatcher` today (verified by grep). Building a reusable entity for a capability the pipeline doesn't have yet is speculative.
- **Full "Policy Profile" taxonomy for compliance.** There is exactly one concrete policy rule today (innerwear × minor audience). A multi-category taxonomy (Adult Fashion / Children's Apparel / Medical / Sportswear / ...) invented for one rule is the same anti-pattern this design eliminates elsewhere. The `audience` column + CHECK constraint (§5, §7) is the proportionate solution; revisit if a second concrete policy dimension appears.
- **Workflow Profile versioning / reproducibility.** A legitimate concern, but pre-existing and not worsened by this design — `workflow_templates` are already mutable in place today with no versioning (`patcher.ts` deliberately has no caching so admin edits apply immediately). Building full version history (publish flow, job-to-version pinning, rollback UX) is a separately-scoped feature with no evidence of active harm today.
- **`garment_slots` lookup table for `primaryUploadSlot`.** Rejected on inspection: the real extensibility bottleneck is `workflow_templates`' fixed node-ID columns and `applyWorkflowPatch`'s hardcoded per-slot branches, neither of which this design changes. Normalizing `primaryUploadSlot` alone would let an admin add a `"cape"` row that the dispatcher has no way to consume — a decorative abstraction, not a functional one.
- **`audiences` FK lookup table.** Rejected: for a compliance-critical field with two known values, requiring a code change/migration/review to add a new category is a feature (deliberate friction), not a gap.
- **Multi-upload / layered garments** (jacket over T-shirt, co-ord sets). The existing `jobInputs` convention (one typed nullable column per slot, e.g. `upperGarmentKey`/`lowerGarmentKey` coexisting today) already scales to this as a future additive migration — new nullable column + new node-ID column + one new patch branch. Not built now; `workflow_profile_stages` deliberately doesn't hardcode "exactly one input slot" as a structural assumption, so this stays additive later.
- **`catalog_items` `'upper'` type for pairing a catalog top with a user-uploaded lower garment.** Per decision: lower/innerwear-lower garments render standalone in v1 (product-shot style), no auto-paired top. `catalog_items.type` is already free text, so adding `'upper'` later is a low-friction addition, not a migration.
- **Footwear as a primary-upload garment family.** No `shoeGarmentKey` column exists in `jobInputs` today, and shoes are catalog-sourced only. Not a stated requirement; excluded from the `garment_families` seed data in §5 (4 rows, not 5).

## 14. Worked Example — Adding "Bra" (Zero Code Changes)

1. Admin creates a `garment_subcategories` row: `genderSlug: 'women'`, `familyId` → `upper` (a bra is worn on the upper body).
2. Admin sets `capabilities`: `{"innerwear": true, "preserveSleeves": false}`.
3. Admin sets `audience: 'adult'` (blocked by the CHECK constraint if `genderSlug` were `girls` — it isn't, so it saves).
4. Admin assigns an existing or new `workflow_profile` (likely a new "Innerwear Upper" profile if the prompt/safety fragment requirements differ materially from "Upper Standard," even if it reuses the same underlying `workflow_template` graph).
5. Studio automatically routes the user's upload to `upperGarmentKey` (via `familyId`), filters the pose list to capability-compatible poses, and composes the prompt with the innerwear-specific fragment.

No TypeScript changed. No new migration beyond the admin's data entry.

import type { DB } from '@tryme/db';
import { sql } from 'drizzle-orm';

// Auto-resolves catalogue_template_pose_workflows rows from garment_shot_type_workflows
// defaults. Every function here is a single atomic INSERT ... SELECT ... ON CONFLICT
// statement — no per-row loop — so resolving thousands of (mapping, pose) rows at once
// is one round trip. The `WHERE catalogue_template_pose_workflows.source = 'auto'` guard
// on the conflict branch is what makes re-running this safe at any time: it inserts into
// any gap, refreshes any row this same auto-resolver previously wrote, and never touches
// a row an admin explicitly picked (source = 'manual') via the per-pose dropdown. The
// `IS DISTINCT FROM` clause alongside it means a row already at the correct value is left
// completely untouched — no wasted UPDATE, no bumped updated_at — so most re-runs at scale
// touch nothing. Excludes deactivated/soft-deleted poses and soft-deleted templates: a
// retired asset should never get a workflow row written or refreshed for it.
//
// SELECT DISTINCT is required, not cosmetic: a template's look-dedupe check only
// rejects duplicate (poseAssetId, backgroundId) PAIRS, so the same pose paired with two
// different backgrounds is a perfectly valid template (two separate looks). That
// produces two source rows with the identical (mapping_id, pose_asset_id) key in one
// INSERT — and Postgres's ON CONFLICT DO UPDATE raises "command cannot affect row a
// second time" if a single statement tries to upsert the same target row twice. Every
// non-DISTINCT column here (the mapping id, the pose id, and the resolved workflow —
// which depends only on the pose's shot type, never on which background it's paired
// with) is already identical across such duplicates, so DISTINCT collapses them
// losslessly.
//
// Every function accepts an `Executor` — a plain `DB` or a transaction handle (`tx` from
// `db.transaction(async (tx) => ...)`) — because every caller must run its mutation (the
// upsert, the mapping insert, the override delete) and its resolve call in ONE transaction.
// Two separate round trips would mean a resolve failure after a successful mutation leaves
// permanently-unresolved state with no automatic retry path (worst case: a new mapping insert
// uses ON CONFLICT DO NOTHING, so retrying `mapped: true` after a partial failure would hit
// the "already exists" branch and never call resolve again). Wrapping both in one transaction
// means a resolve failure rolls back the mutation too, so a retry re-enters the same path.
type Executor = Pick<DB, 'execute'>;

const UPSERT_TAIL = sql`
  ON CONFLICT (mapping_id, pose_asset_id) DO UPDATE SET
    workflow_template_id = excluded.workflow_template_id,
    source = 'auto',
    updated_at = now()
  WHERE catalogue_template_pose_workflows.source = 'auto'
    AND catalogue_template_pose_workflows.workflow_template_id
      IS DISTINCT FROM excluded.workflow_template_id
  RETURNING catalogue_template_pose_workflows.id
`;

const ACTIVE_POSE_AND_TEMPLATE_JOIN = sql`
    JOIN catalogue_templates t ON t.id = m.template_id AND t.deleted_at IS NULL
    JOIN catalogue_template_looks l ON l.template_id = m.template_id
    JOIN model_pose_assets p
      ON p.id = l.pose_asset_id AND p.is_active AND p.deleted_at IS NULL
`;

/** Resolves every shot-type default for one specific (template × garment type) mapping. */
export async function resolveForMapping(db: Executor, mappingId: string): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO catalogue_template_pose_workflows
      (mapping_id, pose_asset_id, workflow_template_id, source, updated_at)
    SELECT DISTINCT m.id, l.pose_asset_id, g.workflow_template_id, 'auto', now()
    FROM catalogue_template_subcategories m
    ${ACTIVE_POSE_AND_TEMPLATE_JOIN}
    JOIN garment_shot_type_workflows g
      ON g.garment_type_id = m.subcategory_id AND g.shot_type = p.shot_type
    WHERE m.id = ${mappingId}::uuid
    ${UPSERT_TAIL}
  `);
  return result.length;
}

/** Resolves every shot-type default across every garment type a template is mapped to. */
export async function resolveForTemplate(db: Executor, templateId: string): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO catalogue_template_pose_workflows
      (mapping_id, pose_asset_id, workflow_template_id, source, updated_at)
    SELECT DISTINCT m.id, l.pose_asset_id, g.workflow_template_id, 'auto', now()
    FROM catalogue_template_subcategories m
    ${ACTIVE_POSE_AND_TEMPLATE_JOIN}
    JOIN garment_shot_type_workflows g
      ON g.garment_type_id = m.subcategory_id AND g.shot_type = p.shot_type
    WHERE m.template_id = ${templateId}::uuid
    ${UPSERT_TAIL}
  `);
  return result.length;
}

/** Resolves one shot-type's default across every template mapped to one garment type. */
export async function resolveForGarmentTypeShotType(
  db: Executor,
  garmentTypeId: string,
  shotType: string,
): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO catalogue_template_pose_workflows
      (mapping_id, pose_asset_id, workflow_template_id, source, updated_at)
    SELECT DISTINCT m.id, l.pose_asset_id, g.workflow_template_id, 'auto', now()
    FROM catalogue_template_subcategories m
    ${ACTIVE_POSE_AND_TEMPLATE_JOIN}
    JOIN garment_shot_type_workflows g
      ON g.garment_type_id = m.subcategory_id AND g.shot_type = p.shot_type
    WHERE m.subcategory_id = ${garmentTypeId}::uuid AND p.shot_type = ${shotType}
    ${UPSERT_TAIL}
  `);
  return result.length;
}

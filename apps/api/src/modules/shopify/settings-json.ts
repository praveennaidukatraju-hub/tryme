import { schema } from '@tryme/db';
import { type SQL, sql } from 'drizzle-orm';

/**
 * The settings column is always an object, but coalescing here keeps every
 * partial update safe for pre-existing or manually repaired rows as well.
 */
export function storeSettingsJson(): SQL {
  return sql`coalesce(${schema.shopifyStores.settings}, '{}'::jsonb)`;
}

/**
 * Merge an object into a known settings path entirely in Postgres.
 *
 * Paths are supplied only by route modules as static string literals, never
 * from request data. Reusing the same expression in both operands ensures a
 * concurrent writer's committed JSONB value is merged rather than replaced.
 */
export function mergeStoreSettingsObject(
  settings: SQL,
  path: readonly string[],
  patch: object,
): SQL {
  const jsonPatch = sql`${JSON.stringify(patch)}::jsonb`;
  if (path.length === 0) return sql`${settings} || ${jsonPatch}`;

  const jsonPath = sql.raw(`'{${path.join(',')}}'`);
  if (path.length === 1) {
    return sql`
      jsonb_set(
        ${settings},
        ${jsonPath},
        coalesce(${settings} #> ${jsonPath}, '{}'::jsonb) || ${jsonPatch},
        true
      )
    `;
  }

  // `jsonb_set` creates a missing final key but not missing intermediate
  // objects. Widget patches are two levels deep, so merge the leaf into a
  // materialized parent before replacing that parent in the settings document.
  const parentPath = sql.raw(`'{${path[0]}}'`);
  const leafPath = sql.raw(`'{${path.slice(1).join(',')}}'`);
  const parent = sql`coalesce(${settings} #> ${parentPath}, '{}'::jsonb)`;
  return sql`
    jsonb_set(
      ${settings},
      ${parentPath},
      jsonb_set(
        ${parent},
        ${leafPath},
        coalesce(${parent} #> ${leafPath}, '{}'::jsonb) || ${jsonPatch},
        true
      ),
      true
    )
  `;
}

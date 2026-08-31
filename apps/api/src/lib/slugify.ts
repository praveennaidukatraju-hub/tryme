/**
 * Slug generation for the one-time public_api_slug backfill
 * (POST /admin/dev-api/catalog/backfill-slugs).
 *
 * Admin-curated asset labels are free text and frequently unusable as a public
 * identifier as-is — some are literally a generated UUID (seen on a real
 * catalog_items row), some are near-duplicates across genders ("pose13" exists
 * for both men and women). A blind slugify(label) alone collides constantly
 * against the partial-unique index on public_api_slug (unique among non-null
 * values, table-wide — not scoped by gender or type). makeUniqueSlug widens the
 * candidate deterministically until it clears every slug already reserved,
 * rather than looping unboundedly or leaving the row unslugged.
 */

const MAX_SLUG_LEN = 64;
const MAX_BASE_LEN = 40;

/** Lowercase, ASCII, hyphen-separated. Matches PUBLIC_SLUG in packages/types/src/dev.ts. */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics after NFKD split
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function trimTrailingHyphen(s: string): string {
  return s.replace(/-+$/g, '');
}

/**
 * Builds a slug for `label` that is not already in `usedSlugs`, then reserves
 * it in `usedSlugs` (mutated) so the next call in the same batch sees it.
 *
 * Widening order: bare slugified label -> + discriminators (e.g. gender,
 * item type) in the order given -> + a short suffix from `uniqueId` (a row's
 * own id — collision-proof for any realistic batch size). The suffix step
 * always terminates because uniqueId is unique per row by definition.
 */
export function makeUniqueSlug(
  label: string,
  discriminators: string[],
  uniqueId: string,
  usedSlugs: Set<string>,
  fallback = 'item',
): string {
  const base = (slugify(label) || slugify(fallback) || 'item').slice(0, MAX_BASE_LEN);

  const candidates: string[] = [base];
  let withDiscriminators = base;
  for (const d of discriminators) {
    const part = slugify(d);
    if (!part) continue;
    withDiscriminators = trimTrailingHyphen(`${withDiscriminators}-${part}`).slice(
      0,
      MAX_SLUG_LEN - 7, // leave room for a "-xxxxxx" id suffix if this still collides
    );
    candidates.push(withDiscriminators);
  }

  for (const c of candidates) {
    if (c && !usedSlugs.has(c)) {
      usedSlugs.add(c);
      return c;
    }
  }

  // Every widened candidate collided (or was empty) — fall back to a suffix
  // derived from the row's own id. Grow the suffix length before giving up,
  // though in practice 6 hex chars (16^6 combinations) never needs to.
  const stem = withDiscriminators || base || 'item';
  for (let len = 6; len <= uniqueId.replace(/-/g, '').length; len += 2) {
    const suffix = uniqueId.replace(/-/g, '').slice(0, len);
    const candidate = trimTrailingHyphen(`${stem.slice(0, MAX_SLUG_LEN - len - 1)}-${suffix}`);
    if (!usedSlugs.has(candidate)) {
      usedSlugs.add(candidate);
      return candidate;
    }
  }

  // Unreachable in practice (uniqueId is a UUID, so the full-id suffix is
  // unique by construction), but never return an unregistered slug.
  const last = trimTrailingHyphen(`${stem.slice(0, MAX_SLUG_LEN - 37)}-${uniqueId}`).slice(
    0,
    MAX_SLUG_LEN,
  );
  usedSlugs.add(last);
  return last;
}

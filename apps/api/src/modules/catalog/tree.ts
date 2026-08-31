import type { schema } from '@tryme/db';

type Cat = typeof schema.catalogCategories.$inferSelect;
type Item = typeof schema.catalogItems.$inferSelect & { thumbnailUrl: string };

export function buildTree(cats: Cat[], items: Item[], getUrl?: (key: string) => string) {
  const catIds = new Set(cats.map((c) => c.id));
  const byParent = new Map<number | null, Cat[]>();
  for (const c of cats) {
    // A category whose parent wasn't fetched (dangling parent_id, deleted parent,
    // or an inactive parent filtered out upstream) must still surface as a root —
    // otherwise its entire subtree of items silently disappears from the tree.
    const k = c.parentId != null && catIds.has(c.parentId) ? c.parentId : null;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)?.push(c);
  }
  const itemsByCat = new Map<number, Item[]>();
  for (const i of items) {
    if (i.categoryId == null) continue;
    if (!itemsByCat.has(i.categoryId)) itemsByCat.set(i.categoryId, []);
    itemsByCat.get(i.categoryId)?.push(i);
  }
  const walk = (parentId: number | null): unknown[] =>
    (byParent.get(parentId) ?? [])
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((c) => ({
        id: c.id,
        slug: c.slug,
        label: c.label,
        thumbnailUrl: c.thumbnailKey && getUrl ? getUrl(c.thumbnailKey) : null,
        children: walk(c.id),
        items: (itemsByCat.get(c.id) ?? []).map((i) => ({
          id: i.id,
          label: i.label,
          thumbnailUrl: i.thumbnailUrl,
        })),
      }));
  return walk(null);
}

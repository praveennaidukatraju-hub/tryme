// Preset continents shown by default in pickers. Admins can add further
// continents from the Add/Edit Face modals; those are stored as free-form
// slugs (see ContinentSlug in @tryme/types) and merged into these lists
// at runtime by FacesTab, so they show up as filter tabs / dropdown options
// too once at least one face uses them.
export const CONTINENTS: { value: string; label: string }[] = [
  { value: 'asia', label: 'Asia' },
  { value: 'africa', label: 'Africa' },
  { value: 'europe', label: 'Europe' },
  { value: 'north_america', label: 'North America' },
  { value: 'south_america', label: 'South America' },
  { value: 'oceania', label: 'Oceania' },
];

export const CONTINENT_LABEL: Record<string, string> = Object.fromEntries(
  CONTINENTS.map((c) => [c.value, c.label]),
);

export function slugifyContinent(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Known label, or a title-cased fallback derived from the slug (e.g. "middle_east" -> "Middle East"). */
export function continentLabel(slug: string): string {
  return (
    CONTINENT_LABEL[slug] ??
    slug
      .split('_')
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(' ')
  );
}

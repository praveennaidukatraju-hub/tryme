export const ANALYTICS_PRESETS = [
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: '90d', label: 'Last 90 days' },
  { id: 'all', label: 'All time' },
] as const;

export type AnalyticsPreset = (typeof ANALYTICS_PRESETS)[number]['id'];

const DAY_MS = 86_400_000;
/** Matches the events retention horizon and the API's own range ceiling. */
const MAX_RANGE_DAYS = 400;

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Turn a preset into the inclusive `from`/`to` calendar dates the API takes.
 *
 * Resolved client-side on purpose: the server then has exactly one code path
 * for both presets and the custom picker, rather than a second preset vocabulary
 * to keep in sync.
 */
export function resolvePreset(
  preset: AnalyticsPreset,
  installedAt: Date,
  today: Date = new Date(),
): { from: string; to: string } {
  const spanDays: Record<Exclude<AnalyticsPreset, 'all'>, number> = {
    '7d': 7,
    '30d': 30,
    '90d': 90,
  };

  const start =
    preset === 'all' ? installedAt : new Date(today.getTime() - (spanDays[preset] - 1) * DAY_MS);

  // Both ends inclusive, so "last 7 days" spans today plus the six before it.
  const earliest = new Date(today.getTime() - (MAX_RANGE_DAYS - 1) * DAY_MS);
  const clamped = start < earliest ? earliest : start;

  return { from: iso(clamped), to: iso(today) };
}

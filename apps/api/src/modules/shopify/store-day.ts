/**
 * Day/window boundaries in the store's own timezone.
 *
 * A merchant who sets "200 per day" and watches the counter reset at 05:30
 * local time will file a bug, so every boundary here is local-calendar, not
 * UTC and not rolling.
 */

type LocalDateParts = { year: number; month: number; day: number };
type LocalDateTimeParts = LocalDateParts & { hour: number; minute: number; second: number };

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Invalid or absent zones use UTC so a bad row cannot break the limit path. */
function validTimezone(timezone: string | null): string {
  const candidate = timezone ?? 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format();
    return candidate;
  } catch {
    return 'UTC';
  }
}

/** Local wall-clock date parts for an instant in a validated zone. */
function localParts(timezone: string, at: Date): LocalDateParts {
  const values: Partial<LocalDateParts> = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at)) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day') {
      values[part.type] = Number(part.value);
    }
  }
  return values as LocalDateParts;
}

/** The store-local calendar day as YYYYMMDD, for use in a Redis counter key. */
export function storeDayKey(timezone: string | null, now: Date = new Date()): string {
  const { year, month, day } = localParts(validTimezone(timezone), now);
  return `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
}

function localDateTimeParts(formatter: Intl.DateTimeFormat, at: Date): LocalDateTimeParts {
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(at)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return values as LocalDateTimeParts;
}

function localDateValue(parts: LocalDateParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

function offsetAt(parts: LocalDateTimeParts, at: Date): number {
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return localAsUtc - Math.floor(at.getTime() / 1000) * 1000;
}

function firstCrossing(
  formatter: Intl.DateTimeFormat,
  target: number,
  start: number,
  end: number,
): number {
  let low = start;
  let high = end;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (localDateValue(localDateTimeParts(formatter, new Date(middle))) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Find the earliest UTC instant belonging to a local calendar date. */
function localMidnightUtc(timezone: string, year: number, month: number, day: number): Date {
  const target = Date.UTC(year, month - 1, day);
  const bracketStart = target - 2 * DAY_MS;
  const bracketEnd = target + 2 * DAY_MS;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const offsets = new Set<number>();
  const crossings: number[] = [];

  let segmentStart = bracketStart;
  let startParts = localDateTimeParts(formatter, new Date(segmentStart));
  offsets.add(offsetAt(startParts, new Date(segmentStart)));

  while (segmentStart < bracketEnd) {
    const segmentEnd = Math.min(segmentStart + HOUR_MS, bracketEnd);
    const endParts = localDateTimeParts(formatter, new Date(segmentEnd));
    offsets.add(offsetAt(endParts, new Date(segmentEnd)));

    if (localDateValue(startParts) < target && localDateValue(endParts) >= target) {
      crossings.push(firstCrossing(formatter, target, segmentStart, segmentEnd));
    }

    segmentStart = segmentEnd;
    startParts = endParts;
  }

  // Every ordinary/repeated midnight is target wall-time minus one of the
  // offsets active in the bracket. Validate each candidate because an offset
  // sampled elsewhere may not be active at that instant.
  for (const offset of offsets) {
    const candidate = target - offset;
    const at = new Date(candidate);
    const parts = localDateTimeParts(formatter, at);
    if (localDateValue(parts) === target && offsetAt(parts, at) === offset) {
      crossings.push(candidate);
    }
  }

  return new Date(Math.min(...crossings));
}

/**
 * The UTC instant at which the current local calendar window began.
 * Weeks start Monday (ISO).
 */
export function windowStart(
  timezone: string | null,
  window: 'day' | 'week' | 'month',
  now: Date = new Date(),
): Date {
  const zone = validTimezone(timezone);
  const { year, month, day } = localParts(zone, now);
  let boundary = Date.UTC(year, month - 1, day);

  if (window === 'month') boundary = Date.UTC(year, month - 1, 1);
  if (window === 'week') {
    const daysSinceMonday = (new Date(boundary).getUTCDay() + 6) % 7;
    boundary -= daysSinceMonday * DAY_MS;
  }

  const boundaryDate = new Date(boundary);
  return localMidnightUtc(
    zone,
    boundaryDate.getUTCFullYear(),
    boundaryDate.getUTCMonth() + 1,
    boundaryDate.getUTCDate(),
  );
}

/**
 * The UTC instant at which the given store-local calendar date begins.
 *
 * `isoDate` is a bare YYYY-MM-DD naming a day in the store's own timezone —
 * which is what the Analytics page sends. Parsing it as a UTC timestamp instead
 * would shift every bucket by the store's offset and silently misattribute
 * activity near midnight.
 */
export function localDayStart(timezone: string | null, isoDate: string): Date {
  const [year, month, day] = isoDate.split('-').map(Number);
  return localMidnightUtc(validTimezone(timezone), year, month, day);
}

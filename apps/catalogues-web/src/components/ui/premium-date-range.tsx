'use client';
import { useMemo, useState } from 'react';
import { C } from '../tokens';
import { PremiumSelect } from './premium-select';

type Props = {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  onApply: () => void;
  onClear: () => void;
};

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function pad(n: number) {
  return n < 10 ? `0${n}` : `${n}`;
}

function toISO(y: number, m: number, d: number) {
  return `${y}-${pad(m + 1)}-${pad(d)}`;
}

function parseISO(iso: string): { y: number; m: number; d: number } | null {
  if (!iso) return null;
  const parts = iso.split('-').map(Number);
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (!y || !m || !d) return null;
  return { y, m: m - 1, d };
}

function sameISO(a: string, b: string) {
  return a && b && a === b;
}

function inRange(iso: string, from: string, to: string) {
  if (!from || !to) return false;
  return iso >= from && iso <= to;
}

function daysInMonth(y: number, m: number) {
  return new Date(y, m + 1, 0).getDate();
}

function buildMonthGrid(y: number, m: number) {
  const firstDow = new Date(y, m, 1).getDay();
  const dim = daysInMonth(y, m);
  const prevDim = daysInMonth(y, m - 1);
  const cells: Array<{ y: number; m: number; d: number; outside: boolean }> = [];

  for (let i = 0; i < firstDow; i++) {
    cells.push({
      y: m === 0 ? y - 1 : y,
      m: (m - 1 + 12) % 12,
      d: prevDim - firstDow + i + 1,
      outside: true,
    });
  }
  for (let d = 1; d <= dim; d++) cells.push({ y, m, d, outside: false });
  while (cells.length % 7 !== 0) {
    // biome-ignore lint/style/noNonNullAssertion: cells is non-empty at this point
    const last = cells[cells.length - 1]!;
    const nextM = last.m + 1;
    const nextY = nextM > 11 ? last.y + 1 : last.y;
    cells.push({ y: nextY, m: nextM % 12, d: last.d + 1, outside: true });
  }
  while (cells.length < 42) {
    // biome-ignore lint/style/noNonNullAssertion: cells is non-empty at this point
    const last = cells[cells.length - 1]!;
    const nextM = last.m + 1;
    const nextY = nextM > 11 ? last.y + 1 : last.y;
    cells.push({ y: nextY, m: nextM % 12, d: last.d + 1, outside: true });
  }
  return cells;
}

function fmtShort(iso: string) {
  const p = parseISO(iso);
  if (!p) return '—';
  const d = p.d as number;
  const m = p.m as number;
  const y = p.y as number;
  return `${pad(d)} ${MONTHS[m]?.slice(0, 3)} ${y}`;
}

export function PremiumDateRangePicker({ from, to, onChange, onApply, onClear }: Props) {
  const today = useMemo(() => {
    const d = new Date();
    return toISO(d.getFullYear(), d.getMonth(), d.getDate());
  }, []);

  const initial =
    parseISO(from) ||
    parseISO(to) ||
    (() => {
      const d = new Date();
      return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() };
    })();

  const [viewY, setViewY] = useState<number>(initial?.y);
  const [viewM, setViewM] = useState<number>(initial?.m);
  const [hoverIso, setHoverIso] = useState<string>('');

  const startIso = from;
  const endIso = to;
  const hasStart = !!startIso;
  const hasEnd = !!endIso;
  const rangeComplete = hasStart && hasEnd && startIso <= endIso;

  const previewFrom = !hasStart && hasEnd ? (hoverIso && hoverIso < endIso ? hoverIso : '') : '';
  const previewTo = !hasStart && hasEnd ? endIso : '';
  const hasPreview = !!(previewFrom && previewTo);

  function commit(y: number, m: number, d: number) {
    const iso = toISO(y, m, d);
    if (!hasStart || (hasStart && hasEnd)) {
      onChange(iso, '');
    } else {
      const start = startIso;
      if (iso < start) {
        onChange(iso, start);
      } else {
        onChange(start, iso);
      }
    }
  }

  function shiftMonth(delta: number) {
    let nm = viewM + delta;
    let ny = viewY;
    if (nm < 0) {
      nm = 11;
      ny--;
    }
    if (nm > 11) {
      nm = 0;
      ny++;
    }
    setViewM(nm);
    setViewY(ny);
  }

  const cells = useMemo(() => buildMonthGrid(viewY, viewM), [viewY, viewM]);

  const yearOptions = useMemo(() => {
    const arr: number[] = [];
    for (let y = viewY - 6; y <= viewY + 6; y++) arr.push(y);
    return arr;
  }, [viewY]);

  const canApply = !!(from || to);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 4,
        }}
      >
        <button
          type="button"
          className="focus-ring"
          onClick={() => shiftMonth(-1)}
          aria-label="Previous month"
          style={navBtn}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            flex: 1,
            justifyContent: 'center',
          }}
        >
          <PremiumSelect
            value={viewM}
            onChange={(v) => setViewM(Number(v))}
            ariaLabel="Month"
            minWidth={92}
            options={MONTHS.map((m, i) => ({ value: i, label: m }))}
          />
          <PremiumSelect
            value={viewY}
            onChange={(v) => setViewY(Number(v))}
            ariaLabel="Year"
            minWidth={68}
            options={yearOptions.map((y) => ({ value: y, label: String(y) }))}
          />
        </div>

        <button
          type="button"
          className="focus-ring"
          onClick={() => shiftMonth(1)}
          aria-label="Next month"
          style={navBtn}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gap: 0,
          rowGap: 2,
        }}
      >
        {WEEKDAYS.map((d) => (
          <div
            key={d}
            style={{
              textAlign: 'center',
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: C.light,
              padding: '4px 0 6px',
            }}
          >
            {d}
          </div>
        ))}
        {cells.map((c) => {
          const iso = toISO(c.y, c.m, c.d);
          const isStart = sameISO(iso, startIso);
          const isEnd = sameISO(iso, endIso);
          const isToday = sameISO(iso, today);
          const inSelRange = inRange(iso, startIso, endIso);
          const inPreview = hasPreview && inRange(iso, previewFrom, previewTo);
          const disabled = false;

          let bg: string = 'transparent';
          let color: string = c.outside ? C.lighter : C.text;
          let weight: number = 400;
          let border = 'none';
          let radius: string | number = 0;

          if (isStart || isEnd) {
            bg = C.dark;
            color = C.onDark;
            weight = 600;
            border = 'none';
          } else if (inSelRange || inPreview) {
            bg = 'var(--c-pink-tint)';
            color = C.text;
          } else if (isToday) {
            color = C.pink;
            weight = 600;
          }

          if (isStart && !isEnd) radius = '6px 0 0 6px';
          else if (isEnd && !isStart) radius = '0 6px 6px 0';
          else if (isStart && isEnd) radius = 6;
          else radius = 6;

          return (
            <button
              key={iso}
              type="button"
              className="focus-ring"
              disabled={disabled}
              onClick={() => commit(c.y, c.m, c.d)}
              onMouseEnter={() => setHoverIso(iso)}
              onMouseLeave={() => setHoverIso('')}
              aria-pressed={!!(isStart || isEnd)}
              aria-label={`${MONTHS[c.m]} ${c.d}, ${c.y}`}
              style={{
                height: 30,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: bg,
                color,
                fontWeight: weight,
                fontSize: 12.5,
                border: border,
                borderRadius: radius,
                cursor: 'pointer',
                fontFamily: 'inherit',
                position: 'relative',
                transition: 'background .12s, color .12s',
                padding: 0,
              }}
              onMouseOver={(e) => {
                if (!isStart && !isEnd)
                  e.currentTarget.style.background =
                    inSelRange || inPreview ? 'var(--c-pink-tint)' : 'var(--c-merchant-hover)';
              }}
              onFocus={(e) => {
                if (!isStart && !isEnd)
                  e.currentTarget.style.background =
                    inSelRange || inPreview ? 'var(--c-pink-tint)' : 'var(--c-merchant-hover)';
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.background = bg;
              }}
              onBlur={(e) => {
                e.currentTarget.style.background = bg;
              }}
            >
              {c.d}
            </button>
          );
        })}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          paddingTop: 8,
          borderTop: `1px solid ${C.border}`,
          fontSize: 11,
          color: C.mid,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: C.light,
            }}
          >
            From — To
          </span>
          <span
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: rangeComplete ? C.text : C.mid,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {rangeComplete
              ? `${fmtShort(startIso)}  →  ${fmtShort(endIso)}`
              : 'Pick a start and end date'}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="focus-ring date-clear-btn"
          onClick={onClear}
          style={{
            flex: 1,
            height: 32,
            borderRadius: 6,
            border: `1px solid ${C.border}`,
            background: 'none',
            fontFamily: 'inherit',
            fontSize: 12,
            fontWeight: 500,
            color: C.mid,
            transition: 'background .12s, color .12s',
          }}
        >
          Clear
        </button>
        <button
          type="button"
          className="focus-ring btn-hover-opacity"
          disabled={!canApply}
          onClick={onApply}
          style={{
            flex: 1,
            height: 32,
            borderRadius: 6,
            border: 'none',
            background: canApply ? C.dark : C.border,
            fontFamily: 'inherit',
            fontSize: 12,
            fontWeight: 600,
            color: canApply ? C.onDark : C.light,
            transition: 'opacity .12s',
          }}
        >
          Apply
        </button>
      </div>
    </div>
  );
}

const navBtn: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 6,
  border: 'none',
  background: 'none',
  color: 'var(--c-text)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  fontFamily: 'inherit',
  transition: 'background .12s',
};

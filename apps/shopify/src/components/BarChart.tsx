import { useState } from 'react';

export interface Bar {
  label: string;
  value: number;
}

/**
 * One SVG bar primitive in two orientations — vertical for the daily series,
 * horizontal for the funnel. Hand-rolled rather than pulling a charting
 * dependency: both charts here are single-series magnitude, and a library would
 * add a large tree and its own provider for ~60 lines of geometry.
 *
 * Colors are Polaris tokens, not hard-coded hex, so the chart follows the
 * admin's light/dark theme instead of needing a second hand-picked palette.
 * Single series means no legend — the surrounding heading names it.
 */
export function BarChart({
  data,
  orientation,
  formatValue = (n) => String(n),
}: {
  data: Bar[];
  orientation: 'vertical' | 'horizontal';
  formatValue?: (n: number) => string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));

  if (orientation === 'horizontal') {
    const ROW = 34;
    return (
      <div style={{ position: 'relative' }}>
        <svg
          width="100%"
          height={data.length * ROW}
          role="img"
          aria-label="Funnel by step"
          style={{ overflow: 'visible' }}
        >
          {data.map((d, i) => (
            // biome-ignore lint/a11y/noStaticElementInteractions: hover-only tooltip trigger; the funnel data is also exposed via ChartTable below
            <g
              key={d.label}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
            >
              {/* Full-width hit target: the bar itself can be 1px wide at zero. */}
              <rect x="0" y={i * ROW} width="100%" height={ROW} fill="transparent" />
              <rect
                x="0"
                y={i * ROW + 6}
                width={`${(d.value / max) * 70}%`}
                height={ROW - 14}
                rx="4"
                fill="var(--p-color-bg-fill-brand)"
                opacity={hovered === null || hovered === i ? 1 : 0.5}
              />
              <text x="72%" y={i * ROW + ROW / 2 + 4} fontSize="12" fill="var(--p-color-text)">
                {formatValue(d.value)} · {d.label}
              </text>
            </g>
          ))}
        </svg>
      </div>
    );
  }

  const COL = 100 / Math.max(1, data.length);
  return (
    <svg width="100%" height="180" role="img" aria-label="Try-ons per day">
      {data.map((d, i) => {
        const h = (d.value / max) * 150;
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: hover-only tooltip trigger; the daily data is also exposed via ChartTable below
          <g key={d.label} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)}>
            <rect x={`${i * COL}%`} y="0" width={`${COL}%`} height="180" fill="transparent" />
            <rect
              x={`${i * COL + COL * 0.15}%`}
              y={160 - h}
              width={`${COL * 0.7}%`}
              height={Math.max(h, d.value > 0 ? 2 : 0)}
              rx="4"
              fill="var(--p-color-bg-fill-brand)"
              opacity={hovered === null || hovered === i ? 1 : 0.5}
            />
            {hovered === i && (
              <text
                x={`${i * COL + COL / 2}%`}
                y={Math.max(12, 152 - h)}
                fontSize="12"
                textAnchor="middle"
                fill="var(--p-color-text)"
              >
                {formatValue(d.value)}
              </text>
            )}
          </g>
        );
      })}
      {/* Selective labels only — first and last. A number on every bar is noise. */}
      <text x="0" y="176" fontSize="11" fill="var(--p-color-text-secondary)">
        {data[0]?.label}
      </text>
      <text x="100%" y="176" fontSize="11" textAnchor="end" fill="var(--p-color-text-secondary)">
        {data[data.length - 1]?.label}
      </text>
    </svg>
  );
}

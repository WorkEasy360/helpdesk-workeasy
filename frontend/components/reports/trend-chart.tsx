'use client';

import { CHART_MARKERS, CHART_OTHER, CHART_SERIES, type ChartMarker } from '@/lib/design/tokens';

/**
 * A small inline-SVG line chart. No charting library: the product's own convention is
 * dense, unadorned data, and a handful of trend lines does not earn a dependency.
 *
 * Colours come from `--we-chart-1…3` in their fixed order, grid lines from
 * `--we-border` and the axes from the text tokens — never from the series colour. Each
 * series also carries a distinct marker shape and a legend label, so the chart reads
 * without colour. A fourth series folds into "Other". See docs/DESIGN-SYSTEM.md.
 */
export function TrendChart<T extends { day: string }>({
  data,
  series,
  height = 160,
}: {
  data: T[];
  series: { key: keyof T & string; label: string }[];
  height?: number;
}) {
  if (data.length === 0) {
    return <p className="text-base text-secondary">No data in this range.</p>;
  }

  const width = 640;
  const padding = 24;
  const max = Math.max(1, ...data.flatMap((point) => series.map((s) => Number(point[s.key]) || 0)));
  const stepX = data.length > 1 ? (width - padding * 2) / (data.length - 1) : 0;
  const scaleY = (value: number) => height - padding - (value / max) * (height - padding * 2);
  const pointsOf = (key: keyof T & string) =>
    data.map((point, index) => ({
      x: padding + index * stepX,
      y: scaleY(Number(point[key]) || 0),
    }));

  const colourOf = (index: number) => CHART_SERIES[index] ?? CHART_OTHER;
  const markerOf = (index: number): ChartMarker => CHART_MARKERS[index] ?? 'circle';

  // Thin every label out so a 90-day range does not overlap its own tick marks.
  const labelEvery = Math.max(1, Math.ceil(data.length / 8));

  return (
    <div className="c-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label={`Trend over time: ${series.map((s) => s.label).join(', ')}`}
      >
        <line
          className="c-chart-grid"
          x1={padding}
          y1={height - padding}
          x2={width - padding}
          y2={height - padding}
        />
        {series.map((s, index) => {
          const points = pointsOf(s.key);
          const path = points
            .map((point, i) => `${i === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`)
            .join(' ');
          const colour = colourOf(index);
          return (
            <g key={s.key}>
              <path d={path} fill="none" stroke={colour} strokeWidth={2} />
              {/* The marker repeats the series identity without relying on colour. */}
              {points
                .filter((_, i) => i % labelEvery === 0 || i === points.length - 1)
                .map((point, i) => (
                  <Marker key={i} shape={markerOf(index)} x={point.x} y={point.y} fill={colour} />
                ))}
            </g>
          );
        })}
      </svg>

      <div className="c-chart-legend mt-2">
        {series.map((s, index) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <svg width={10} height={10} viewBox="-5 -5 10 10" aria-hidden>
              <Marker shape={markerOf(index)} x={0} y={0} fill={colourOf(index)} />
            </svg>
            {s.label}
          </span>
        ))}
      </div>

      <div className="c-chart-legend mt-1 justify-between">
        {data
          .filter((_, index) => index % labelEvery === 0 || index === data.length - 1)
          .map((point, index) => (
            <span key={index}>{String(point.day ?? '').slice(5)}</span>
          ))}
      </div>
    </div>
  );
}

function Marker({
  shape,
  x,
  y,
  fill,
}: {
  shape: ChartMarker;
  x: number;
  y: number;
  fill: string;
}) {
  if (shape === 'square') {
    return <rect x={x - 2.5} y={y - 2.5} width={5} height={5} fill={fill} />;
  }
  if (shape === 'triangle') {
    return <polygon points={`${x},${y - 3} ${x + 3},${y + 2.5} ${x - 3},${y + 2.5}`} fill={fill} />;
  }
  if (shape === 'diamond') {
    return <polygon points={`${x},${y - 3.2} ${x + 3.2},${y} ${x},${y + 3.2} ${x - 3.2},${y}`} fill={fill} />;
  }
  return <circle cx={x} cy={y} r={2.5} fill={fill} />;
}

/** A horizontal bar breakdown — priority, status, channel, department counts. */
export function BarBreakdown({
  rows,
  colourFor,
}: {
  rows: { label: string; count: number }[];
  /** An organization's own status or priority colour, where it has one. */
  colourFor?: (label: string) => string | undefined;
}) {
  if (rows.length === 0) {
    return <p className="text-base text-secondary">Nothing in this range.</p>;
  }
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <ul className="c-barlist">
      {rows.map((row) => (
        <li key={row.label}>
          <span className="c-barlist-label">{row.label}</span>
          <span className="c-barlist-track">
            <span
              className="c-barlist-bar"
              style={{
                width: `${(row.count / max) * 100}%`,
                backgroundColor: colourFor?.(row.label),
              }}
            />
          </span>
          <span className="c-barlist-value">{row.count}</span>
        </li>
      ))}
    </ul>
  );
}

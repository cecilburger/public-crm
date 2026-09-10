export type ColumnItem = { label: string; value: number; display?: string };

/**
 * A true column chart — gridlines behind, one bar per category, value on the
 * cap. Every bar carries its own value as a direct label, so nothing here
 * depends on hover to be read (see BarList for the ranked-list alternative
 * when the row order matters more than the shape across categories).
 */
export function BarChart({ items }: { items: ColumnItem[] }) {
  const width = 600;
  const height = 200;
  const padTop = 28;
  const padBottom = 22;
  const chartH = height - padTop - padBottom;
  const baselineY = padTop + chartH;

  const max = Math.max(...items.map((i) => i.value), 1);
  const niceMax = Math.max(1, Math.ceil(max / 10) * 10);

  const bandWidth = width / items.length;
  const barWidth = Math.min(28, bandWidth * 0.4);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label="Diagram batang">
      {[0.25, 0.5, 0.75, 1].map((f) => {
        const y = padTop + chartH * (1 - f);
        return <line key={f} x1={0} y1={y} x2={width} y2={y} className="barchart-gridline" />;
      })}
      <line x1={0} y1={baselineY} x2={width} y2={baselineY} className="barchart-baseline" />
      {items.map((item, i) => {
        const cx = bandWidth * i + bandWidth / 2;
        const barH = Math.max((item.value / niceMax) * chartH, 2);
        const barY = baselineY - barH;
        return (
          <g key={item.label}>
            <title>{`${item.label}: ${item.display ?? item.value}`}</title>
            <rect x={cx - barWidth / 2} y={barY} width={barWidth} height={barH} rx={4} className="barchart-bar" />
            {/* Squares off the bottom of the rounded rect above so the mark
                reads as "rounded data-end, square at the baseline". */}
            <rect x={cx - barWidth / 2} y={baselineY - 4} width={barWidth} height={4} className="barchart-bar" />
            <text x={cx} y={barY - 8} className="barchart-value">{item.display ?? item.value}</text>
            <text x={cx} y={baselineY + 16} className="barchart-label">{item.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

export type RingItem = { label: string; value: number; display?: string; colorVar: string };

/**
 * Concentric progress rings — a meter bent into a circle, one ring per
 * series in fixed categorical order. The legend beside it is the dependable
 * identity channel (never color alone) and carries every value as text, so
 * reading it never depends on hovering a ring.
 *
 * `center` adds a headline figure in the middle — an overall number the
 * rings roll up to (an average, a total) — while the rings underneath still
 * carry the per-series breakdown. `showLegend` turns off the side legend for
 * a small-multiples grid where one shared legend (see the caller) already
 * says what each colour means, so repeating it per card would just be noise.
 */
export function RingChart({
  items, size = 132, strokeWidth = 10, gap = 3, center, showLegend = true,
}: {
  items: RingItem[];
  size?: number;
  strokeWidth?: number;
  gap?: number;
  center?: { value: string; label?: string };
  showLegend?: boolean;
}) {
  const cx = size / 2;
  const cy = size / 2;
  // The innermost ring bounds how much room the centre figure has — size the
  // value/label text off it instead of a fixed px so a denser stack of rings
  // (or a smaller card) never overlaps its own centre text.
  const innerR = cx - strokeWidth / 2 - (items.length - 1) * (strokeWidth + gap);
  const valueSize = Math.max(11, Math.min(21, Math.round(innerR * 0.62)));
  const labelSize = Math.max(7, Math.round(innerR * 0.26));

  return (
    <div className="ringchart">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Diagram lingkaran performa">
        <g transform={`rotate(-90 ${cx} ${cy})`}>
          {items.map((item, i) => {
            const r = cx - strokeWidth / 2 - i * (strokeWidth + gap);
            const circumference = 2 * Math.PI * r;
            const pct = Math.max(0, Math.min(100, item.value)) / 100;
            return (
              <g key={item.label}>
                <circle cx={cx} cy={cy} r={r} className="ring-track"
                        style={{ stroke: `var(${item.colorVar})`, strokeWidth }} />
                <circle cx={cx} cy={cy} r={r} className="ring-fill"
                        style={{
                          stroke: `var(${item.colorVar})`, strokeWidth,
                          strokeDasharray: circumference, strokeDashoffset: circumference * (1 - pct),
                        }}>
                  <title>{`${item.label}: ${item.display ?? `${item.value}%`}`}</title>
                </circle>
              </g>
            );
          })}
        </g>
        {center ? (
          <g>
            <text x={cx} y={center.label ? cy - valueSize * 0.2 : cy} className="ring-center-value"
                  style={{ fontSize: valueSize }}>
              {center.value}
            </text>
            {center.label ? (
              <text x={cx} y={cy + valueSize * 0.75} className="ring-center-label" style={{ fontSize: labelSize }}>
                {center.label}
              </text>
            ) : null}
          </g>
        ) : null}
      </svg>
      {showLegend ? (
        <div className="ring-legend">
          {items.map((item) => (
            <div className="ring-legend-row" key={item.label}>
              <span className="ring-legend-swatch" style={{ background: `var(${item.colorVar})` }} />
              <span className="ring-legend-label">{item.label}</span>
              <span className="ring-legend-value">{item.display ?? `${item.value}%`}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The JS half of the design system. `app/tokens.css` is the only place token *values*
 * live; this file holds the names, and the few helpers that need to compute a token at
 * runtime. See docs/DESIGN-SYSTEM.md.
 */

/** Chart series, in their fixed order. A fourth series folds into "Other". */
export const CHART_SERIES = ['var(--we-chart-1)', 'var(--we-chart-2)', 'var(--we-chart-3)'] as const;
export const CHART_OTHER = 'var(--we-chart-other)';

/**
 * A distinct marker per series, so a chart reads without colour. Index matches
 * `CHART_SERIES`; the fourth exists because a fourth series shares the "Other" colour
 * and still has to be told apart from the first.
 */
export const CHART_MARKERS = ['circle', 'square', 'triangle', 'diamond'] as const;
export type ChartMarker = (typeof CHART_MARKERS)[number];

export type StatusTone = 'success' | 'info' | 'warning' | 'error' | 'ai';

/** The three steps of a status, as CSS values. */
export function statusTokens(tone: StatusTone) {
  return {
    base: `var(--we-${tone})`,
    soft: `var(--we-${tone}-soft)`,
    text: `var(--we-${tone}-text)`,
  };
}

/** sRGB relative luminance, per WCAG 2.1. `null` if the colour cannot be parsed. */
export function relativeLuminance(color: string): number | null {
  const rgb = parseColor(color);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours, or `null` if either cannot be parsed. */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * These mirror `--we-on-color-dark` and `--we-on-color-light` in app/tokens.css. The
 * literals are needed here because the choice between them has to be *computed*, and
 * both tokens are deliberately theme-independent — which one applies depends on the
 * colour the customer chose, not on light or dark mode.
 */
const ON_COLOR_DARK = '#1B3040';
const ON_COLOR_LIGHT = '#F8FAFC';

/**
 * The text colour to put on an arbitrary background — used where a customer picks
 * their own brand colour and `--we-on-accent` has to be recomputed. Returns whichever
 * of the two has more contrast, so the pair clears 4.5:1 whatever colour they chose.
 */
export function onColorToken(background: string): string {
  const onDark = contrastRatio(background, ON_COLOR_DARK) ?? 0;
  const onLight = contrastRatio(background, ON_COLOR_LIGHT) ?? 0;
  return onDark >= onLight ? 'var(--we-on-color-dark)' : 'var(--we-on-color-light)';
}

/** `#rgb`, `#rrggbb` and `rgb()/rgba()` — the forms a stored brand colour takes. */
function parseColor(input: string): [number, number, number] | null {
  const value = input.trim();

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex?.[1]) {
    const digits = hex[1];
    const full =
      digits.length === 3
        ? digits
            .split('')
            .map((d) => d + d)
            .join('')
        : digits;
    return [
      Number.parseInt(full.slice(0, 2), 16),
      Number.parseInt(full.slice(2, 4), 16),
      Number.parseInt(full.slice(4, 6), 16),
    ];
  }

  const rgb = /^rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)/i.exec(value);
  if (rgb?.[1] && rgb[2] && rgb[3]) {
    const channels = [rgb[1], rgb[2], rgb[3]].map((n) => {
      const parsed = Number.parseFloat(n);
      return Math.min(255, Math.max(0, parsed));
    }) as [number, number, number];
    return channels;
  }

  return null;
}

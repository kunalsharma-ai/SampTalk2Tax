/**
 * Talk2Tax design tokens (Directive Part 27 / 46).
 * Palette: deep midnight navy with the logo's teal, sky and deep blue, plus indigo, emerald,
 * soft violet, warm amber for warnings, neutral white and graphite.
 * The CSS in tokens.css is the runtime source; this module mirrors it for charts and tests.
 */
export const palette = {
  /** The Talk2Tax logo colours. */
  brand: { teal: '#5eead4', sky: '#0ea5e9', blue: '#1d4ed8' },
  midnight: { 950: '#050a18', 900: '#0a1228', 850: '#0e1833', 800: '#132042', 700: '#1c2c57', 600: '#2a3d6e' },
  cyan: { 300: '#7ee8fa', 400: '#38d9f5', 500: '#12c2e9' },
  indigo: { 300: '#a5b4fc', 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5' },
  emerald: { 300: '#6ee7b7', 400: '#34d399', 500: '#10b981' },
  violet: { 300: '#c4b5fd', 400: '#a78bfa' },
  amber: { 300: '#fcd34d', 400: '#fbbf24', 500: '#f59e0b' },
  rose: { 300: '#fda4af', 400: '#fb7185', 500: '#f43f5e' },
  graphite: { 50: '#f5f7fb', 100: '#e6eaf2', 200: '#c9d1e0', 300: '#a3aec4', 400: '#7c88a3', 500: '#5b6782' },
} as const;

/** Semantic roles used by components (dark theme is the primary theme). */
export const semantic = {
  bg: palette.midnight[950],
  surface: palette.midnight[900],
  surfaceRaised: palette.midnight[850],
  border: palette.midnight[700],
  text: palette.graphite[50],
  textMuted: palette.graphite[300],
  accent: palette.brand.teal,
  accentStrong: palette.brand.sky,
  positive: palette.emerald[400],
  warning: palette.amber[400],
  negative: palette.rose[400],
} as const;

/** Chart series colours, in order. Checked for contrast against the surface in tests. */
export const chartSeries = [palette.brand.sky, palette.indigo[400], palette.emerald[400], palette.violet[400], palette.amber[400]] as const;

export const radius = { sm: '6px', md: '10px', lg: '14px', xl: '20px' } as const;
export const motion = { fast: '120ms', base: '200ms', slow: '320ms', easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' } as const;

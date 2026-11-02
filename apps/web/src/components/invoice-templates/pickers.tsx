'use client';
import { INVOICE_THEMES, PALETTE_KEYS, PRESET_PALETTES, type InvoicePalette, type InvoiceTheme } from '@talk2tax/accounting-engine';

export function Swatches({ palette, size = 'md' }: { palette: InvoicePalette; size?: 'sm' | 'md' }) {
  const s = size === 'sm' ? 'size-3.5' : 'size-5';
  return (
    <span className="inline-flex shrink-0 overflow-hidden rounded-full border border-line" aria-hidden>
      {(['primary', 'accent', 'surface', 'text'] as const).map((k) => <span key={k} className={s} style={{ background: palette[k] }} />)}
    </span>
  );
}

/** A small drawing of each theme, in its own colours, so the choice is visual. */
function ThemeSketch({ theme }: { theme: InvoiceTheme }) {
  const c = { primary: '#334155', accent: '#64748b', soft: '#e2e8f0' };
  return (
    <svg viewBox="0 0 60 44" className="h-11 w-full" aria-hidden>
      <rect x="0" y="0" width="60" height="44" rx="3" fill="#fff" stroke="#cbd5e1" />
      {theme === 'MODERN' ? <rect x="0" y="0" width="60" height="11" rx="3" fill={c.primary} /> : null}
      {theme === 'CLASSIC' ? <rect x="0" y="0" width="60" height="2.5" fill={c.primary} /> : null}
      {theme === 'BOLD' ? <rect x="0" y="0" width="4" height="44" fill={c.accent} /> : null}
      {theme === 'ELEGANT' ? (
        <>
          <rect x="22" y="4" width="16" height="3" fill={c.primary} />
          <line x1="6" y1="10" x2="54" y2="10" stroke={c.accent} strokeWidth="0.6" />
          <line x1="6" y1="11.5" x2="54" y2="11.5" stroke={c.accent} strokeWidth="0.6" />
        </>
      ) : (
        <rect x={theme === 'BOLD' ? 8 : 5} y={theme === 'MODERN' ? 4 : 5} width={theme === 'BOLD' ? 24 : 16} height={theme === 'BOLD' ? 5 : 3} fill={theme === 'MODERN' ? '#fff' : c.primary} />
      )}
      <rect x="6" y="17" width="48" height="4" fill={theme === 'MINIMAL' ? '#fff' : theme === 'BOLD' ? '#0f172a' : c.soft} stroke={theme === 'MINIMAL' ? c.primary : 'none'} strokeWidth="0.4" />
      {[24, 28, 32].map((y) => <line key={y} x1="6" y1={y} x2="54" y2={y} stroke={c.soft} strokeWidth="0.8" />)}
      <rect x="36" y="35" width="18" height="5" fill={theme === 'BOLD' ? c.primary : theme === 'MODERN' ? c.soft : '#fff'} stroke={theme === 'BOLD' || theme === 'MODERN' ? 'none' : c.primary} strokeWidth="0.5" />
    </svg>
  );
}

export function ThemePicker({ value, onChange }: { value: InvoiceTheme; onChange: (t: InvoiceTheme) => void }) {
  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      {INVOICE_THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          role="radio"
          aria-checked={value === t.id}
          title={t.description}
          onClick={() => onChange(t.id)}
          className={`rounded-md border p-2 text-left text-xs ${value === t.id ? 'border-accent bg-accent/10 text-fg' : 'border-line text-fg-muted hover:bg-surface-hover'}`}
        >
          <ThemeSketch theme={t.id} />
          <span className="mt-1 block font-medium">{t.name}</span>
        </button>
      ))}
    </div>
  );
}

export function PalettePicker({ value, onChange }: { value: string | null; onChange: (id: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Colour palette" className="flex flex-wrap gap-2">
      {PRESET_PALETTES.map((p) => (
        <button
          key={p.id}
          type="button"
          role="radio"
          aria-checked={value === p.id}
          onClick={() => onChange(p.id)}
          className={`flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs ${value === p.id ? 'border-accent bg-accent/10 text-fg' : 'border-line text-fg-muted hover:bg-surface-hover'}`}
        >
          <Swatches palette={p.palette} size="sm" />
          {p.name}
        </button>
      ))}
    </div>
  );
}

const COLOUR_LABEL: Record<keyof InvoicePalette, string> = {
  primary: 'Primary',
  accent: 'Accent',
  text: 'Text',
  muted: 'Secondary text',
  background: 'Background',
  surface: 'Table header and boxes',
  border: 'Lines and borders',
};

/** Every colour of a palette, each with a colour picker and a hex box. */
export function ColourEditor({ palette, onChange }: { palette: InvoicePalette; onChange: (p: InvoicePalette) => void }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {PALETTE_KEYS.map((k) => (
        <label key={k} className="flex items-center gap-2 text-sm">
          <input
            type="color"
            aria-label={`${COLOUR_LABEL[k]} colour`}
            value={palette[k]}
            onChange={(e) => onChange({ ...palette, [k]: e.target.value })}
            className="h-8 w-10 cursor-pointer rounded border border-line bg-transparent"
          />
          <input
            aria-label={`${COLOUR_LABEL[k]} hex`}
            value={palette[k]}
            maxLength={7}
            onChange={(e) => onChange({ ...palette, [k]: e.target.value.trim() })}
            className="h-8 w-24 rounded border border-line bg-surface px-2 font-mono text-xs text-fg"
          />
          <span className="text-fg-muted">{COLOUR_LABEL[k]}</span>
        </label>
      ))}
    </div>
  );
}

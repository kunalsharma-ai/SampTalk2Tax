/**
 * The Talk2Tax logo: the speech-bubble mark with "Talk2Tax · Talk. File. Relax. · by Sampledge".
 * Files come from packages/design-system/brand via scripts/brand-assets.mjs. A plain <img> on
 * purpose: the SVG animates itself, and next/image would add nothing for a vector file.
 *
 * - `animated` plays the logo's own motion (sign-in and first-run pages). The SVG turns its
 *   motion off by itself under prefers-reduced-motion. Inside the app the still version is used,
 *   so nothing moves beside people's work.
 * - `tone="dark"` is for dark backgrounds (the app), `tone="light"` for white paper (print).
 */
const HEIGHT = { sm: 'h-10', md: 'h-12', lg: 'h-16', xl: 'h-24' } as const;

export function Logo({
  size = 'md',
  animated = false,
  tone = 'dark',
  className = '',
}: {
  size?: keyof typeof HEIGHT;
  animated?: boolean;
  tone?: 'dark' | 'light';
  className?: string;
}) {
  const src = `/brand/logo-${tone}${animated ? '' : '-still'}.svg`;
  return <img src={src} alt="Talk2Tax by Sampledge" width={285} height={78} className={`${HEIGHT[size]} w-auto max-w-full select-none ${className}`} draggable={false} />;
}

/** The mark alone, for tight spaces. */
export function LogoMark({ className = 'size-8', animated = false }: { className?: string; animated?: boolean }) {
  return <img src={animated ? '/brand/icon.svg' : '/brand/icon-still.svg'} alt="Talk2Tax" width={78} height={78} className={className} draggable={false} />;
}

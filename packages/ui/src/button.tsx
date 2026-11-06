import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from './cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const variants: Record<Variant, string> = {
  primary: 'bg-[image:var(--t2t-gradient-action)] text-[#050a18] font-semibold hover:brightness-110 shadow-[0_8px_24px_-12px_rgba(14,165,233,0.65)]',
  secondary: 'bg-surface-raised text-fg border border-line hover:bg-surface-hover',
  ghost: 'text-fg-muted hover:text-fg hover:bg-surface-hover',
  danger: 'bg-negative/15 text-negative border border-negative/40 hover:bg-negative/25',
};
const sizes: Record<Size, string> = { sm: 'h-8 px-3 text-sm', md: 'h-10 px-4 text-sm' };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, disabled, className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-[var(--t2t-radius-md)] transition-[filter,background-color,color] duration-[var(--t2t-motion-base)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--t2t-focus)] disabled:opacity-50 disabled:cursor-not-allowed',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {loading ? <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden /> : null}
      {children}
    </button>
  );
});

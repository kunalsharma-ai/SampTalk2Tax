import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from './cn';

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn('w-full border-collapse text-sm', className)} {...props} />
    </div>
  );
}
export function Th({ className, numeric, ...props }: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return <th scope="col" className={cn('border-b border-line px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-fg-muted', numeric && 'text-right', className)} {...props} />;
}
export function Td({ className, numeric, ...props }: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return <td className={cn('border-b border-line/60 px-4 py-2.5 text-fg', numeric && 'text-right font-mono tabular-nums', className)} {...props} />;
}
export function Tr({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('transition-colors hover:bg-surface-hover/60', className)} {...props} />;
}

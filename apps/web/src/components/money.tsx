import { cn } from '@talk2tax/ui';
import { isNegative, money } from '@/lib/format';

export function Money({ value, currency, className, signed }: { value: string | null | undefined; currency: string; className?: string; signed?: boolean }) {
  const neg = value ? isNegative(value) : false;
  return <span className={cn('num whitespace-nowrap', signed && neg && 'text-negative', className)}>{money(value, currency)}</span>;
}

'use client';
import { useQuery } from '@tanstack/react-query';
import { Input, Select } from '@talk2tax/ui';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { useOrg } from '@/lib/org';

/** Currencies offered for documents and payments; any currency with a recorded rate is added. */
export const COMMON_CURRENCIES = ['USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD', 'JPY', 'CHF', 'SAR'];

interface Rate { id: string; currency: string; date: string; rate: string; source: string | null }

/** The latest recorded rate on or before a date. */
function rateOn(rates: Rate[], currency: string, date: string) {
  return rates.filter((r) => r.currency === currency && r.date <= date).sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
}

/** The organisation's recorded rate for a currency on or before a date (null in the home currency or when none). */
export function useRecordedRate(currency: string, date: string) {
  const { org, orgId } = useOrg();
  const rates = useQuery({ queryKey: ['fx-rates', orgId], queryFn: () => api<Rate[]>(`/v1/orgs/${orgId}/fx/rates`), retry: false });
  const foreign = !!org && currency !== org.functionalCurrency;
  return { recorded: foreign && date ? rateOn(rates.data ?? [], currency, date) : null, rates: rates.data ?? [] };
}

/**
 * Currency and exchange-rate fields for an invoice, bill, credit or payment. In another currency
 * the rate is the one entered, or else the organisation's recorded rate on or before the date
 * (the server takes the same one). Shows the amount in the functional currency at that rate.
 */
export function CurrencyRate({ currency, setCurrency, rate, setRate, date, amount, locked, id = 'cur' }: {
  currency: string;
  setCurrency: (c: string) => void;
  rate: string;
  setRate: (r: string) => void;
  date: string;
  /** The amount in the chosen currency, to show it converted. */
  amount?: string | null;
  /** Why the currency cannot change (for example TDS on this bill); null when it can. */
  locked?: string | null;
  id?: string;
}) {
  const { org } = useOrg();
  const fc = org?.functionalCurrency ?? 'INR';
  const { recorded, rates } = useRecordedRate(currency, date);
  const options = [...new Set([fc, ...COMMON_CURRENCIES, ...rates.map((r) => r.currency), currency])].filter(Boolean);
  const foreign = currency !== fc;
  const used = rate.trim() || recorded?.rate || '';
  const converted = foreign && used && amount && Number.isFinite(Number(amount)) ? (Math.round(Number(amount) * Number(used) * 100) / 100).toFixed(2) : null;
  return (
    <>
      <label htmlFor={`${id}-currency`} className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
        Currency
        <Select id={`${id}-currency`} value={currency} disabled={!!locked && !foreign} onChange={(e) => { setCurrency(e.target.value); setRate(''); }}>
          {options.map((x) => <option key={x} value={x}>{x}{x === fc ? ' (home currency)' : ''}</option>)}
        </Select>
        {locked && !foreign ? <span className="normal-case tracking-normal text-fg-faint">{locked}</span> : null}
      </label>
      {foreign ? (
        <label htmlFor={`${id}-rate`} className="flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted">
          Exchange rate ({fc} per 1 {currency})
          <Input id={`${id}-rate`} className="num" inputMode="decimal" value={rate} placeholder={recorded?.rate ?? 'Enter the rate'} onChange={(e) => /^\d{0,14}(\.\d{0,10})?$/.test(e.target.value) && setRate(e.target.value)} />
          <span className="normal-case tracking-normal text-fg-faint" aria-live="polite">
            {rate.trim()
              ? 'The rate you entered is kept with the record.'
              : recorded
                ? `Recorded rate on ${recorded.date}${recorded.source ? ` (${recorded.source})` : ''}.`
                : `No ${currency} rate on or before this date: enter one, or add it under Exchange rates.`}
            {converted ? ` ${money(amount!, currency)} = ${money(converted, fc)}.` : ''}
          </span>
        </label>
      ) : null}
    </>
  );
}

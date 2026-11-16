'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Field, Input, Select } from '@talk2tax/ui';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Logo } from '@/components/brand';
import { api, ApiError } from '@/lib/api';
import type { Org } from '@/lib/types';

const COUNTRIES = [
  ['IN', 'India', 'INR', 4],
  ['US', 'United States', 'USD', 1],
  ['GB', 'United Kingdom', 'GBP', 4],
  ['AE', 'United Arab Emirates', 'AED', 1],
  ['SG', 'Singapore', 'SGD', 1],
  ['AU', 'Australia', 'AUD', 7],
  ['CA', 'Canada', 'CAD', 1],
  ['DE', 'Germany', 'EUR', 1],
] as const;
const CURRENCIES = ['INR', 'USD', 'GBP', 'EUR', 'AED', 'SGD', 'AUD', 'CAD', 'JPY', 'SAR'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const schema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(200),
  legalName: z.string().trim().max(300).optional(),
  countryCode: z.string().length(2),
  functionalCurrency: z.string().length(3),
  fiscalYearStartMonth: z.coerce.number().int().min(1).max(12),
  chartTemplate: z.enum(['GENERIC_SMB', 'EMPTY']),
});
type Values = z.infer<typeof schema>;

export default function OnboardingPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const form = useForm<z.input<typeof schema>, unknown, Values>({
    resolver: zodResolver(schema),
    defaultValues: { countryCode: 'IN', functionalCurrency: 'INR', fiscalYearStartMonth: 4, chartTemplate: 'GENERIC_SMB' },
  });
  const create = useMutation({
    mutationFn: (v: Values) => api<Org>('/v1/orgs', { method: 'POST', body: { ...v, legalName: v.legalName || undefined } }),
    onSuccess: async (org) => {
      await qc.invalidateQueries({ queryKey: ['orgs'] });
      router.replace(`/orgs/${org.id}`);
    },
  });
  const { errors } = form.formState;

  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-6 py-12">
      <Logo />
      <h1 className="mt-8 text-3xl font-semibold tracking-tight">Set up your organisation</h1>
      <p className="mt-2 text-sm text-fg-muted">This creates your books: a starter chart of accounts and the current fiscal year, split into monthly periods. You can change accounts later.</p>
      <Card className="mt-8 p-6">
        <form className="grid gap-5 sm:grid-cols-2" onSubmit={form.handleSubmit((v) => create.mutate(v))} noValidate>
          {create.error ? (
            <div className="sm:col-span-2">
              <Alert title="Could not create the organisation">{create.error instanceof ApiError ? create.error.message : 'Try again.'}</Alert>
            </div>
          ) : null}
          <div className="sm:col-span-2">
            <Field label="Organisation name" error={errors.name?.message}>
              {(p) => <Input {...p} placeholder="e.g. Acme Consulting" {...form.register('name')} />}
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Legal name (optional)">{(p) => <Input {...p} {...form.register('legalName')} />}</Field>
          </div>
          <Field label="Country">
            {(p) => (
              <Select
                {...p}
                {...form.register('countryCode', {
                  onChange: (e) => {
                    const c = COUNTRIES.find((x) => x[0] === e.target.value);
                    if (c) {
                      form.setValue('functionalCurrency', c[2]);
                      form.setValue('fiscalYearStartMonth', c[3]);
                    }
                  },
                })}
              >
                {COUNTRIES.map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Functional currency" hint="The currency your books are kept in.">
            {(p) => (
              <Select {...p} {...form.register('functionalCurrency')}>
                {CURRENCIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Fiscal year starts in">
            {(p) => (
              <Select {...p} {...form.register('fiscalYearStartMonth')}>
                {MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>
                    {m}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Chart of accounts">
            {(p) => (
              <Select {...p} {...form.register('chartTemplate')}>
                <option value="GENERIC_SMB">Starter chart for small businesses</option>
                <option value="EMPTY">Start empty</option>
              </Select>
            )}
          </Field>
          <p className="text-xs text-fg-faint sm:col-span-2">You can add tax rates afterwards under Tax rates. Bank connections and data imports come in later releases. Nothing here files anything with any authority.</p>
          <div className="flex justify-end sm:col-span-2">
            <Button type="submit" loading={create.isPending}>
              Create organisation
            </Button>
          </div>
        </form>
      </Card>
    </main>
  );
}

'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { detectStatementFormat, parseCsv } from '@talk2tax/accounting-engine';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { ImportPreview } from '@/lib/types';
import { useBankAccounts } from './accounts-page';

const FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD-MM-YYYY', 'DD.MM.YYYY'] as const;
type Delim = ',' | ';' | '\t';

interface Mapping {
  date: number;
  description: number;
  reference: number | null;
  mode: 'single' | 'split';
  amount: number | null;
  moneyIn: number | null;
  moneyOut: number | null;
  dateFormat: (typeof FORMATS)[number];
  hasHeader: boolean;
  delimiter: Delim;
  invertAmount: boolean;
  /** The running balance column, if the statement has one. */
  balance: number | null;
}

/** Guesses columns from common bank header names. The user can change every choice. */
function guess(header: string[], sample: string[] | undefined): Partial<Mapping> {
  const find = (re: RegExp) => {
    const i = header.findIndex((h) => re.test(h.trim()));
    return i >= 0 ? i : null;
  };
  const moneyOut = find(/withdraw|debit|money out|paid out|^dr$/i);
  const moneyIn = find(/deposit|credit|money in|paid in|^cr$/i);
  const amount = find(/^amount|txn amount|transaction amount/i);
  const dateCol = find(/date/i) ?? 0;
  const raw = sample?.[dateCol] ?? '';
  const dateFormat: Mapping['dateFormat'] = /^\d{4}-/.test(raw) ? 'YYYY-MM-DD' : /^\d{1,2}-\d{1,2}-\d{4}$/.test(raw) ? 'DD-MM-YYYY' : /^\d{1,2}\.\d{1,2}\.\d{4}$/.test(raw) ? 'DD.MM.YYYY' : 'DD/MM/YYYY';
  return {
    date: dateCol,
    description: find(/narration|description|particulars|details|remarks/i) ?? 1,
    reference: find(/ref|cheque|chq|utr/i),
    balance: find(/balance/i),
    ...(amount !== null || moneyIn === null || moneyOut === null ? { mode: 'single' as const, amount: amount ?? 2 } : { mode: 'split' as const, moneyIn, moneyOut }),
    dateFormat,
  };
}

export function ImportStatementPage() {
  const { org, orgId } = useOrg();
  const { accountId } = useParams<{ accountId: string }>();
  const accounts = useBankAccounts();
  const account = accounts.data?.find((a) => a.id === accountId);
  const router = useRouter();
  const qc = useQueryClient();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [m, setM] = useState<Mapping>({ date: 0, description: 1, reference: null, mode: 'single', amount: 2, moneyIn: null, moneyOut: null, dateFormat: 'DD/MM/YYYY', hasHeader: true, delimiter: ',', invertAmount: false, balance: null });
  const [readError, setReadError] = useState<string | null>(null);
  /** Detected from the file: OFX, QIF and MT940 need no column mapping. */
  const [format, setFormat] = useState<'CSV' | 'OFX' | 'QIF' | 'MT940'>('CSV');

  const rows = useMemo(() => {
    if (!file) return [];
    try {
      return parseCsv(file.text, m.delimiter);
    } catch {
      return [];
    }
  }, [file, m.delimiter]);
  const width = Math.max(0, ...rows.slice(0, 20).map((r) => r.length));
  const header = m.hasHeader ? rows[0] ?? [] : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  const columns = Array.from({ length: width }, (_, i) => ({ i, label: header[i]?.trim() || `Column ${i + 1}` }));

  const body = () => format !== 'CSV' ? { fileName: file!.name, csv: file!.text, format, ...(format === 'QIF' ? { dateFormat: m.dateFormat } : {}) } : ({
    fileName: file!.name,
    csv: file!.text,
    format,
    mapping: {
      date: m.date,
      description: m.description,
      reference: m.reference,
      ...(m.mode === 'single' ? { amount: m.amount, invertAmount: m.invertAmount } : { moneyIn: m.moneyIn, moneyOut: m.moneyOut }),
      dateFormat: m.dateFormat,
      hasHeader: m.hasHeader,
      delimiter: m.delimiter,
      balance: m.balance,
    },
  });
  const preview = useMutation({ mutationFn: () => api<ImportPreview>(`/v1/orgs/${orgId}/banking/accounts/${accountId}/imports`, { method: 'POST', body: { ...body(), dryRun: true } }) });
  const save = useMutation({
    mutationFn: () => api<ImportPreview>(`/v1/orgs/${orgId}/banking/accounts/${accountId}/imports`, { method: 'POST', body: body() }),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ['bank-lines', orgId, accountId] }), qc.invalidateQueries({ queryKey: ['bank-accounts', orgId] })]);
      router.push(`/orgs/${orgId}/banking/${accountId}`);
    },
  });

  const onFile = async (f: File | undefined) => {
    preview.reset();
    save.reset();
    setReadError(null);
    if (!f) return setFile(null);
    if (f.size > 2_000_000) return setReadError('The file is larger than 2 MB. Split it into smaller periods.');
    const text = await f.text();
    const detected = detectStatementFormat(text);
    setFormat(detected ?? 'CSV');
    if (detected) return setFile({ name: f.name, text });
    const delimiter: Delim = text.split('\n')[0].includes('\t') ? '\t' : (text.split('\n')[0].match(/;/g)?.length ?? 0) > (text.split('\n')[0].match(/,/g)?.length ?? 0) ? ';' : ',';
    setFile({ name: f.name, text });
    try {
      const parsed = parseCsv(text, delimiter);
      setM((cur) => ({ ...cur, delimiter, ...guess(parsed[0] ?? [], parsed[1]) }));
    } catch (e) {
      setReadError((e as Error).message);
    }
  };

  if (!org) return null;
  const c = org.functionalCurrency;
  const failure = preview.error ?? save.error;
  const issues = failure instanceof ApiError ? failure.issues : undefined;
  const colSelect = (label: string, value: number | null, set: (v: number | null) => void, optional = false) => (
    <Field label={label}>
      {(p) => (
        <Select {...p} value={value === null ? '' : String(value)} onChange={(e) => { preview.reset(); set(e.target.value === '' ? null : Number(e.target.value)); }}>
          {optional ? <option value="">None</option> : null}
          {columns.map((col) => <option key={col.i} value={col.i}>{col.label}</option>)}
        </Select>
      )}
    </Field>
  );
  const set = (patch: Partial<Mapping>) => { preview.reset(); setM({ ...m, ...patch }); };

  return (
    <>
      <PageHeader
        title={`Import a statement${account ? ` · ${account.code} ${account.name}` : ''}`}
        description="Upload a statement downloaded from your bank: CSV, OFX/QFX, QIF or MT940. Nothing is stored until you confirm the preview, and lines that were imported before are skipped."
      />
      <Card className="mb-6 p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Statement file" hint="CSV, OFX/QFX, QIF or MT940">{(p) => <Input {...p} type="file" accept=".csv,.ofx,.qfx,.qif,.sta,.mt940,.940,.txt,text/csv,text/plain" onChange={(e) => onFile(e.target.files?.[0])} />}</Field>
          {file && format !== 'CSV' ? (
            <>
              <div className="self-end pb-2 text-sm"><Badge tone="accent">{format} file</Badge> <span className="text-fg-muted">read as it is: no columns to map</span></div>
              {format === 'QIF' ? (
                <Field label="Dates in the file">
                  {(p) => (
                    <Select {...p} value={m.dateFormat.startsWith('MM') ? 'MM/DD/YYYY' : 'DD/MM/YYYY'} onChange={(e) => set({ dateFormat: e.target.value as Mapping['dateFormat'] })}>
                      <option value="DD/MM/YYYY">Day first (25/12/2026)</option>
                      <option value="MM/DD/YYYY">Month first (12/25/2026)</option>
                    </Select>
                  )}
                </Field>
              ) : null}
            </>
          ) : null}
          {file && format === 'CSV' ? (
            <>
              <Field label="Separator">
                {(p) => (
                  <Select {...p} value={m.delimiter} onChange={(e) => set({ delimiter: e.target.value as Delim })}>
                    <option value=",">Comma</option>
                    <option value=";">Semicolon</option>
                    <option value={'\t'}>Tab</option>
                  </Select>
                )}
              </Field>
              <label className="flex items-center gap-2 self-end pb-2 text-sm text-fg-muted">
                <input type="checkbox" className="accent-[var(--t2t-accent)]" checked={m.hasHeader} onChange={(e) => set({ hasHeader: e.target.checked })} /> First row is a header
              </label>
              {colSelect('Date column', m.date, (v) => set({ date: v ?? 0 }))}
              <Field label="Date format">
                {(p) => (
                  <Select {...p} value={m.dateFormat} onChange={(e) => set({ dateFormat: e.target.value as Mapping['dateFormat'] })}>
                    {FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
                  </Select>
                )}
              </Field>
              {colSelect('Description column', m.description, (v) => set({ description: v ?? 0 }))}
              {colSelect('Reference column', m.reference, (v) => set({ reference: v }), true)}
              <Field label="Amounts are in">
                {(p) => (
                  <Select {...p} value={m.mode} onChange={(e) => set({ mode: e.target.value as 'single' | 'split' })}>
                    <option value="single">One column (money out negative)</option>
                    <option value="split">Separate money in and money out columns</option>
                  </Select>
                )}
              </Field>
              {m.mode === 'single' ? (
                <>
                  {colSelect('Amount column', m.amount, (v) => set({ amount: v }))}
                  <label className="flex items-center gap-2 self-end pb-2 text-sm text-fg-muted">
                    <input type="checkbox" className="accent-[var(--t2t-accent)]" checked={m.invertAmount} onChange={(e) => set({ invertAmount: e.target.checked })} /> My bank shows money out as positive
                  </label>
                </>
              ) : (
                <>
                  {colSelect('Money in column', m.moneyIn, (v) => set({ moneyIn: v }), true)}
                  {colSelect('Money out column', m.moneyOut, (v) => set({ moneyOut: v }), true)}
                </>
              )}
              {colSelect('Balance column', m.balance, (v) => set({ balance: v }), true)}
            </>
          ) : null}
        </div>
        {readError ? <div className="mt-4"><Alert title="Could not read the file">{readError}</Alert></div> : null}
        {file ? (
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" loading={preview.isPending} onClick={() => preview.mutate()}>Preview</Button>
          </div>
        ) : null}
      </Card>

      {preview.error ?? save.error ? (
        <div className="mb-6">
          <Alert title={(preview.error ?? save.error)!.message}>
            {issues?.length ? <ul className="mt-1 list-disc pl-5">{issues.map((i) => <li key={i}>{i}</li>)}</ul> : null}
          </Alert>
        </div>
      ) : null}

      {preview.data ? (
        <Card>
          <CardHeader
            title={`${preview.data.newCount} new line${preview.data.newCount === 1 ? '' : 's'}`}
            description={
              <span>
                Money in <Money value={preview.data.moneyIn} currency={c} /> · money out <Money value={preview.data.moneyOut} currency={c} />
                {preview.data.duplicateCount ? ` · ${preview.data.duplicateCount} already imported, will be skipped` : ''}
                {preview.data.blockedRows.length ? ` · ${preview.data.blockedRows.length} fall on or before the last reconciliation (${date(preview.data.reconciledUntil!)})` : ''}
              </span>
            }
            actions={<Button loading={save.isPending} disabled={!preview.data.newCount || preview.data.blockedRows.length > 0} onClick={() => save.mutate()}>Import {preview.data.newCount} line{preview.data.newCount === 1 ? '' : 's'}</Button>}
          />
          {preview.data.fileTotals && Number(preview.data.fileTotals.difference) !== 0 ? (
            <div className="px-5 pb-4">
              <Alert tone="warning" title="The file does not add up to the bank's closing balance">
                Opening <Money value={preview.data.fileTotals.opening} currency={c} /> plus these lines gives <Money value={preview.data.fileTotals.computed} currency={c} />, but the file closes at <Money value={preview.data.fileTotals.closing} currency={c} /> (difference <Money value={preview.data.fileTotals.difference} currency={c} signed />). Lines may be missing; download the statement again.
              </Alert>
            </div>
          ) : preview.data.fileTotals ? (
            <p className="px-5 pb-4 text-sm text-positive">The lines add up from the opening balance <Money value={preview.data.fileTotals.opening} currency={c} /> to the closing balance <Money value={preview.data.fileTotals.closing} currency={c} />.</p>
          ) : null}
          {preview.data.balanceCheck ? (
            <div className="px-5 pb-4">
              {preview.data.balanceCheck.breaks.length ? (
                <Alert tone="warning" title={`The running balance breaks in ${preview.data.balanceCheck.breaks.length} place${preview.data.balanceCheck.breaks.length === 1 ? '' : 's'}: lines may be missing from this file`}>
                  <ul className="mt-1 list-disc pl-5" aria-label="Balance breaks">
                    {preview.data.balanceCheck.breaks.map((b) => (
                      <li key={b.row}>
                        Between row {b.previousRow} ({date(b.previousDate)}) and row {b.row} ({date(b.date)}): the balance should be <Money value={b.expected} currency={c} /> but the statement shows <Money value={b.shown} currency={c} />, so <Money value={b.gap.replace(/^-/, '')} currency={c} /> {b.gap.startsWith('-') ? 'went out' : 'came in'} without a line. Download the statement for those dates again, or add the line by hand after importing.
                      </li>
                    ))}
                  </ul>
                </Alert>
              ) : (
                <p className="text-sm text-positive">Running balance checked on {preview.data.balanceCheck.checked} lines: every line follows from the one before, so none are missing.</p>
              )}
            </div>
          ) : null}
          <Table>
            <thead>
              <tr><Th>Row</Th><Th>Date</Th><Th>Description</Th><Th>Reference</Th><Th numeric>Amount</Th>{preview.data.balanceCheck ? <Th numeric>Balance</Th> : null}<Th><span className="sr-only">Status</span></Th></tr>
            </thead>
            <tbody>
              {preview.data.lines.map((x) => (
                <Tr key={x.row} className={x.duplicate ? 'opacity-50' : undefined}>
                  <Td className="num text-fg-muted">{x.row}</Td>
                  <Td className="whitespace-nowrap">{date(x.date)}</Td>
                  <Td>{x.description}</Td>
                  <Td className="text-fg-muted">{x.reference ?? ''}</Td>
                  <Td numeric><Money value={x.amount} currency={c} signed /></Td>
                  {preview.data!.balanceCheck ? <Td numeric>{x.balance ? <Money value={x.balance} currency={c} /> : ''}{preview.data!.balanceCheck.breaks.some((b) => b.row === x.row) ? <Badge tone="warning" className="ml-2">Gap before</Badge> : null}</Td> : null}
                  <Td>{x.duplicate ? <Badge>Already imported</Badge> : preview.data!.blockedRows.includes(x.row) ? <Badge tone="negative">Reconciled period</Badge> : <Badge tone="accent">New</Badge>}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}
    </>
  );
}

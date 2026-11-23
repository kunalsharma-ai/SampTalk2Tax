'use client';
import { parseStatementCsv, type SupplierStatementLine } from '@talk2tax/accounting-engine';
import { Alert, Button, Field, Input, Select, Textarea } from '@talk2tax/ui';
import { useMemo, useState } from 'react';

export interface StatementFormValue {
  contactId: string;
  from: string;
  to: string;
  theirOpening: string;
  theirClosing: string;
  lines: SupplierStatementLine[];
}

const KIND_WORD = { INVOICE: 'Invoice', DEBIT_NOTE: 'Debit note', CREDIT_NOTE: 'Credit note', PAYMENT: 'Payment' } as const;
/** The lines back as pasteable CSV, for correcting a statement. */
export const statementCsv = (lines: readonly SupplierStatementLine[]) => ['Date,Reference,Type,Amount', ...lines.map((l) => `${l.date},"${l.reference.replace(/"/g, '""')}",${KIND_WORD[l.kind]},${l.amount}`)].join('\n');

/** The supplier's statement as received: supplier, period, their balances and the lines pasted as CSV (AP-011). */
export function SupplierStatementForm({ initial, vendors, submitLabel, pending, onSubmit }: { initial?: StatementFormValue; vendors?: { id: string; name: string }[]; submitLabel: string; pending: boolean; onSubmit: (v: StatementFormValue) => void }) {
  const [f, setF] = useState({ contactId: initial?.contactId ?? '', from: initial?.from ?? '', to: initial?.to ?? '', theirOpening: initial?.theirOpening ?? '0.00', theirClosing: initial?.theirClosing ?? '' });
  const [csv, setCsv] = useState(initial ? statementCsv(initial.lines) : '');
  const parsed = useMemo(() => parseStatementCsv(csv), [csv]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ ...f, lines: parsed.lines });
      }}
    >
      <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-5">
        {vendors ? (
          <Field label="Supplier">
            {(p) => (
              <Select {...p} value={f.contactId} onChange={(e) => setF({ ...f, contactId: e.target.value })}>
                <option value="">Choose a supplier</option>
                {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </Select>
            )}
          </Field>
        ) : null}
        <Field label="Statement from">{(p) => <Input {...p} type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />}</Field>
        <Field label="Statement to">{(p) => <Input {...p} type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />}</Field>
        <Field label="Their opening balance" hint="What they say you owed at the start">{(p) => <Input {...p} inputMode="decimal" value={f.theirOpening} onChange={(e) => setF({ ...f, theirOpening: e.target.value })} />}</Field>
        <Field label="Their closing balance" hint="What they say you owe at the end">{(p) => <Input {...p} inputMode="decimal" value={f.theirClosing} onChange={(e) => setF({ ...f, theirClosing: e.target.value })} />}</Field>
      </div>
      <div className="px-4 pb-4">
        <Field label="Statement lines" hint="Paste from their statement as CSV: date, reference, type (invoice, debit note, credit note or payment), amount. A header row is skipped.">
          {(p) => <Textarea {...p} rows={8} className="font-mono text-xs" placeholder={'Date,Reference,Type,Amount\n03/10/2026,PM/26-27/101,Invoice,11800.00\n18/10/2026,NEFT 1111,Payment,11800.00'} value={csv} onChange={(e) => setCsv(e.target.value)} />}
        </Field>
        <p className="mt-2 text-sm text-fg-muted">{parsed.lines.length} line{parsed.lines.length === 1 ? '' : 's'} read.</p>
        {parsed.errors.length ? (
          <Alert tone="warning" title="Some rows could not be read">
            <ul className="list-disc pl-5">{parsed.errors.slice(0, 10).map((e) => <li key={e}>{e}</li>)}</ul>
          </Alert>
        ) : null}
        <div className="mt-4"><Button type="submit" disabled={pending || parsed.errors.length > 0 || !f.from || !f.to || !f.theirClosing || (vendors ? !f.contactId : false)}>{submitLabel}</Button></div>
      </div>
    </form>
  );
}

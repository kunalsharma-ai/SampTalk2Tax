'use client';
import { Field, Input, Textarea } from '@talk2tax/ui';

export interface TermsValue { name: string; amount: string; minimumBalance: string; startDate: string; terms: string }
const MONEY = /^\d{0,15}(\.\d{0,2})?$/;

/** The fields of a retainer's terms, shared by the new and edit dialogs. */
export function RetainerTermsFields({ v, set }: { v: TermsValue; set: (v: TermsValue) => void }) {
  return (
    <>
      <Field label="Name">{(p) => <Input {...p} value={v.name} maxLength={200} onChange={(e) => set({ ...v, name: e.target.value })} placeholder="Monthly advisory retainer" />}</Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Agreed amount" hint="The balance the customer keeps with you.">{(p) => <Input {...p} className="num" inputMode="decimal" value={v.amount} onChange={(e) => MONEY.test(e.target.value) && set({ ...v, amount: e.target.value })} />}</Field>
        <Field label="Top up below" hint="Ask for a top-up when the balance falls below this.">{(p) => <Input {...p} className="num" inputMode="decimal" value={v.minimumBalance} onChange={(e) => MONEY.test(e.target.value) && set({ ...v, minimumBalance: e.target.value })} />}</Field>
      </div>
      <Field label="Start date">{(p) => <Input {...p} type="date" value={v.startDate} onChange={(e) => set({ ...v, startDate: e.target.value })} />}</Field>
      <Field label="Terms (optional)">{(p) => <Textarea {...p} rows={2} maxLength={2000} value={v.terms} onChange={(e) => set({ ...v, terms: e.target.value })} placeholder="Kept at the agreed amount; topped up within 7 days of a request." />}</Field>
    </>
  );
}

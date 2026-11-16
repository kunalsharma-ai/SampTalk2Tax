'use client';
import { useQuery } from '@tanstack/react-query';
import { D } from '@talk2tax/accounting-engine';
import { placeOfSupplyName } from '@talk2tax/tax-engine';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Input, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { Suspense, type ReactNode } from 'react';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, money, today } from '@/lib/format';
import { monthLabel, monthRange } from '@/lib/gst';
import { useGstRegistration, useOrg } from '@/lib/org';
import type { Gstr1, Gstr1DocumentRow, Gstr3b, Heads, HsnRow, TaxHeads } from '@/lib/types';

type Tab = 'gstr-3b' | 'gstr-1';

export default function GstReturnsPage() {
  return (
    <Suspense>
      <GstReturns />
    </Suspense>
  );
}

function GstReturns() {
  const { org, orgId } = useOrg();
  const reg = useGstRegistration();
  const params = useSearchParams();
  const router = useRouter();
  const month = /^\d{4}-\d{2}$/.test(params.get('month') ?? '') ? params.get('month')! : today().slice(0, 7);
  const tab: Tab = params.get('return') === 'gstr-1' ? 'gstr-1' : 'gstr-3b';
  const { from, to } = monthRange(month);
  const set = (next: Partial<{ month: string; return: Tab }>) => {
    const q = new URLSearchParams({ month, return: tab, ...next });
    router.replace(`/orgs/${orgId}/tax/gst-returns?${q.toString()}`);
  };
  const registered = reg.data?.registered === true;
  const g3b = useQuery({ queryKey: ['gstr-3b', orgId, from, to], enabled: registered && tab === 'gstr-3b', queryFn: () => api<Gstr3b>(`/v1/orgs/${orgId}/gst/returns/gstr-3b?from=${from}&to=${to}`) });
  const g1 = useQuery({ queryKey: ['gstr-1', orgId, from, to], enabled: registered && tab === 'gstr-1', queryFn: () => api<Gstr1>(`/v1/orgs/${orgId}/gst/returns/gstr-1?from=${from}&to=${to}`) });
  if (!org) return null;
  const c = org.functionalCurrency;
  const err = (tab === 'gstr-3b' ? g3b.error : g1.error) as Error | null;

  return (
    <>
      <PageHeader
        title="GST returns"
        description={`Working papers for ${monthLabel(month)}, built from posted invoices, credit notes and bills. Review them before you file on the GST portal; Talk2Tax does not file returns.`}
        actions={
          <>
            <div role="tablist" aria-label="Return" className="flex rounded-lg border border-line p-0.5">
              {(['gstr-3b', 'gstr-1'] as const).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} onClick={() => set({ return: t })} className={`rounded-md px-3 py-1.5 text-sm ${tab === t ? 'bg-surface-hover font-medium text-fg' : 'text-fg-muted hover:text-fg'}`}>
                  {t.toUpperCase()}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
              Period
              <Input type="month" className="w-40" value={month} onChange={(e) => e.target.value && set({ month: e.target.value })} />
            </label>
          </>
        }
      />
      {reg.data && !registered ? (
        <Card>
          <EmptyState title="GST is not set up" action={<Link href={`/orgs/${orgId}/settings/gst`}><Button>Set up GST</Button></Link>}>Add your GSTIN to start preparing returns.</EmptyState>
        </Card>
      ) : null}
      {err ? <Alert title="Could not load">{err.message}</Alert> : null}
      {registered && tab === 'gstr-3b' && g3b.data ? <Gstr3bView r={g3b.data} c={c} /> : null}
      {registered && tab === 'gstr-1' && g1.data ? <Gstr1View r={g1.data} c={c} orgId={orgId} /> : null}
    </>
  );
}

// ---------------------------------------------------------------- GSTR-3B

function Gstr3bView({ r, c }: { r: Gstr3b; c: string }) {
  const sum = (h: Heads) => new D(h.igst).plus(h.cgst).plus(h.sgst).toFixed(2);
  const output = { igst: new D(r.outwardTaxable.igst).plus(r.outwardZeroRated.igst).toFixed(2), cgst: r.outwardTaxable.cgst, sgst: r.outwardTaxable.sgst };
  const cash = sum(r.setOff.cash);
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Output tax" value={money(sum(output), c)} sub="On invoices less credit notes" />
        <Stat label="Input tax credit" value={money(sum(r.itc), c)} sub="On bills less vendor credits" tone="accent" />
        <Stat label="Payable in cash" value={money(cash, c)} sub="After set-off of credit" tone={new D(cash).gt(0) ? 'warning' : 'positive'} />
        <Stat label="Credit carried forward" value={money(sum(r.setOff.carryForward), c)} sub="Left after set-off" tone="violet" />
      </div>

      {r.ledger.agrees ? (
        <p className="flex items-center gap-2 text-sm text-fg-muted"><Badge tone="positive">✓ Agrees with the ledger</Badge> The GST accounts moved by exactly these amounts this month.</p>
      ) : (
        <Alert tone="warning" title="The GST accounts do not match these documents">
          The ledger shows output IGST {money(r.ledger.output.igst, c)}, CGST {money(r.ledger.output.cgst, c)}, SGST/UTGST {money(r.ledger.output.sgst, c)} and input IGST {money(r.ledger.input.igst, c)}, CGST {money(r.ledger.input.cgst, c)}, SGST/UTGST {money(r.ledger.input.sgst, c)} for the month.
          A manual journal on a GST account, or a document voided in a later month, explains a difference. Check the general ledger before filing.
        </Alert>
      )}
      {r.warnings.map((w) => <Alert key={w} tone="warning">{w}</Alert>)}

      <Card>
        <CardHeader title="3.1 Outward supplies" description="Taxable value and tax by head, net of credit notes." />
        <HeadsTable
          c={c}
          rows={[
            { label: '(a) Taxable supplies (other than zero-rated, nil-rated and exempt)', ...r.outwardTaxable },
            { label: '(b) Zero-rated supplies (exports with IGST paid)', taxable: r.outwardZeroRated.taxable, igst: r.outwardZeroRated.igst, cgst: null, sgst: null },
            { label: '(c) Nil-rated and exempt supplies', taxable: r.outwardNilExempt, igst: null, cgst: null, sgst: null },
            { label: '(e) Non-GST supplies', taxable: r.outwardNonGst, igst: null, cgst: null, sgst: null },
          ]}
        />
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="3.2 Inter-state supplies to unregistered persons" />
          {r.interStateUnregistered.length === 0 ? <p className="px-5 pb-5 text-sm text-fg-muted">None this month.</p> : (
            <Table>
              <thead><tr><Th>Place of supply</Th><Th numeric>Taxable value</Th><Th numeric>IGST</Th></tr></thead>
              <tbody>
                {r.interStateUnregistered.map((x) => (
                  <Tr key={x.placeOfSupply}><Td>{x.placeOfSupply} · {placeOfSupplyName(x.placeOfSupply)}</Td><Td numeric><Money value={x.taxable} currency={c} /></Td><Td numeric><Money value={x.igst} currency={c} /></Td></Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card>
          <CardHeader title="4 Eligible input tax credit" description="All other ITC from bills, less vendor credits. Blocked credits and reversals are not modelled yet." />
          <Table>
            <thead><tr><Th>Head</Th><Th numeric>Credit</Th></tr></thead>
            <tbody>
              <Tr><Td>Integrated tax (IGST)</Td><Td numeric><Money value={r.itc.igst} currency={c} /></Td></Tr>
              <Tr><Td>Central tax (CGST)</Td><Td numeric><Money value={r.itc.cgst} currency={c} /></Td></Tr>
              <Tr><Td>State/UT tax (SGST/UTGST)</Td><Td numeric><Money value={r.itc.sgst} currency={c} /></Td></Tr>
            </tbody>
          </Table>
          <p className="border-t border-line px-5 py-3 text-xs text-fg-muted">
            Exempt, nil-rated and non-GST purchases (table 5): inter-state {money(new D(r.inwardExempt.inter).plus(r.inwardNonGst.inter).toFixed(2), c)}, intra-state {money(new D(r.inwardExempt.intra).plus(r.inwardNonGst.intra).toFixed(2), c)}.
          </p>
        </Card>
      </div>

      <Card>
        <CardHeader title="6.1 Payment of tax" description="Credit is used in the order the CGST Act requires: IGST credit first (against IGST, then CGST and SGST/UTGST), then CGST and SGST/UTGST credit against their own head and then IGST. CGST and SGST/UTGST never pay each other." />
        <Table>
          <thead>
            <tr>
              <Th>Tax</Th>
              <Th numeric>Payable</Th>
              <Th numeric className="min-w-28">Paid by IGST credit</Th>
              <Th numeric className="min-w-28">Paid by CGST credit</Th>
              <Th numeric className="min-w-32">Paid by SGST/UTGST credit</Th>
              <Th numeric>Paid in cash</Th>
            </tr>
          </thead>
          <tbody>
            {(['igst', 'cgst', 'sgst'] as const).map((h) => (
              <Tr key={h}>
                <Td className="whitespace-nowrap font-medium">{h === 'sgst' ? 'SGST/UTGST' : h.toUpperCase()}</Td>
                <Td numeric><Money value={r.setOff.liability[h]} currency={c} /></Td>
                <Td numeric><Dim v={r.setOff.used.igst[h]} c={c} /></Td>
                <Td numeric>{h === 'sgst' ? <span className="text-fg-faint">n/a</span> : <Dim v={r.setOff.used.cgst[h]} c={c} />}</Td>
                <Td numeric>{h === 'cgst' ? <span className="text-fg-faint">n/a</span> : <Dim v={r.setOff.used.sgst[h]} c={c} />}</Td>
                <Td numeric className="font-semibold"><Money value={r.setOff.cash[h]} currency={c} /></Td>
              </Tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <Td className="font-semibold">Total</Td>
              <Td numeric className="font-semibold"><Money value={sum(r.setOff.liability)} currency={c} /></Td>
              <Td numeric><Money value={sum(r.setOff.used.igst)} currency={c} /></Td>
              <Td numeric><Money value={sum(r.setOff.used.cgst)} currency={c} /></Td>
              <Td numeric><Money value={sum(r.setOff.used.sgst)} currency={c} /></Td>
              <Td numeric className="font-semibold"><Money value={cash} currency={c} /></Td>
            </tr>
          </tfoot>
        </Table>
        <p className="border-t border-line px-5 py-3 text-xs text-fg-muted">
          Credit carried forward: IGST {money(r.setOff.carryForward.igst, c)}, CGST {money(r.setOff.carryForward.cgst, c)}, SGST/UTGST {money(r.setOff.carryForward.sgst, c)}. Credit brought forward from earlier months, interest and late fees are not included.
        </p>
      </Card>
    </div>
  );
}

function Dim({ v, c }: { v: string; c: string }) {
  return v === '0.00' ? <span className="text-fg-faint">—</span> : <Money value={v} currency={c} />;
}

function HeadsTable({ rows, c }: { rows: { label: ReactNode; taxable: string; igst: string | null; cgst: string | null; sgst: string | null }[]; c: string }) {
  return (
    <Table>
      <thead><tr><Th>Nature of supply</Th><Th numeric>Taxable value</Th><Th numeric>IGST</Th><Th numeric>CGST</Th><Th numeric>SGST/UTGST</Th></tr></thead>
      <tbody>
        {rows.map((x, i) => (
          <Tr key={i}>
            <Td className="min-w-56">{x.label}</Td>
            <Td numeric className="whitespace-nowrap"><Money value={x.taxable} currency={c} signed /></Td>
            {(['igst', 'cgst', 'sgst'] as const).map((h) => <Td key={h} numeric>{x[h] === null ? <span className="text-fg-faint">—</span> : <Money value={x[h]} currency={c} signed />}</Td>)}
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

// ---------------------------------------------------------------- GSTR-1

function Gstr1View({ r, c, orgId }: { r: Gstr1; c: string; orgId: string }) {
  const tax = (t: TaxHeads) => new D(t.igst).plus(t.cgst).plus(t.sgst).toFixed(2);
  const docs = (title: string, description: string, rows: Gstr1DocumentRow[]) => <DocTable key={title} title={title} description={description} rows={rows} c={c} orgId={orgId} />;
  const empty = r.b2b.length + r.b2cl.length + r.exp.length + r.b2cs.length + r.cdnr.length + r.cdnur.length + r.nil.length === 0;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Taxable value" value={money(r.totals.taxable, c)} sub="Net of credit notes" />
        <Stat label="Tax" value={money(tax(r.totals), c)} sub={`IGST ${money(r.totals.igst, c)} · CGST ${money(r.totals.cgst, c)} · SGST ${money(r.totals.sgst, c)}`} tone="accent" />
        <Stat label="B2B invoices" value={String(r.b2b.length)} sub="To registered buyers" tone="violet" />
        <Stat label="Credit notes" value={String(r.cdnr.length + r.cdnur.length)} sub="Reported invoice-wise" />
      </div>
      {empty ? <Card><EmptyState title="No GST sales this month">Posted invoices and credit notes with GST rates appear here.</EmptyState></Card> : null}
      {r.b2b.length ? docs('4 B2B invoices', 'Taxable supplies to registered persons, invoice by invoice.', r.b2b) : null}
      {r.b2cl.length ? docs('5 B2C large invoices', 'Inter-state invoices above Rs 1,00,000 to unregistered persons.', r.b2cl) : null}
      {r.exp.length ? docs('6A Exports', 'Supplies outside India, with payment of IGST.', r.exp) : null}
      {r.b2cs.length ? (
        <Card>
          <CardHeader title="7 B2C others" description="All other supplies to unregistered persons, by place of supply and rate, net of their credit notes." />
          <Table>
            <thead><tr><Th>Place of supply</Th><Th>Type</Th><Th numeric>Rate</Th><Th numeric>Taxable value</Th><Th numeric>IGST</Th><Th numeric>CGST</Th><Th numeric>SGST/UTGST</Th></tr></thead>
            <tbody>
              {r.b2cs.map((x) => (
                <Tr key={`${x.placeOfSupply}-${x.rate}`}>
                  <Td>{x.placeOfSupply} · {placeOfSupplyName(x.placeOfSupply)}</Td>
                  <Td className="text-fg-muted">{x.nature === 'INTRA' ? 'Intra-state' : 'Inter-state'}</Td>
                  <Td numeric className="num">{x.rate}%</Td>
                  <Td numeric><Money value={x.taxable} currency={c} signed /></Td>
                  <Td numeric><Dim v={x.igst} c={c} /></Td>
                  <Td numeric><Dim v={x.cgst} c={c} /></Td>
                  <Td numeric><Dim v={x.sgst} c={c} /></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}
      {r.nil.length ? (
        <Card>
          <CardHeader title="8 Nil-rated, exempt and non-GST supplies" />
          <Table>
            <thead><tr><Th>Supply</Th><Th numeric>Nil-rated</Th><Th numeric>Exempt</Th><Th numeric>Non-GST</Th></tr></thead>
            <tbody>
              {r.nil.map((x) => (
                <Tr key={`${x.nature}-${x.registered}`}>
                  <Td>{x.nature === 'INTRA' ? 'Intra-state' : 'Inter-state'} to {x.registered ? 'registered' : 'unregistered'} persons</Td>
                  <Td numeric><Money value={x.nilRated} currency={c} signed /></Td>
                  <Td numeric><Money value={x.exempt} currency={c} signed /></Td>
                  <Td numeric><Money value={x.nonGst} currency={c} signed /></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}
      {r.cdnr.length ? docs('9B Credit notes to registered persons', 'Reported note by note.', r.cdnr) : null}
      {r.cdnur.length ? docs('9B Credit notes to unregistered persons', 'Against B2C large invoices and exports.', r.cdnur) : null}
      {r.hsn.b2b.length || r.hsn.b2c.length ? (
        <div className="flex flex-col gap-6">
          <HsnTable title="12 HSN summary: B2B" rows={r.hsn.b2b} c={c} />
          <HsnTable title="12 HSN summary: B2C" rows={r.hsn.b2c} c={c} />
        </div>
      ) : null}
      {r.documents.length ? (
        <Card>
          <CardHeader title="13 Documents issued" />
          <Table>
            <thead><tr><Th>Document</Th><Th>From</Th><Th>To</Th><Th numeric>Issued</Th><Th numeric>Cancelled</Th><Th numeric>Net issued</Th></tr></thead>
            <tbody>
              {r.documents.map((x) => (
                <Tr key={x.kind}>
                  <Td>{x.kind === 'INVOICE' ? 'Invoices for outward supply' : 'Credit notes'}</Td>
                  <Td className="num">{x.from}</Td>
                  <Td className="num">{x.to}</Td>
                  <Td numeric className="num">{x.issued}</Td>
                  <Td numeric className="num">{x.cancelled}</Td>
                  <Td numeric className="num">{x.issued - x.cancelled}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}
    </div>
  );
}

function DocTable({ title, description, rows, c, orgId }: { title: string; description: string; rows: Gstr1DocumentRow[]; c: string; orgId: string }) {
  return (
    <Card>
      <CardHeader title={title} description={description} />
      <Table>
        <thead><tr><Th>Number</Th><Th>Date</Th><Th>Party</Th><Th>Place of supply</Th><Th numeric>Rate</Th><Th numeric>Taxable value</Th><Th numeric>Tax</Th><Th numeric>Document value</Th></tr></thead>
        <tbody>
          {rows.flatMap((x) =>
            x.rates.map((rt, i) => (
              <Tr key={`${x.id}-${rt.rate}`}>
                <Td>{i === 0 ? <Link className="num text-accent hover:underline" href={`/orgs/${orgId}/sales/invoices/${x.id}`}>{x.number}</Link> : null}</Td>
                <Td className="text-fg-muted">{i === 0 ? date(x.date) : null}</Td>
                <Td>{i === 0 ? <>{x.name}{x.gstin ? <p className="num text-xs text-fg-muted">{x.gstin}</p> : null}</> : null}</Td>
                <Td className="text-fg-muted">{i === 0 ? `${x.placeOfSupply} · ${placeOfSupplyName(x.placeOfSupply)}` : null}</Td>
                <Td numeric className="num">{rt.rate}%</Td>
                <Td numeric><Money value={rt.taxable} currency={c} /></Td>
                <Td numeric>
                  <Money value={new D(rt.igst).plus(rt.cgst).plus(rt.sgst).toFixed(2)} currency={c} />
                  <p className="text-xs text-fg-muted">{rt.igst !== '0.00' ? 'IGST' : 'CGST + SGST'}</p>
                </Td>
                <Td numeric>{i === 0 ? <Money value={x.value} currency={c} /> : null}</Td>
              </Tr>
            )),
          )}
        </tbody>
      </Table>
    </Card>
  );
}

function HsnTable({ title, rows, c }: { title: string; rows: HsnRow[]; c: string }) {
  return (
    <Card>
      <CardHeader title={title} description="Quantities are summed as entered; units of measure are not tracked yet." />
      {rows.length === 0 ? <p className="px-5 pb-5 text-sm text-fg-muted">None this month.</p> : (
        <Table>
          <thead><tr><Th>HSN/SAC</Th><Th numeric>Rate</Th><Th numeric>Qty</Th><Th numeric>Taxable value</Th><Th numeric>IGST</Th><Th numeric>CGST</Th><Th numeric>SGST/UTGST</Th></tr></thead>
          <tbody>
            {rows.map((x) => (
              <Tr key={`${x.hsnCode}-${x.rate}`}>
                <Td className="num">{x.hsnCode}</Td>
                <Td numeric className="num">{x.rate}%</Td>
                <Td numeric className="num">{x.quantity}</Td>
                <Td numeric><Money value={x.taxable} currency={c} signed /></Td>
                <Td numeric><Dim v={x.igst} c={c} /></Td>
                <Td numeric><Dim v={x.cgst} c={c} /></Td>
                <Td numeric><Dim v={x.sgst} c={c} /></Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

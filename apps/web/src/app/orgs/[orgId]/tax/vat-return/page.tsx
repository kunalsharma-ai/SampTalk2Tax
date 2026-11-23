'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useEffect, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

type Treatment = 'STANDARD' | 'REDUCED' | 'ZERO' | 'EXEMPT' | 'OUTSIDE_SCOPE';
interface Settings {
  settings: { vrn: string; registeredFrom: string; stagger: string; untaxedTreatment: Treatment; updatedAt: string; updatedBy: string } | null;
  rates: { id: string; name: string; rate: string; isActive: boolean; treatment: Treatment | null; suggested: Treatment | null }[];
  staggers: { key: string; label: string }[];
  treatments: { key: Treatment; label: string }[];
}
interface Period { start: string; end: string; due: string; status: 'OPEN' | 'DUE' | 'OVERDUE' | 'SUBMITTED'; submittedOn: string | null; box5: string | null; direction: 'PAY' | 'RECLAIM' | 'NIL' | null }
interface Periods { setUp: boolean; periods: Period[]; older?: { start: string; end: string; submittedOn: string; box5: string }[] }
type Boxes = Record<'box1' | 'box2' | 'box3' | 'box4' | 'box5' | 'box6' | 'box7' | 'box8' | 'box9', string>;
interface VatReturn {
  period: { start: string; end: string; due: string };
  vrn: string;
  status: Period['status'];
  boxes: Boxes;
  prepared: Boxes;
  labels: Record<keyof Boxes, string>;
  direction: 'PAY' | 'RECLAIM' | 'NIL';
  breakdown: { side: 'SALES' | 'PURCHASES'; treatment: Treatment; label: string; net: string; vat: string; lines: number; counted: boolean }[];
  corrections: { pending: { periodStart: string; periodEnd: string; box1: string; box4: string; net: string }[]; included: boolean; allowance: { net: string; limit: string; allowed: boolean } };
  issues: string[];
  warnings: string[];
  otherVatEntries: { id: string; number: number | null; date: string; memo: string | null; source: string; accounts: string[]; debit: string; credit: string }[];
  entries: { source: string; id: string; number: string; date: string; reversal?: boolean; treatment: string; rate: string; net: string; vat: string }[];
  submitted: { boxes: Boxes; submittedOn: string; reference: string | null; recordedBy: string; recordedAt: string; changedSince: { box1: string; box4: string; net: string } | null } | null;
}

const STATUS: Record<Period['status'], { label: string; tone: 'neutral' | 'accent' | 'warning' | 'negative' | 'positive' }> = {
  OPEN: { label: 'Open', tone: 'neutral' },
  DUE: { label: 'Due', tone: 'accent' },
  OVERDUE: { label: 'Overdue', tone: 'negative' },
  SUBMITTED: { label: 'Submitted', tone: 'positive' },
};
const SOURCE: Record<string, string> = { INVOICE: 'Invoice', CREDIT_NOTE: 'Credit note', BILL: 'Bill', VENDOR_CREDIT: 'Vendor credit', EXPENSE_CLAIM: 'Expense claim' };
const TREATMENT: Record<string, string> = { STANDARD: 'Standard rate', REDUCED: 'Reduced rate', ZERO: 'Zero rate', EXEMPT: 'Exempt', OUTSIDE_SCOPE: 'Outside the scope of VAT' };
const BOXES = ['box1', 'box2', 'box3', 'box4', 'box5', 'box6', 'box7', 'box8', 'box9'] as const;
/** Credit notes, vendor credits and voids take off: shown with a minus sign. */
const signed = (e: { source: string; reversal?: boolean }, x: string) => ((e.source === 'CREDIT_NOTE' || e.source === 'VENDOR_CREDIT') !== !!e.reversal && !/^0(\.0+)?$/.test(x) ? `-${x}` : x);
const pounds = (x: string) => <Money value={x} currency="GBP" />;

/** UK VAT return (TAX-030): the nine boxes for a VAT period, prepared from the books, and the record of each submission to HMRC. */
export default function VatReturnPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['vat-settings', orgId], queryFn: () => api<Settings>(`/v1/orgs/${orgId}/tax/vat/settings`) });
  const periods = useQuery({ queryKey: ['vat-periods', orgId], queryFn: () => api<Periods>(`/v1/orgs/${orgId}/tax/vat/periods`) });
  const [end, setEnd] = useState<string | null>(null);
  const ret = useQuery({ queryKey: ['vat-return', orgId, end], enabled: !!end, queryFn: () => api<VatReturn>(`/v1/orgs/${orgId}/tax/vat/return?periodEnd=${end}`) });

  // Open the latest period that has ended and is not submitted, else the latest submitted.
  useEffect(() => {
    if (end || !periods.data?.periods.length) return;
    const ps = periods.data.periods;
    setEnd((ps.find((p) => p.status === 'DUE' || p.status === 'OVERDUE') ?? ps.find((p) => p.status === 'SUBMITTED') ?? ps[0]!).end);
  }, [periods.data, end]);

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['vat-settings', orgId] }), qc.invalidateQueries({ queryKey: ['vat-periods', orgId] }), qc.invalidateQueries({ queryKey: ['vat-return', orgId] })]);
  const [busy, setBusy] = useState(false);
  const download = async () => {
    if (!end) return;
    setBusy(true);
    try {
      const x = await api<{ fileName: string; csv: string }>(`/v1/orgs/${orgId}/tax/vat/return/export?periodEnd=${end}`);
      const url = URL.createObjectURL(new Blob([x.csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = x.fileName;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };

  if (!org) return null;
  const manage = can(org.role, 'accounts.manage');
  const r = ret.data;
  return (
    <>
      <PageHeader
        title="VAT return"
        description="The nine boxes of your UK VAT return for each VAT period, prepared from posted invoices, credit notes, bills, vendor credits and approved expense claims on the invoice basis. Enter them in your Making Tax Digital software or HMRC's service, then record the submission here; nothing is sent to HMRC from Talk2Tax."
        actions={r ? <Button variant="secondary" size="sm" loading={busy} onClick={() => void download()}>Download VAT return (CSV)</Button> : null}
      />
      <ErrorAlert title="Could not load the VAT settings" error={settings.error} />
      {settings.data ? <SettingsCard data={settings.data} manage={manage} orgId={orgId} onSaved={refresh} /> : null}

      {periods.data?.setUp ? (
        <Card className="mb-4">
          <CardHeader title="VAT periods" description="Your recent VAT periods. A return is due one calendar month and seven days after the period ends." />
          <Table aria-label="VAT periods">
            <thead><Tr><Th>Period</Th><Th>Due</Th><Th>Status</Th><Th numeric>Box 5</Th><Th /></Tr></thead>
            <tbody>
              {periods.data.periods.map((p) => (
                <Tr key={p.end} className={p.end === end ? 'bg-surface-hover' : undefined}>
                  <Td>{date(p.start)} to {date(p.end)}</Td>
                  <Td>{date(p.due)}</Td>
                  <Td><Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Badge>{p.submittedOn ? <span className="ml-2 text-xs text-fg-muted">on {date(p.submittedOn)}</span> : null}</Td>
                  <Td numeric>{p.box5 ? <>{pounds(p.box5)} <span className="text-xs text-fg-muted">{p.direction === 'RECLAIM' ? 'to reclaim' : p.direction === 'PAY' ? 'to pay' : ''}</span></> : '—'}</Td>
                  <Td><Button size="sm" variant="ghost" aria-label={`Open the period ending ${date(p.end)}`} onClick={() => setEnd(p.end)}>Open</Button></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}
      <ErrorAlert title="Could not load the VAT return" error={ret.error ?? periods.error} />
      {r ? <ReturnView r={r} manage={manage} orgId={orgId} onRecorded={refresh} /> : null}
    </>
  );
}

function SettingsCard({ data, manage, orgId, onSaved }: { data: Settings; manage: boolean; orgId: string; onSaved: () => Promise<unknown> }) {
  const [vrn, setVrn] = useState(data.settings?.vrn ?? '');
  const [registeredFrom, setRegisteredFrom] = useState(data.settings?.registeredFrom ?? '');
  const [stagger, setStagger] = useState(data.settings?.stagger ?? 'QUARTERLY_MAR');
  const [untaxed, setUntaxed] = useState<Treatment>(data.settings?.untaxedTreatment ?? 'OUTSIDE_SCOPE');
  const [set, setSet] = useState<Record<string, Treatment | ''>>(Object.fromEntries(data.rates.map((r) => [r.id, r.treatment ?? ''])));
  const [open, setOpen] = useState(!data.settings);
  const save = useMutation({
    mutationFn: () =>
      api(`/v1/orgs/${orgId}/tax/vat/settings`, { method: 'PUT', body: { vrn, registeredFrom, stagger, untaxedTreatment: untaxed, treatments: Object.entries(set).filter(([, t]) => t).map(([taxRateId, treatment]) => ({ taxRateId, treatment })) } }),
    onSuccess: async () => {
      setOpen(false);
      await onSaved();
    },
  });
  const label = (k: string | null) => data.treatments.find((t) => t.key === k)?.label ?? 'Choose a treatment';
  const s = data.settings;
  return (
    <Card className="mb-4">
      <CardHeader
        title="VAT registration"
        description={s ? `VAT number ${s.vrn}, registered from ${date(s.registeredFrom)} · ${data.staggers.find((x) => x.key === s.stagger)?.label ?? s.stagger}. Last changed by ${s.updatedBy}, ${date(s.updatedAt.slice(0, 10))}.` : 'Add your VAT registration number, how often you make returns and how each tax rate counts on the return.'}
        actions={s && manage && !open ? <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>Change</Button> : null}
      />
      {open || !s ? (
        manage ? (
          <form
            className="space-y-4 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-4">
              <Field label="VAT registration number" hint="9 digits, with or without GB">{(p) => <Input {...p} value={vrn} maxLength={20} onChange={(e) => setVrn(e.target.value)} />}</Field>
              <Field label="Registered from" hint="The effective date on your VAT certificate">{(p) => <Input {...p} type="date" value={registeredFrom} max={today()} onChange={(e) => setRegisteredFrom(e.target.value)} />}</Field>
              <Field label="Return periods">{(p) => <Select {...p} value={stagger} onChange={(e) => setStagger(e.target.value)}>{data.staggers.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</Select>}</Field>
              <Field label="Lines with no tax rate" hint="How they count on the return">{(p) => <Select {...p} value={untaxed} onChange={(e) => setUntaxed(e.target.value as Treatment)}>{data.treatments.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</Select>}</Field>
            </div>
            <Table aria-label="VAT treatment of tax rates">
              <thead><Tr><Th>Tax rate</Th><Th numeric>Rate</Th><Th>VAT treatment</Th></Tr></thead>
              <tbody>
                {data.rates.map((r) => (
                  <Tr key={r.id}>
                    <Td>{r.name}{r.isActive ? null : <Badge className="ml-2">Inactive</Badge>}</Td>
                    <Td numeric>{r.rate}%</Td>
                    <Td>
                      <Select aria-label={`VAT treatment of ${r.name}`} value={set[r.id] ?? ''} onChange={(e) => setSet({ ...set, [r.id]: e.target.value as Treatment | '' })}>
                        <option value="">{r.suggested ? `Suggested: ${label(r.suggested)}` : 'Choose a treatment'}</option>
                        {data.treatments.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                      </Select>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <ErrorAlert title="Could not save the VAT registration" error={save.error} />
            <div className="flex gap-2">
              <Button type="submit" loading={save.isPending} disabled={!vrn.trim() || !registeredFrom}>Save VAT registration</Button>
              {s ? <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button> : null}
            </div>
          </form>
        ) : (
          <div className="p-4"><EmptyState title="VAT is not set up yet">Someone who manages accounts adds the VAT registration number and return periods.</EmptyState></div>
        )
      ) : null}
    </Card>
  );
}

function ReturnView({ r, manage, orgId, onRecorded }: { r: VatReturn; manage: boolean; orgId: string; onRecorded: () => Promise<unknown> }) {
  const [submittedOn, setSubmittedOn] = useState(today());
  const [reference, setReference] = useState('');
  const record = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/tax/vat/returns`, { method: 'POST', body: { periodEnd: r.period.end, submittedOn, reference: reference || null, box5: r.boxes.box5 } }),
    onSuccess: onRecorded,
  });
  const st = STATUS[r.status];
  const sales = r.breakdown.filter((b) => b.side === 'SALES');
  const purchases = r.breakdown.filter((b) => b.side === 'PURCHASES');
  return (
    <>
      <Card className="mb-4">
        <CardHeader
          title="VAT return boxes"
          description={`${date(r.period.start)} to ${date(r.period.end)} · VAT number ${r.vrn} · due ${date(r.period.due)}. Boxes 1 to 5 in pounds and pence; boxes 6 to 9 in whole pounds.`}
          actions={<Badge tone={st.tone}>{st.label}</Badge>}
        />
        <div className="space-y-3 px-4 pt-4">
          {r.issues.map((i) => <Alert key={i} tone="warning" title="Before recording the submission">{i}</Alert>)}
          {r.warnings.map((w) => <Alert key={w} tone="warning">{w}</Alert>)}
          {r.submitted?.changedSince ? (
            <Alert tone="warning" title="The books for this period changed after it was submitted">
              Box 1 is {pounds(r.submitted.changedSince.box1)} different and box 4 {pounds(r.submitted.changedSince.box4)}. The difference goes on your next return as a correction when it is within HMRC&apos;s limit.
            </Alert>
          ) : null}
        </div>
        <Table aria-label="VAT return boxes">
          <thead><Tr><Th>Box</Th><Th>Description</Th><Th numeric>Value</Th></Tr></thead>
          <tbody>
            {BOXES.map((k) => (
              <Tr key={k} className={k === 'box5' ? 'font-semibold' : undefined}>
                <Td>{k.replace('box', '')}</Td>
                <Td>{r.labels[k]}</Td>
                <Td numeric>{k === 'box6' || k === 'box7' || k === 'box8' || k === 'box9' ? `£${r.boxes[k]}` : pounds(r.boxes[k])}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
        <p className="px-4 pb-4 pt-2 text-sm" data-testid="vat-direction">
          {r.direction === 'PAY' ? `You pay HMRC £${r.boxes.box5}.` : r.direction === 'RECLAIM' ? `HMRC repays you £${r.boxes.box5}.` : 'Nothing to pay or reclaim.'}
          {r.corrections.included ? ' Includes corrections of earlier returns.' : ''}
        </p>
      </Card>

      {r.submitted ? (
        <Card className="mb-4">
          <CardHeader title="Submission recorded" description={`Submitted to HMRC on ${date(r.submitted.submittedOn)}${r.submitted.reference ? `, reference ${r.submitted.reference}` : ''}. Recorded by ${r.submitted.recordedBy}. The boxes above are kept as submitted.`} />
        </Card>
      ) : manage ? (
        <Card className="mb-4">
          <CardHeader title="Record the submission" description="Once you have submitted these figures to HMRC, record it here. The boxes are then kept as submitted, and later changes to this period go on a later return." />
          <form
            className="grid gap-4 p-4 sm:grid-cols-[12rem_16rem_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              record.mutate();
            }}
          >
            <Field label="Submitted on">{(p) => <Input {...p} type="date" value={submittedOn} max={today()} onChange={(e) => setSubmittedOn(e.target.value)} />}</Field>
            <Field label="HMRC reference" hint="Optional">{(p) => <Input {...p} value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} />}</Field>
            <div className="flex items-end"><Button type="submit" loading={record.isPending} disabled={r.issues.length > 0}>Record as submitted</Button></div>
          </form>
          <ErrorAlert title="Could not record the submission" error={record.error} />
        </Card>
      ) : null}

      {r.corrections.pending.length ? (
        <Card className="mb-4">
          <CardHeader
            title="Corrections of earlier returns"
            description={r.corrections.allowance.allowed ? `Changes to periods already submitted, added to boxes 1 and 4 of this return. Their net value of £${r.corrections.allowance.net} is within the £${r.corrections.allowance.limit} HMRC allows on a return.` : `Changes to periods already submitted. Their net value of £${r.corrections.allowance.net} is over the £${r.corrections.allowance.limit} HMRC allows on a return, so they are left off: tell HMRC separately (form VAT652).`}
          />
          <Table aria-label="Corrections of earlier returns">
            <thead><Tr><Th>Period</Th><Th numeric>Box 1</Th><Th numeric>Box 4</Th><Th numeric>Net</Th></Tr></thead>
            <tbody>
              {r.corrections.pending.map((c) => (
                <Tr key={c.periodEnd}><Td>{date(c.periodStart)} to {date(c.periodEnd)}</Td><Td numeric>{pounds(c.box1)}</Td><Td numeric>{pounds(c.box4)}</Td><Td numeric>{pounds(c.net)}</Td></Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}

      <Card className="mb-4">
        <CardHeader title="Figures by VAT treatment" description="Sales and purchases in the period by how their tax rate counts. Exempt supplies count in boxes 6 and 7 without VAT; supplies outside the scope of VAT are not on the return." />
        {r.breakdown.length ? (
          <Table aria-label="Figures by VAT treatment">
            <thead><Tr><Th>Side</Th><Th>Treatment</Th><Th numeric>Lines</Th><Th numeric>Net</Th><Th numeric>VAT</Th></Tr></thead>
            <tbody>
              {[...sales, ...purchases].map((b) => (
                <Tr key={`${b.side}${b.treatment}`}>
                  <Td>{b.side === 'SALES' ? 'Sales' : 'Purchases'}</Td>
                  <Td>{b.label}{b.counted ? null : <Badge className="ml-2">Not on the return</Badge>}</Td>
                  <Td numeric>{b.lines}</Td>
                  <Td numeric>{pounds(b.net)}</Td>
                  <Td numeric>{pounds(b.vat)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <div className="p-4"><EmptyState title="Nothing in this period">No posted invoices, bills or approved expense claims are dated in it.</EmptyState></div>
        )}
      </Card>

      <Card className="mb-4">
        <CardHeader title="Other entries on the VAT accounts" description="Posted entries in the period on the VAT accounts that no invoice, bill or claim on the return made, such as VAT paid to HMRC or a journal. Check none is VAT that belongs on the return." />
        {r.otherVatEntries.length ? (
          <Table aria-label="Other entries on the VAT accounts">
            <thead><Tr><Th>Date</Th><Th>Entry</Th><Th>Accounts</Th><Th numeric>Debit</Th><Th numeric>Credit</Th></Tr></thead>
            <tbody>
              {r.otherVatEntries.map((e) => (
                <Tr key={e.id}>
                  <Td>{date(e.date)}</Td>
                  <Td><a className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${e.id}`}>{e.number ? `#${e.number}` : 'Entry'}</a> {e.memo}</Td>
                  <Td className="text-sm">{e.accounts.join(', ')}</Td>
                  <Td numeric>{pounds(e.debit)}</Td>
                  <Td numeric>{pounds(e.credit)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="p-4 text-sm text-fg-muted">None: everything on the VAT accounts in this period came from the documents on the return.</p>
        )}
      </Card>

      <Card>
        <CardHeader title="Entries on the return" description="Every line behind the boxes. Credit notes and vendor credits are taken off; a document voided in this period is taken off again here." />
        {r.entries.length ? (
          <Table aria-label="Entries on the return">
            <thead><Tr><Th>Date</Th><Th>Document</Th><Th>Treatment</Th><Th numeric>Rate</Th><Th numeric>Net</Th><Th numeric>VAT</Th></Tr></thead>
            <tbody>
              {r.entries.slice(0, 300).map((e, i) => (
                <Tr key={`${e.id}${i}`}>
                  <Td>{date(e.date)}</Td>
                  <Td>{SOURCE[e.source] ?? e.source} {e.number}{e.reversal ? <Badge tone="warning" className="ml-2">Voided</Badge> : null}</Td>
                  <Td className="text-sm">{TREATMENT[e.treatment] ?? 'Not chosen yet'}</Td>
                  <Td numeric>{e.rate}%</Td>
                  <Td numeric>{pounds(signed(e, e.net))}</Td>
                  <Td numeric>{pounds(signed(e, e.vat))}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="p-4 text-sm text-fg-muted">No lines in this period.</p>
        )}
      </Card>
    </>
  );
}

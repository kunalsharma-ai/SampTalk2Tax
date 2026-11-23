'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import { type ReactNode, useEffect, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, money, today } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

type Treatment = 'STANDARD' | 'REDUCED' | 'ZERO' | 'EXEMPT' | 'OUTSIDE_SCOPE';
interface J { country: string; currency: string; taxName: string; returnName: string; authority: string; authorityThe: string; unitsNote: string; numberName: string; numberShort: string; numberHint: string; dueRule: string; netBox: string; wholeBoxes: string[]; intro: string; treatmentNote: string; overLimit: string; correctionRule: string | null; cardTitles: { registration: string; periods: string; boxes: string; treatment: string; other: string }; region: { name: string; options: { key: string; label: string }[] } | null; boxOrder: string[] }
interface Settings {
  jurisdiction: J;
  settings: { vrn: string; registeredFrom: string; stagger: string; region: string | null; untaxedTreatment: Treatment; updatedAt: string; updatedBy: string } | null;
  rates: { id: string; name: string; rate: string; isActive: boolean; treatment: Treatment | null; suggested: Treatment | null }[];
  staggers: { key: string; label: string }[];
  treatments: { key: Treatment; label: string }[];
}
interface Period { start: string; end: string; due: string; status: 'OPEN' | 'DUE' | 'OVERDUE' | 'SUBMITTED'; submittedOn: string | null; net: string | null; direction: 'PAY' | 'RECLAIM' | 'NIL' | null }
interface Periods { setUp: boolean; periods: Period[]; older?: { start: string; end: string; submittedOn: string; net: string | null }[] }
type Boxes = Record<string, string>;
interface VatReturn {
  period: { start: string; end: string; due: string };
  vrn: string;
  status: Period['status'];
  jurisdiction: J;
  boxes: Boxes;
  prepared: Boxes;
  labels: Record<string, string>;
  net: string;
  direction: 'PAY' | 'RECLAIM' | 'NIL';
  breakdown: { side: 'SALES' | 'PURCHASES'; treatment: Treatment; label: string; net: string; vat: string; lines: number; counted: boolean }[];
  corrections: { pending: { periodStart: string; periodEnd: string; output: string; input: string; net: string }[]; included: boolean; allowance: { net: string; limit: string; allowed: boolean } };
  issues: string[];
  warnings: string[];
  otherVatEntries: { id: string; number: number | null; date: string; memo: string | null; source: string; accounts: string[]; debit: string; credit: string }[];
  entries: { source: string; id: string; number: string; date: string; reversal?: boolean; treatment: string; rate: string; net: string; vat: string }[];
  submitted: { boxes: Boxes; submittedOn: string; reference: string | null; recordedBy: string; recordedAt: string; changedSince: { output: string; input: string; net: string } | null } | null;
}

const STATUS: Record<Period['status'], { label: string; tone: 'neutral' | 'accent' | 'warning' | 'negative' | 'positive' }> = {
  OPEN: { label: 'Open', tone: 'neutral' },
  DUE: { label: 'Due', tone: 'accent' },
  OVERDUE: { label: 'Overdue', tone: 'negative' },
  SUBMITTED: { label: 'Submitted', tone: 'positive' },
};
const SOURCE: Record<string, string> = { INVOICE: 'Invoice', CREDIT_NOTE: 'Credit note', BILL: 'Bill', VENDOR_CREDIT: 'Vendor credit', EXPENSE_CLAIM: 'Expense claim' };
/** Credit notes, vendor credits and voids take off: shown with a minus sign. */
const signed = (e: { source: string; reversal?: boolean }, x: string) => ((e.source === 'CREDIT_NOTE' || e.source === 'VENDOR_CREDIT') !== !!e.reversal && !/^0(\.0+)?$/.test(x) ? `-${x}` : x);

/** VAT and GST returns (TAX-030 UK, TAX-036 Singapore, TAX-035 Australia's BAS): the boxes for a period, prepared from the books, and the record of each submission to the tax authority. */
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
  const j = settings.data?.jurisdiction ?? r?.jurisdiction;
  if (!j) return <ErrorAlert title="Could not load the tax return" error={settings.error} />;
  const cash = (x: string) => <Money value={x} currency={j.currency} />;
  return (
    <>
      <PageHeader
        title={j.returnName}
        description={j.intro}
        actions={r ? <Button variant="secondary" size="sm" loading={busy} onClick={() => void download()}>Download {j.cardTitles.boxes} (CSV)</Button> : null}
      />
      <ErrorAlert title={`Could not load the ${j.taxName} settings`} error={settings.error} />
      {settings.data ? <SettingsCard data={settings.data} j={j} manage={manage} orgId={orgId} onSaved={refresh} /> : null}

      {periods.data?.setUp ? (
        <Card className="mb-4">
          <CardHeader title={j.cardTitles.periods} description={`Your recent ${j.taxName} periods. ${j.dueRule}`} />
          <Table aria-label={j.cardTitles.periods}>
            <thead><Tr><Th>Period</Th><Th>Due</Th><Th>Status</Th><Th numeric>Net {j.taxName}</Th><Th /></Tr></thead>
            <tbody>
              {periods.data.periods.map((p) => (
                <Tr key={p.end} className={p.end === end ? 'bg-surface-hover' : undefined}>
                  <Td>{date(p.start)} to {date(p.end)}</Td>
                  <Td>{date(p.due)}</Td>
                  <Td><Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Badge>{p.submittedOn ? <span className="ml-2 text-xs text-fg-muted">on {date(p.submittedOn)}</span> : null}</Td>
                  <Td numeric>{p.net ? <>{cash(p.net)} <span className="text-xs text-fg-muted">{p.direction === 'RECLAIM' ? 'to reclaim' : p.direction === 'PAY' ? 'to pay' : ''}</span></> : '—'}</Td>
                  <Td><Button size="sm" variant="ghost" aria-label={`Open the period ending ${date(p.end)}`} onClick={() => setEnd(p.end)}>Open</Button></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}
      <ErrorAlert title={`Could not load the ${j.taxName} return`} error={ret.error ?? periods.error} />
      {r ? <ReturnView r={r} j={j} cash={cash} treatments={Object.fromEntries((settings.data?.treatments ?? []).map((t) => [t.key, t.label]))} manage={manage} orgId={orgId} onRecorded={refresh} /> : null}
    </>
  );
}

function SettingsCard({ data, j, manage, orgId, onSaved }: { data: Settings; j: J; manage: boolean; orgId: string; onSaved: () => Promise<unknown> }) {
  const [vrn, setVrn] = useState(data.settings?.vrn ?? '');
  const [registeredFrom, setRegisteredFrom] = useState(data.settings?.registeredFrom ?? '');
  const [stagger, setStagger] = useState(data.settings?.stagger ?? 'QUARTERLY_MAR');
  const [region, setRegion] = useState(data.settings?.region ?? '');
  const [untaxed, setUntaxed] = useState<Treatment>(data.settings?.untaxedTreatment ?? 'OUTSIDE_SCOPE');
  const [set, setSet] = useState<Record<string, Treatment | ''>>(Object.fromEntries(data.rates.map((r) => [r.id, r.treatment ?? ''])));
  const [open, setOpen] = useState(!data.settings);
  const save = useMutation({
    mutationFn: () =>
      api(`/v1/orgs/${orgId}/tax/vat/settings`, { method: 'PUT', body: { vrn, registeredFrom, stagger, ...(j.region ? { region: region || null } : {}), untaxedTreatment: untaxed, treatments: Object.entries(set).filter(([, t]) => t).map(([taxRateId, treatment]) => ({ taxRateId, treatment })) } }),
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
        title={j.cardTitles.registration}
        description={s ? `${j.numberShort} ${s.vrn}, registered from ${date(s.registeredFrom)} · ${data.staggers.find((x) => x.key === s.stagger)?.label ?? s.stagger}${j.region && s.region ? ` · ${j.region.options.find((o) => o.key === s.region)?.label ?? s.region}` : ''}. Last changed by ${s.updatedBy}, ${date(s.updatedAt.slice(0, 10))}.` : `Add your ${j.numberName}, how often you make returns and how each tax rate counts on the return.`}
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
              <Field label={j.numberName} hint={j.numberHint}>{(p) => <Input {...p} value={vrn} maxLength={20} onChange={(e) => setVrn(e.target.value)} />}</Field>
              <Field label="Registered from" hint={`The effective date of your ${j.taxName} registration`}>{(p) => <Input {...p} type="date" value={registeredFrom} max={today()} onChange={(e) => setRegisteredFrom(e.target.value)} />}</Field>
              <Field label="Return periods">{(p) => <Select {...p} value={stagger} onChange={(e) => setStagger(e.target.value)}>{data.staggers.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</Select>}</Field>
              {j.region ? (
                <Field label={j.region.name} hint="Where your business is established">
                  {(p) => (
                    <Select {...p} value={region} onChange={(e) => setRegion(e.target.value)}>
                      <option value="">Choose</option>
                      {j.region!.options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                    </Select>
                  )}
                </Field>
              ) : null}
              <Field label="Lines with no tax rate" hint="How they count on the return">{(p) => <Select {...p} value={untaxed} onChange={(e) => setUntaxed(e.target.value as Treatment)}>{data.treatments.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</Select>}</Field>
            </div>
            <Table aria-label={`${j.taxName} treatment of tax rates`}>
              <thead><Tr><Th>Tax rate</Th><Th numeric>Rate</Th><Th>{j.taxName} treatment</Th></Tr></thead>
              <tbody>
                {data.rates.map((r) => (
                  <Tr key={r.id}>
                    <Td>{r.name}{r.isActive ? null : <Badge className="ml-2">Inactive</Badge>}</Td>
                    <Td numeric>{r.rate}%</Td>
                    <Td>
                      <Select aria-label={`${j.taxName} treatment of ${r.name}`} value={set[r.id] ?? ''} onChange={(e) => setSet({ ...set, [r.id]: e.target.value as Treatment | '' })}>
                        <option value="">{r.suggested ? `Suggested: ${label(r.suggested)}` : 'Choose a treatment'}</option>
                        {data.treatments.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                      </Select>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <ErrorAlert title={`Could not save the ${j.taxName} registration`} error={save.error} />
            <div className="flex gap-2">
              <Button type="submit" loading={save.isPending} disabled={!vrn.trim() || !registeredFrom}>Save {j.taxName} registration</Button>
              {s ? <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button> : null}
            </div>
          </form>
        ) : (
          <div className="p-4"><EmptyState title={`${j.taxName} is not set up yet`}>Someone who manages accounts adds the {j.numberName} and return periods.</EmptyState></div>
        )
      ) : null}
    </Card>
  );
}

function ReturnView({ r, j, cash, treatments, manage, orgId, onRecorded }: { r: VatReturn; j: J; cash: (x: string) => ReactNode; treatments: Record<string, string>; manage: boolean; orgId: string; onRecorded: () => Promise<unknown> }) {
  const [submittedOn, setSubmittedOn] = useState(today());
  const [reference, setReference] = useState('');
  const record = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/tax/vat/returns`, { method: 'POST', body: { periodEnd: r.period.end, submittedOn, reference: reference || null, net: r.net } }),
    onSuccess: onRecorded,
  });
  const st = STATUS[r.status];
  const sales = r.breakdown.filter((b) => b.side === 'SALES');
  const purchases = r.breakdown.filter((b) => b.side === 'PURCHASES');
  return (
    <>
      <Card className="mb-4">
        <CardHeader
          title={j.cardTitles.boxes}
          description={`${date(r.period.start)} to ${date(r.period.end)} · ${j.numberShort} ${r.vrn} · due ${date(r.period.due)}. ${j.unitsNote}`}
          actions={<Badge tone={st.tone}>{st.label}</Badge>}
        />
        <div className="space-y-3 px-4 pt-4">
          {r.issues.map((i) => <Alert key={i} tone="warning" title="Before recording the submission">{i}</Alert>)}
          {r.warnings.map((w) => <Alert key={w} tone="warning">{w}</Alert>)}
          {r.submitted?.changedSince ? (
            <Alert tone="warning" title="The books for this period changed after it was submitted">
              Output tax is {cash(r.submitted.changedSince.output)} different and input tax {cash(r.submitted.changedSince.input)}. The difference goes on your next return as a correction when it is within {j.authorityThe}&apos;s limit.
            </Alert>
          ) : null}
        </div>
        <Table aria-label={j.cardTitles.boxes}>
          <thead><Tr><Th>Box</Th><Th>Description</Th><Th numeric>Value</Th></Tr></thead>
          <tbody>
            {j.boxOrder.map((k) => (
              <Tr key={k} className={k === j.netBox ? 'font-semibold' : undefined}>
                <Td>{k === 'net' ? '' : k.replace('box', '').replace('-vat', '')}</Td>
                <Td>{r.labels[k]}</Td>
                <Td numeric>{j.wholeBoxes.includes(k) ? money(r.boxes[k] ?? '0', j.currency).replace(/\.00$/, '') : cash(r.boxes[k] ?? '0')}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
        <p className="px-4 pb-4 pt-2 text-sm" data-testid="vat-direction">
          {r.direction === 'PAY' ? `You pay ${j.authorityThe} ${money(r.net, j.currency)}.` : r.direction === 'RECLAIM' ? `${j.authorityThe.charAt(0).toUpperCase()}${j.authorityThe.slice(1)} repays you ${money(r.net, j.currency)}.` : 'Nothing to pay or reclaim.'}
          {r.corrections.included ? ' Includes corrections of earlier returns.' : ''}
        </p>
      </Card>

      {r.submitted ? (
        <Card className="mb-4">
          <CardHeader title="Submission recorded" description={`Submitted to ${j.authorityThe} on ${date(r.submitted.submittedOn)}${r.submitted.reference ? `, reference ${r.submitted.reference}` : ''}. Recorded by ${r.submitted.recordedBy}. The boxes above are kept as submitted.`} />
        </Card>
      ) : manage ? (
        <Card className="mb-4">
          <CardHeader title="Record the submission" description={`Once you have submitted these figures to ${j.authorityThe}, record it here. The boxes are then kept as submitted, and later changes to this period go on a later return.`} />
          <form
            className="grid gap-4 p-4 sm:grid-cols-[12rem_16rem_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              record.mutate();
            }}
          >
            <Field label="Submitted on">{(p) => <Input {...p} type="date" value={submittedOn} max={today()} onChange={(e) => setSubmittedOn(e.target.value)} />}</Field>
            <Field label={`${j.authority} reference`} hint="Optional">{(p) => <Input {...p} value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} />}</Field>
            <div className="flex items-end"><Button type="submit" loading={record.isPending} disabled={r.issues.length > 0}>Record as submitted</Button></div>
          </form>
          <ErrorAlert title="Could not record the submission" error={record.error} />
        </Card>
      ) : null}

      {r.corrections.pending.length ? (
        <Card className="mb-4">
          <CardHeader
            title="Corrections of earlier returns"
            description={j.correctionRule ? (r.corrections.allowance.allowed ? `Changes to periods already submitted, added to this return: ${j.correctionRule}.` : `Changes to periods already submitted, left off this return: ${j.correctionRule}. So ${j.overLimit}.`) : r.corrections.allowance.allowed ? `Changes to periods already submitted, added to the output and input tax of this return. Their net value of ${money(r.corrections.allowance.net, j.currency)} is within the ${money(r.corrections.allowance.limit, j.currency)} ${j.authorityThe} allows on a return.` : `Changes to periods already submitted. Their net value of ${money(r.corrections.allowance.net, j.currency)} is over the ${money(r.corrections.allowance.limit, j.currency)} ${j.authorityThe} allows on a return, so they are left off: ${j.overLimit}.`}
          />
          <Table aria-label="Corrections of earlier returns">
            <thead><Tr><Th>Period</Th><Th numeric>Output tax</Th><Th numeric>Input tax</Th><Th numeric>Net</Th></Tr></thead>
            <tbody>
              {r.corrections.pending.map((c) => (
                <Tr key={c.periodEnd}><Td>{date(c.periodStart)} to {date(c.periodEnd)}</Td><Td numeric>{cash(c.output)}</Td><Td numeric>{cash(c.input)}</Td><Td numeric>{cash(c.net)}</Td></Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}

      <Card className="mb-4">
        <CardHeader title={j.cardTitles.treatment} description={j.treatmentNote} />
        {r.breakdown.length ? (
          <Table aria-label={j.cardTitles.treatment}>
            <thead><Tr><Th>Side</Th><Th>Treatment</Th><Th numeric>Lines</Th><Th numeric>Net</Th><Th numeric>{j.taxName}</Th></Tr></thead>
            <tbody>
              {[...sales, ...purchases].map((b) => (
                <Tr key={`${b.side}${b.treatment}`}>
                  <Td>{b.side === 'SALES' ? 'Sales' : 'Purchases'}</Td>
                  <Td>{b.label}{b.counted ? null : <Badge className="ml-2">Not on the return</Badge>}</Td>
                  <Td numeric>{b.lines}</Td>
                  <Td numeric>{cash(b.net)}</Td>
                  <Td numeric>{cash(b.vat)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <div className="p-4"><EmptyState title="Nothing in this period">No posted invoices, bills or approved expense claims are dated in it.</EmptyState></div>
        )}
      </Card>

      <Card className="mb-4">
        <CardHeader title={j.cardTitles.other} description={`Posted entries in the period on the ${j.taxName} accounts that no invoice, bill or claim on the return made, such as ${j.taxName} paid to ${j.authorityThe} or a journal. Check none is ${j.taxName} that belongs on the return.`} />
        {r.otherVatEntries.length ? (
          <Table aria-label={j.cardTitles.other}>
            <thead><Tr><Th>Date</Th><Th>Entry</Th><Th>Accounts</Th><Th numeric>Debit</Th><Th numeric>Credit</Th></Tr></thead>
            <tbody>
              {r.otherVatEntries.map((e) => (
                <Tr key={e.id}>
                  <Td>{date(e.date)}</Td>
                  <Td><a className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${e.id}`}>{e.number ? `#${e.number}` : 'Entry'}</a> {e.memo}</Td>
                  <Td className="text-sm">{e.accounts.join(', ')}</Td>
                  <Td numeric>{cash(e.debit)}</Td>
                  <Td numeric>{cash(e.credit)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="p-4 text-sm text-fg-muted">None: everything on the {j.taxName} accounts in this period came from the documents on the return.</p>
        )}
      </Card>

      <Card>
        <CardHeader title="Entries on the return" description="Every line behind the boxes. Credit notes and vendor credits are taken off; a document voided in this period is taken off again here." />
        {r.entries.length ? (
          <Table aria-label="Entries on the return">
            <thead><Tr><Th>Date</Th><Th>Document</Th><Th>Treatment</Th><Th numeric>Rate</Th><Th numeric>Net</Th><Th numeric>{j.taxName}</Th></Tr></thead>
            <tbody>
              {r.entries.slice(0, 300).map((e, i) => (
                <Tr key={`${e.id}${i}`}>
                  <Td>{date(e.date)}</Td>
                  <Td>{SOURCE[e.source] ?? e.source} {e.number}{e.reversal ? <Badge tone="warning" className="ml-2">Voided</Badge> : null}</Td>
                  <Td className="text-sm">{treatments[e.treatment] ?? 'Not chosen yet'}</Td>
                  <Td numeric>{e.rate}%</Td>
                  <Td numeric>{cash(signed(e, e.net))}</Td>
                  <Td numeric>{cash(signed(e, e.vat))}</Td>
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

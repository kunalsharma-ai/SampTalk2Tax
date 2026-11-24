'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FORM_1099_KIND_LABEL, VENDOR_1099_STATUS_LABEL, W9_CLASSIFICATION_LABEL, type Form1099Kind, type Vendor1099Status, type W9Classification } from '@talk2tax/tax-engine';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, money, today } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

interface Profile {
  classification: W9Classification;
  tinType: 'SSN' | 'EIN';
  tinLast4: string | null;
  w9ReceivedOn: string | null;
  formKind: Form1099Kind;
  isAttorney: boolean;
}
interface Overview {
  year: number;
  today: string;
  currency: string;
  checkedOn: string;
  federal: {
    year: number;
    threshold: string;
    dueDates: { necRecipientAndIrs: string; miscRecipient: string; miscIrsPaper: string; miscIrsElectronic: string };
    rows: {
      contactId: string;
      name: string;
      status: Vendor1099Status;
      form: 'NEC' | 'MISC' | null;
      box: string | null;
      totalPaid: string;
      reportable: string;
      payments: number;
      tinType: string | null;
      tinLast4: string | null;
      reason: string;
    }[];
    summary: { nec: number; misc: number; needsW9: number; reportableTotal: string; mustEfile: boolean };
  };
  vendors: { contactId: string; name: string; profile: Profile | null }[];
  state: {
    registrations: { state: string; name: string; filingFrequency: string; registeredFrom: string }[];
    periods: { state: string; stateName: string; label: string; from: string; to: string; netSales: string; tax: string; invoices: number; timing: 'PAST' | 'CURRENT' | 'FUTURE' }[];
    taxTotal: string;
  };
}
const TONE: Record<Vendor1099Status, 'negative' | 'warning' | 'positive' | 'neutral'> = {
  REPORTABLE: 'positive',
  NEEDS_W9: 'negative',
  BELOW_THRESHOLD: 'neutral',
  CORPORATION: 'neutral',
  EXEMPT_PAYEE: 'neutral',
  NOT_REPORTABLE_KIND: 'neutral',
  CARD_ONLY: 'neutral',
  FOREIGN: 'warning',
};
const TIMING = { PAST: 'Period ended', CURRENT: 'In progress', FUTURE: 'Not started' } as const;
// A function, so the date is today in the organisation's time zone once it is known.
const blank = () => ({
  contactId: '',
  classification: 'INDIVIDUAL' as W9Classification,
  tinType: 'SSN' as 'SSN' | 'EIN',
  tinLast4: '',
  w9ReceivedOn: today(),
  formKind: 'NEC' as Form1099Kind,
  isAttorney: false,
});

/** Tax → US 1099s and state returns (TAX-029): the 1099-NEC and 1099-MISC due for a year, vendor W-9 details and the state sales tax returns. */
export default function UsReportingPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const thisYear = Number(today().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [w9, setW9] = useState(blank);
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ['us-reporting', orgId, year], queryFn: () => api<Overview>(`/v1/orgs/${orgId}/tax/us-reporting?year=${year}`) });
  const save = useMutation({
    mutationFn: () =>
      api<Overview>(`/v1/orgs/${orgId}/tax/us-reporting/vendors/${w9.contactId}`, {
        method: 'PUT',
        body: { classification: w9.classification, tinType: w9.tinType, tinLast4: w9.tinLast4 || null, w9ReceivedOn: w9.w9ReceivedOn || null, formKind: w9.formKind, isAttorney: w9.isAttorney },
      }),
    onSuccess: () => {
      setW9(blank());
      return qc.invalidateQueries({ queryKey: ['us-reporting', orgId] });
    },
  });
  const remove = useMutation({
    mutationFn: (contactId: string) => api<Overview>(`/v1/orgs/${orgId}/tax/us-reporting/vendors/${contactId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['us-reporting', orgId] }),
  });
  if (!org) return null;
  const d = q.data;
  const m = (x: string) => money(x, d?.currency ?? 'USD');
  const manage = can(org.role, 'accounts.manage');
  const download = async () => {
    setBusy(true);
    try {
      const x = await api<{ fileName: string; csv: string }>(`/v1/orgs/${orgId}/tax/us-reporting/1099/export?year=${year}`);
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
  const edit = (v: Overview['vendors'][number]) =>
    setW9(v.profile ? { contactId: v.contactId, ...v.profile, tinLast4: v.profile.tinLast4 ?? '', w9ReceivedOn: v.profile.w9ReceivedOn ?? '' } : { ...blank(), contactId: v.contactId });
  return (
    <>
      <PageHeader
        title="US 1099s and state returns"
        description="The 1099-NEC and 1099-MISC forms due for what you paid vendors in a calendar year, worked out from your vendor payments and their W-9s, and the sales tax returns each state permit calls for. Talk2Tax files nothing with the IRS or any state, and the rules need review by a US tax adviser."
      />
      <div className="mb-4 flex items-end gap-3">
        <Field label="Calendar year">
          {(p) => (
            <Select {...p} value={String(year)} onChange={(e) => setYear(Number(e.target.value))}>
              {[thisYear + 1, thisYear, thisYear - 1, thisYear - 2].map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <ErrorAlert title="Could not load US reporting" error={q.error} />
      {d ? (
        <>
          {d.federal.summary.needsW9 ? (
            <Alert tone="accent" title={`${d.federal.summary.needsW9} vendor${d.federal.summary.needsW9 === 1 ? ' needs' : 's need'} a W-9`}>
              They were paid above the threshold, but no W-9 is on record. Ask for one before the January deadline.
            </Alert>
          ) : null}
          <Card className="mt-4" role="region" aria-label="1099s for the year">
            <CardHeader
              title="1099s for the year"
              description={`Vendor payments from the bank in ${d.year}. The threshold is ${m(d.federal.threshold)} a vendor. 1099-NEC is due to vendors and the IRS by ${date(d.federal.dueDates.necRecipientAndIrs)}; 1099-MISC to vendors by ${date(d.federal.dueDates.miscRecipient)} and the IRS by ${date(d.federal.dueDates.miscIrsPaper)} on paper or ${date(d.federal.dueDates.miscIrsElectronic)} electronically. Rules checked on ${date(d.checkedOn)}.`}
              actions={
                <Button variant="secondary" size="sm" loading={busy} disabled={!d.federal.rows.length} onClick={download}>
                  Export 1099 CSV
                </Button>
              }
            />
            <dl className="grid grid-cols-2 gap-4 px-4 pb-4 sm:grid-cols-4">
              <div>
                <dt className="text-xs text-fg-muted">1099-NEC to file</dt>
                <dd className="text-lg font-semibold">{d.federal.summary.nec}</dd>
              </div>
              <div>
                <dt className="text-xs text-fg-muted">1099-MISC to file</dt>
                <dd className="text-lg font-semibold">{d.federal.summary.misc}</dd>
              </div>
              <div>
                <dt className="text-xs text-fg-muted">W-9s missing</dt>
                <dd className="text-lg font-semibold">{d.federal.summary.needsW9}</dd>
              </div>
              <div>
                <dt className="text-xs text-fg-muted">Amount to report</dt>
                <dd className="text-lg font-semibold">{m(d.federal.summary.reportableTotal)}</dd>
              </div>
            </dl>
            {d.federal.summary.mustEfile ? <p className="px-4 pb-4 text-sm">You file 10 or more information returns, so they must be filed electronically.</p> : null}
            {d.federal.rows.length ? (
              <Table aria-label="1099s for the year">
                <thead>
                  <Tr>
                    <Th>Vendor</Th>
                    <Th>Decision</Th>
                    <Th>Form</Th>
                    <Th className="text-right">Paid</Th>
                    <Th className="text-right">To report</Th>
                    <Th>TIN</Th>
                    <Th>Why</Th>
                  </Tr>
                </thead>
                <tbody>
                  {d.federal.rows.map((r) => (
                    <Tr key={r.contactId}>
                      <Td className="align-top">
                        <Link className="underline" href={`/orgs/${orgId}/purchases/vendors/${r.contactId}`}>
                          {r.name}
                        </Link>
                        <span className="block text-xs text-fg-muted">
                          {r.payments} payment{r.payments === 1 ? '' : 's'}
                        </span>
                      </Td>
                      <Td className="align-top">
                        <Badge tone={TONE[r.status]}>{VENDOR_1099_STATUS_LABEL[r.status]}</Badge>
                      </Td>
                      <Td className="align-top">{r.form ? `1099-${r.form} box ${r.box}` : '—'}</Td>
                      <Td className="align-top text-right">{m(r.totalPaid)}</Td>
                      <Td className="align-top text-right">{m(r.reportable)}</Td>
                      <Td className="align-top">{r.tinLast4 ? `${r.tinType} ending ${r.tinLast4}` : '—'}</Td>
                      <Td className="align-top text-sm">{r.reason}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="No vendor payments this year">1099s are worked out from what you pay vendors from the bank.</EmptyState>
            )}
          </Card>

          <Card className="mt-6" role="region" aria-label="Vendor W-9 details">
            <CardHeader
              title="Vendor W-9 details"
              description="What each vendor's Form W-9 says. Keep the signed form itself in your files: Talk2Tax keeps only the last four digits of the taxpayer number."
            />
            {d.vendors.length ? (
              <Table aria-label="Vendor W-9 details">
                <thead>
                  <Tr>
                    <Th>Vendor</Th>
                    <Th>Classification</Th>
                    <Th>Paid for</Th>
                    <Th>W-9 received</Th>
                    {manage ? (
                      <Th>
                        <span className="sr-only">Actions</span>
                      </Th>
                    ) : null}
                  </Tr>
                </thead>
                <tbody>
                  {d.vendors.map((v) => (
                    <Tr key={v.contactId}>
                      <Td>{v.name}</Td>
                      <Td className="text-sm">
                        {v.profile ? (
                          <>
                            <span className="block">{W9_CLASSIFICATION_LABEL[v.profile.classification]}</span>
                            <span className="block text-xs text-fg-muted">
                              {v.profile.tinLast4 ? `${v.profile.tinType} ending ${v.profile.tinLast4}` : `No ${v.profile.tinType}`}
                              {v.profile.isAttorney ? ', attorney' : ''}
                            </span>
                          </>
                        ) : (
                          'No W-9'
                        )}
                      </Td>
                      <Td className="text-sm">{v.profile ? FORM_1099_KIND_LABEL[v.profile.formKind] : '—'}</Td>
                      <Td>{v.profile?.w9ReceivedOn ? date(v.profile.w9ReceivedOn) : '—'}</Td>
                      {manage ? (
                        <Td className="whitespace-nowrap text-right">
                          <Button size="sm" variant="ghost" onClick={() => edit(v)}>
                            {v.profile ? 'Edit' : 'Add'} W-9 for {v.name}
                          </Button>
                          {v.profile ? (
                            <Button size="sm" variant="ghost" loading={remove.isPending && remove.variables === v.contactId} onClick={() => remove.mutate(v.contactId)}>
                              Remove
                            </Button>
                          ) : null}
                        </Td>
                      ) : null}
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="No vendors yet">Add vendors under Purchases.</EmptyState>
            )}
            {manage && w9.contactId ? (
              <form
                aria-label="W-9 details"
                className="flex flex-wrap items-end gap-3 border-t border-line p-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  save.mutate();
                }}
              >
                <p className="w-full text-sm font-medium">W-9 for {d.vendors.find((v) => v.contactId === w9.contactId)?.name}</p>
                <Field label="Tax classification">
                  {(p) => (
                    <Select {...p} value={w9.classification} onChange={(e) => setW9({ ...w9, classification: e.target.value as W9Classification })}>
                      {(Object.keys(W9_CLASSIFICATION_LABEL) as W9Classification[]).map((k) => (
                        <option key={k} value={k}>
                          {W9_CLASSIFICATION_LABEL[k]}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label="Number type">
                  {(p) => (
                    <Select {...p} value={w9.tinType} onChange={(e) => setW9({ ...w9, tinType: e.target.value as 'SSN' | 'EIN' })}>
                      <option value="SSN">SSN</option>
                      <option value="EIN">EIN</option>
                    </Select>
                  )}
                </Field>
                <Field label="Last 4 digits">
                  {(p) => <Input {...p} inputMode="numeric" maxLength={4} pattern="[0-9]{4}" value={w9.tinLast4} onChange={(e) => setW9({ ...w9, tinLast4: e.target.value.replace(/[^0-9]/g, '') })} />}
                </Field>
                <Field label="W-9 received">{(p) => <Input {...p} type="date" value={w9.w9ReceivedOn} onChange={(e) => setW9({ ...w9, w9ReceivedOn: e.target.value })} />}</Field>
                <Field label="Paid for">
                  {(p) => (
                    <Select {...p} value={w9.formKind} onChange={(e) => setW9({ ...w9, formKind: e.target.value as Form1099Kind })}>
                      {(Object.keys(FORM_1099_KIND_LABEL) as Form1099Kind[]).map((k) => (
                        <option key={k} value={k}>
                          {FORM_1099_KIND_LABEL[k]}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <label className="flex items-center gap-2 pb-2 text-sm">
                  <input type="checkbox" checked={w9.isAttorney} onChange={(e) => setW9({ ...w9, isAttorney: e.target.checked })} />
                  Legal services
                </label>
                <Button type="submit" loading={save.isPending}>
                  Save W-9
                </Button>
                <Button type="button" variant="ghost" onClick={() => setW9(blank())}>
                  Cancel
                </Button>
              </form>
            ) : null}
            <div className="px-4 pb-4">
              <ErrorAlert title="Could not save the W-9" error={save.error ?? remove.error} />
            </div>
          </Card>

          <Card className="mt-6" role="region" aria-label="State sales tax returns">
            <CardHeader
              title="State sales tax returns"
              description={`The returns your state permits call for in ${d.year}, with the sales and tax charged in each period (customers' state). Total tax ${m(d.state.taxTotal)}. Due dates differ by state: check each state's filing calendar.`}
            />
            {d.state.periods.length ? (
              <Table aria-label="State sales tax returns">
                <thead>
                  <Tr>
                    <Th>State</Th>
                    <Th>Period</Th>
                    <Th>Status</Th>
                    <Th className="text-right">Net sales</Th>
                    <Th className="text-right">Tax charged</Th>
                    <Th className="text-right">Invoices</Th>
                  </Tr>
                </thead>
                <tbody>
                  {d.state.periods.map((p) => (
                    <Tr key={p.state + p.from}>
                      <Td>{p.stateName}</Td>
                      <Td>
                        <span className="block">{p.label}</span>
                        <span className="block text-xs text-fg-muted">
                          {date(p.from)} to {date(p.to)}
                        </span>
                      </Td>
                      <Td>{TIMING[p.timing]}</Td>
                      <Td className="text-right">{m(p.netSales)}</Td>
                      <Td className="text-right">{m(p.tax)}</Td>
                      <Td className="text-right">{p.invoices}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="No state permits">
                Record your permits on{' '}
                <Link className="underline" href={`/orgs/${orgId}/tax/us-sales-tax`}>
                  US sales tax
                </Link>
                .
              </EmptyState>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}

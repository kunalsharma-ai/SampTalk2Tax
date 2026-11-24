'use client';
import { useQuery } from '@tanstack/react-query';
import type { EInvoicingMilestone, EInvoicingRule, InvoiceContentGap, InvoiceFormatRule, InvoiceRequirementKey, MilestoneFit } from '@talk2tax/tax-engine';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, money, today } from '@/lib/format';
import { useOrg } from '@/lib/org';

type Tier = Omit<InvoiceFormatRule['tiers'][number], 'items'> & { items: { key: InvoiceRequirementKey; when?: string; label: string }[] };
interface Overview {
  today: string;
  country: string;
  covered: boolean;
  coveredCountries: { country: string; countryName: string }[];
  format: (Omit<InvoiceFormatRule, 'tiers'> & { tiers: Tier[] }) | null;
  seller: { taxNumber: string | null; taxNumberName: string; address: boolean; defaultTemplate: string; templateWarnings: string[] };
  eInvoicing:
    | (EInvoicingRule & {
        setUpInTalk2Tax: boolean | null;
        turnover: {
          basis: string;
          source: 'BOOKS' | 'ENTERED' | 'NONE';
          amount: string | null;
          currency: string;
          usedYear: string | null;
          rule: string;
          years: { label: string; amount: string; documents: number }[];
        } | null;
        outlook: {
          verdict: 'MUST_ISSUE' | 'WILL_HAVE_TO_ISSUE' | 'CHECK' | 'NOT_REQUIRED';
          headline: string;
          mustReceive: boolean;
          milestones: (EInvoicingMilestone & { inForce: boolean; fit: MilestoneFit; why: string })[];
        };
      })
    | null;
  otherCountries: { country: string; countryName: string; status: EInvoicingRule['status']; summary: string; format: string; source: string }[];
}
interface Row {
  id: string;
  kind: string;
  status: string;
  number: string | null;
  issueDate: string;
  contactName: string;
  currency: string;
  total: string;
  totalLocal: string;
  template: string;
  format: string;
  gaps: InvoiceContentGap[];
}
interface Check {
  from: string;
  to: string;
  currency: string;
  checked: number;
  truncated: boolean;
  complete: number;
  withGaps: number;
  byRequirement: { key: string; label: string; count: number }[];
  templateWarnings: { template: string; message: string }[];
  invoices: Row[];
}

const STATUS_LABEL = { IN_FORCE: 'In force', PHASING_IN: 'Phasing in', ANNOUNCED: 'Announced', NOT_REQUIRED: 'Not required' } as const;
const STATUS_TONE = { IN_FORCE: 'negative', PHASING_IN: 'warning', ANNOUNCED: 'accent', NOT_REQUIRED: 'positive' } as const;
const FIT_LABEL = { APPLIES: 'Applies to you', DOES_NOT_APPLY: 'Does not apply', CHECK: 'Check' } as const;
const FIT_TONE = { APPLIES: 'warning', DOES_NOT_APPLY: 'neutral', CHECK: 'accent' } as const;
const WHAT = { ISSUE: 'Issue e-invoices', RECEIVE: 'Receive e-invoices', PILOT: 'Pilot' } as const;
const WHEN = { BUYER_REGISTERED: 'when the customer is registered', REVERSE_CHARGE: 'on reverse-charge sales', INTERSTATE: 'on sales to another state' } as Record<string, string>;
const cap = (x: string) => x.replace(/^the /, 'The ');
const minus89 = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) - 89 * 86_400_000).toISOString().slice(0, 10);

/** Tax → Invoice requirements (TAX-039, TAX-040): what invoices must show in the organisation's country, which ones fall short, and when e-invoicing applies. */
export default function InvoiceRequirementsPage() {
  const { org, orgId } = useOrg();
  const [to, setTo] = useState(today());
  const [from, setFrom] = useState(minus89(today()));
  const [typed, setTyped] = useState('');
  const [turnover, setTurnover] = useState<string | null>(null);
  const o = useQuery({
    queryKey: ['invoice-requirements', orgId, turnover],
    queryFn: () => api<Overview>(`/v1/orgs/${orgId}/invoice-requirements${turnover ? `?turnover=${encodeURIComponent(turnover)}` : ''}`),
  });
  const covered = !!o.data?.covered;
  const c = useQuery({
    queryKey: ['invoice-requirements-check', orgId, from, to],
    queryFn: () => api<Check>(`/v1/orgs/${orgId}/invoice-requirements/check?from=${from}&to=${to}`),
    enabled: covered && from <= to,
  });
  if (!org) return null;
  const d = o.data;
  const e = d?.eInvoicing;
  return (
    <>
      <PageHeader
        title="Invoice requirements"
        description="What a sales invoice must show under your country's rules, which of your invoices and credit notes fall short and how to put them right, and when you have to issue or receive invoices electronically. Each rule names the law or guidance it comes from."
      />
      <ErrorAlert title="Could not load the invoice rules" error={o.error} />
      {d && !d.covered ? (
        <Alert tone="accent" title="Your country is not covered yet">
          Talk2Tax checks invoices against the rules of {d.coveredCountries.map((x) => x.countryName).join(', ')}. It does not guess the rules of other countries: ask your tax adviser what your
          invoices must show.
        </Alert>
      ) : null}
      {d?.format ? (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Card className="p-4">
              <p className="text-sm text-fg-muted">Your {d.seller.taxNumberName}</p>
              <p className={`mt-1 text-lg font-semibold ${d.seller.taxNumber ? '' : 'text-negative'}`}>{d.seller.taxNumber ?? 'Not on file'}</p>
              <p className="text-xs text-fg-muted">
                {d.seller.taxNumber ? (
                  'Printed on every invoice'
                ) : (
                  <Link className="underline" href={`/orgs/${orgId}/${d.country === 'IN' ? 'settings/gst' : 'tax/vat-return'}`}>
                    Add it
                  </Link>
                )}
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-sm text-fg-muted">Your address</p>
              <p className={`mt-1 text-lg font-semibold ${d.seller.address ? '' : 'text-negative'}`}>{d.seller.address ? 'On the invoice' : 'Missing'}</p>
              <p className="text-xs text-fg-muted">Default template: {d.seller.defaultTemplate}</p>
            </Card>
            <Card className="p-4">
              <p className="text-sm text-fg-muted">Invoices with gaps</p>
              <p className={`mt-1 text-2xl font-semibold ${c.data?.withGaps ? 'text-negative' : ''}`}>{c.data ? c.data.withGaps : '…'}</p>
              <p className="text-xs text-fg-muted">{c.data ? `Of ${c.data.checked} checked, ${date(c.data.from)} to ${date(c.data.to)}` : 'Checking'}</p>
            </Card>
          </div>

          <Card className="mt-6" role="region" aria-label="What an invoice must show">
            <CardHeader
              title="What an invoice must show"
              description={`In ${d.format.countryName}, by the total including tax in ${d.format.currency}. Source: ${d.format.source}. Checked on ${date(d.format.checkedOn)}.`}
            />
            <div className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
              {d.format.tiers.map((t, i) => {
                const next = d.format!.tiers[i + 1];
                const range = next
                  ? `${i === 0 ? 'Up to' : `Above ${money(t.from, d.format!.currency)}, up to`} ${money(next.from, d.format!.currency)}`
                  : i === 0
                    ? 'Any amount'
                    : `${t.fromInclusive ? 'From' : 'Above'} ${money(t.from, d.format!.currency)}`;
                return (
                  <div key={t.name} className="rounded border border-line p-3">
                    <h3 className="font-medium">{t.name}</h3>
                    <p className="text-xs text-fg-muted">
                      {range}
                      {t.registeredBuyerOnly ? ', to a registered customer' : ''}
                    </p>
                    {t.items.length ? (
                      <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm">
                        {t.items.map((it) => (
                          <li key={it.key + (it.when ?? '')}>
                            {it.label}
                            {it.when ? <span className="text-fg-muted"> ({WHEN[it.when]})</span> : null}
                            {it.key === 'TITLE' && d.format!.titleWords ? <span className="text-fg-muted"> (&quot;{d.format!.titleWords}&quot;)</span> : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-sm text-fg-muted">Nothing is required unless the customer asks.</p>
                    )}
                  </div>
                );
              })}
            </div>
            {d.format.alsoRequired.length ? (
              <div className="border-t border-line p-4 text-sm">
                <p className="font-medium">Also required, not checked from the books</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-fg-muted">
                  {d.format.alsoRequired.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>

          <Card className="mt-6" role="region" aria-label="Invoices against the rules">
            <CardHeader
              title="Invoices against the rules"
              description="Sales invoices and credit notes dated in the period, drafts included, with what each is missing. Fix the gap where the books hold it and the next print is right."
              actions={
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="From">{(p) => <Input {...p} type="date" value={from} onChange={(ev) => setFrom(ev.target.value)} />}</Field>
                  <Field label="To date">{(p) => <Input {...p} type="date" value={to} onChange={(ev) => setTo(ev.target.value)} />}</Field>
                </div>
              }
            />
            <ErrorAlert title="Could not check the invoices" error={c.error} />
            {c.data?.templateWarnings.length ? (
              <div className="px-4 pb-2">
                <Alert tone="warning" title="Template warnings">
                  <ul className="list-disc pl-5">
                    {c.data.templateWarnings.map((w) => (
                      <li key={w.template + w.message}>
                        {w.template}: {w.message}
                      </li>
                    ))}
                  </ul>
                </Alert>
              </div>
            ) : null}
            {c.data?.byRequirement.length ? <p className="px-4 pb-2 text-sm text-fg-muted">Most often missing: {c.data.byRequirement.map((b) => `${b.label} (${b.count})`).join(', ')}.</p> : null}
            {c.data && c.data.invoices.length ? (
              <Table aria-label="Invoices against the rules">
                <thead>
                  <Tr>
                    <Th>Invoice</Th>
                    <Th>Customer</Th>
                    <Th className="text-right">Total</Th>
                    <Th>Format</Th>
                    <Th>Missing</Th>
                  </Tr>
                </thead>
                <tbody>
                  {c.data.invoices.map((r) => (
                    <Tr key={r.id}>
                      <Td className="align-top whitespace-nowrap">
                        <Link className="underline" href={`/orgs/${orgId}/sales/invoices/${r.id}`}>
                          {r.number ?? 'Draft'}
                        </Link>
                        <span className="block text-xs text-fg-muted">
                          {r.kind === 'CREDIT_NOTE' ? 'Credit note, ' : ''}
                          {date(r.issueDate)}
                        </span>
                      </Td>
                      <Td className="align-top">{r.contactName}</Td>
                      <Td className="align-top text-right whitespace-nowrap">
                        {money(r.total, r.currency)}
                        {r.currency !== c.data!.currency ? <span className="block text-xs text-fg-muted">{money(r.totalLocal, c.data!.currency)}</span> : null}
                      </Td>
                      <Td className="align-top">
                        <span className="block">{r.format}</span>
                        <span className="block text-xs text-fg-muted">{r.template}</span>
                      </Td>
                      <Td className="align-top">
                        {r.gaps.length ? (
                          <ul className="max-w-md space-y-1 text-sm">
                            {r.gaps.map((g) => (
                              <li key={g.key}>
                                <span className="text-negative">
                                  {g.label}
                                  {g.lines ? ` (line ${g.lines.join(', ')})` : ''}
                                </span>
                                <span className="block text-xs text-fg-muted">{g.fix}</span>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <Badge tone="positive">Complete</Badge>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : c.data ? (
              <EmptyState title="No invoices in this period">Choose another period to check.</EmptyState>
            ) : null}
            {c.data?.truncated ? <p className="p-4 text-xs text-fg-muted">Only the latest {c.data.checked} are shown: choose a shorter period to check the rest.</p> : null}
          </Card>
        </>
      ) : null}

      {e ? (
        <>
          <Card className="mt-6" role="region" aria-label="E-invoicing for you">
            <CardHeader
              title="E-invoicing for you"
              description={`${cap(e.countryName)}: ${STATUS_LABEL[e.status].toLowerCase()}. Source: ${e.source}. Checked on ${date(e.checkedOn)}.`}
              actions={<Badge tone={STATUS_TONE[e.status]}>{STATUS_LABEL[e.status]}</Badge>}
            />
            <div className="space-y-3 p-4 text-sm">
              <p className="text-base font-medium">{e.outlook.headline}</p>
              {e.outlook.mustReceive ? <p>You must already be able to receive e-invoices from your suppliers.</p> : null}
              <p className="text-fg-muted">{e.summary}</p>
              <dl className="grid gap-2 sm:grid-cols-3">
                <div>
                  <dt className="text-fg-muted">Format</dt>
                  <dd>{e.format}</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">How invoices travel</dt>
                  <dd>{e.channel}</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">In Talk2Tax</dt>
                  <dd>
                    {e.inTalk2Tax}
                    {e.setUpInTalk2Tax === false ? (
                      <>
                        {' '}
                        <Link className="underline" href={`/orgs/${orgId}/settings/e-invoicing`}>
                          Set up e-invoicing
                        </Link>
                      </>
                    ) : null}
                  </dd>
                </div>
              </dl>
              {e.turnover ? (
                <div className="rounded border border-line p-3">
                  <p className="font-medium">Turnover tested</p>
                  <p className="text-fg-muted">
                    {e.turnover.source === 'BOOKS'
                      ? `${money(e.turnover.amount!, e.turnover.currency)} from the books, ${e.turnover.usedYear} (${e.turnover.rule.toLowerCase()}).`
                      : e.turnover.source === 'ENTERED'
                        ? `${money(e.turnover.amount!, e.turnover.currency)}, the figure you entered.`
                        : 'No completed year of sales in the books: enter your turnover to test the thresholds.'}
                  </p>
                  <form
                    className="mt-2 flex flex-wrap items-end gap-2"
                    onSubmit={(ev) => {
                      ev.preventDefault();
                      setTurnover(typed.trim() || null);
                    }}
                  >
                    <Field label={`Turnover to test (${e.turnover.currency})`}>
                      {(p) => <Input {...p} inputMode="decimal" value={typed} onChange={(ev) => setTyped(ev.target.value)} placeholder="e.g. 900000" />}
                    </Field>
                    <Button type="submit" variant="secondary">
                      Test
                    </Button>
                    {turnover ? (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          setTyped('');
                          setTurnover(null);
                        }}
                      >
                        Use the books
                      </Button>
                    ) : null}
                  </form>
                </div>
              ) : null}
            </div>
            {e.outlook.milestones.length ? (
              <Table aria-label="E-invoicing dates">
                <thead>
                  <Tr>
                    <Th>From</Th>
                    <Th>What</Th>
                    <Th>Who</Th>
                    <Th>For you</Th>
                  </Tr>
                </thead>
                <tbody>
                  {e.outlook.milestones.map((m) => (
                    <Tr key={m.from + m.who}>
                      <Td className="whitespace-nowrap">
                        {date(m.from)}
                        <span className="block text-xs text-fg-muted">{m.inForce ? 'In force' : 'Not yet'}</span>
                      </Td>
                      <Td>{WHAT[m.what]}</Td>
                      <Td>{m.who}</Td>
                      <Td>
                        <Badge tone={FIT_TONE[m.fit]}>{FIT_LABEL[m.fit]}</Badge>
                        <span className="block text-xs text-fg-muted">{m.why}</span>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : null}
          </Card>
        </>
      ) : null}

      {d ? (
        <Card className="mt-6" role="region" aria-label="E-invoicing elsewhere">
          <CardHeader title="E-invoicing elsewhere" description="The other countries Talk2Tax keeps e-invoicing rules for, useful when you sell or set up abroad." />
          <Table aria-label="E-invoicing elsewhere">
            <thead>
              <Tr>
                <Th>Country</Th>
                <Th>Status</Th>
                <Th>What applies</Th>
              </Tr>
            </thead>
            <tbody>
              {d.otherCountries.map((x) => (
                <Tr key={x.country}>
                  <Td className="align-top whitespace-nowrap">{x.countryName.replace(/^the /, '').replace(/^./, (ch) => ch.toUpperCase())}</Td>
                  <Td className="align-top whitespace-nowrap">
                    <Badge tone={STATUS_TONE[x.status]}>{STATUS_LABEL[x.status]}</Badge>
                  </Td>
                  <Td className="align-top text-sm">
                    {x.summary}
                    <span className="block text-xs text-fg-muted">
                      {x.format}. Source: {x.source}
                    </span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <p className="p-4 text-xs text-fg-muted">Talk2Tax does not send invoices to any government portal or e-invoicing network. Rules change: each entry shows when it was last checked.</p>
        </Card>
      ) : null}
    </>
  );
}

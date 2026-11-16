'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Money } from '@/components/money';
import { date } from '@/lib/format';

/**
 * The customer portal (AR-030): what a customer sees when they open the private link a business
 * sent them. No sign-in: the secret in the link is the check. Read-only: invoices, what is owed,
 * payments received, the statement, and a way to pay where the business made a payment link.
 */
type State = 'OPEN' | 'OVERDUE' | 'PART_PAID' | 'PAID' | 'VOID' | 'UNUSED_CREDIT' | 'USED';
interface Portal {
  from: { name: string; tradeName: string; gstin: string | null };
  customer: { name: string; gstin: string | null };
  link: { expiresAt: string | null };
  today: string;
  balances: { currency: string; owed: string; overdue: string; credits: string; balance: string }[];
  invoices: { id: string; kind: 'INVOICE' | 'CREDIT_NOTE'; number: string; reference: string | null; issueDate: string; dueDate: string | null; currency: string; total: string; open: string; state: State; daysOverdue: number; payLink: { reference: string; url: string; expiresAt: string | null } | null }[];
  receipts: { id: string; number: string; date: string; amount: string; currency: string; status: string; reference: string | null }[];
}
interface Statement {
  currency: string;
  currencies: string[];
  from: string;
  to: string;
  openingBalance: string;
  closingBalance: string;
  lines: { date: string; kind: string; id: string | null; number: string; description: string; charge: string | null; credit: string | null; balance: string }[];
}
const STATE: Record<State, { label: string; tone: 'neutral' | 'positive' | 'warning' | 'negative' | 'accent' }> = {
  OPEN: { label: 'To pay', tone: 'accent' },
  OVERDUE: { label: 'Overdue', tone: 'negative' },
  PART_PAID: { label: 'Part paid', tone: 'warning' },
  PAID: { label: 'Paid', tone: 'positive' },
  VOID: { label: 'Cancelled', tone: 'neutral' },
  UNUSED_CREDIT: { label: 'Credit to use', tone: 'accent' },
  USED: { label: 'Credit used', tone: 'neutral' },
};

class PortalError extends Error {}
async function get<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: 'no-store' });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new PortalError(body?.message ?? 'This page could not be loaded. Try again in a minute.');
  return body as T;
}

export default function CustomerPortalPage() {
  const { token } = useParams<{ token: string }>();
  const base = `/api/portal/${encodeURIComponent(token)}`;
  const q = useQuery({ queryKey: ['portal', token], queryFn: () => get<Portal>(base), retry: false });
  const [show, setShow] = useState<'open' | 'all'>('open');
  if (q.error) {
    return (
      <Shell>
        <div className="mx-auto mt-16 max-w-md rounded-[var(--t2t-radius-lg)] border border-line bg-surface p-8 text-center">
          <h1 className="text-lg font-semibold">This link cannot be opened</h1>
          <p className="mt-3 text-sm text-fg-muted">{q.error.message}</p>
        </div>
      </Shell>
    );
  }
  const p = q.data;
  if (!p) return <Shell><p className="mt-16 text-center text-sm text-fg-muted">Loading…</p></Shell>;
  const rows = show === 'open' ? p.invoices.filter((i) => ['OPEN', 'OVERDUE', 'PART_PAID', 'UNUSED_CREDIT'].includes(i.state)) : p.invoices;
  return (
    <Shell>
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-6">
        <div>
          <p className="text-sm text-fg-muted">Account statement from</p>
          <h1 className="text-2xl font-semibold">{p.from.name}</h1>
          {p.from.gstin ? <p className="mt-1 text-sm text-fg-muted">GSTIN <span className="num">{p.from.gstin}</span></p> : null}
        </div>
        <div className="sm:text-right">
          <p className="text-sm text-fg-muted">For</p>
          <p className="text-lg font-medium">{p.customer.name}</p>
          {p.customer.gstin ? <p className="text-sm text-fg-muted">GSTIN <span className="num">{p.customer.gstin}</span></p> : null}
        </div>
      </header>

      <section aria-label="What you owe" className="mt-6 grid gap-4 sm:grid-cols-3">
        {(p.balances.length ? p.balances : [{ currency: 'INR', owed: '0.00', overdue: '0.00', credits: '0.00', balance: '0.00' }]).map((b) => (
          <BalanceCards key={b.currency} b={b} multi={p.balances.length > 1} />
        ))}
      </section>

      <Card className="mt-6" role="region" aria-label="Your invoices">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">Invoices</h2>
            <p className="text-sm text-fg-muted">Open an invoice to see or print it. Where there is a Pay button, you can pay online through {p.from.tradeName}&apos;s payment gateway.</p>
          </div>
          <div className="w-40">
            <Select aria-label="Which invoices" value={show} onChange={(e) => setShow(e.target.value as 'open' | 'all')}>
              <option value="open">To pay</option>
              <option value="all">All</option>
            </Select>
          </div>
        </div>
        {rows.length ? (
          <Table aria-label="Invoices">
            <thead><Tr><Th>Number</Th><Th>Date</Th><Th>Due</Th><Th numeric>Amount</Th><Th numeric>Still to pay</Th><Th>Status</Th><Th><span className="sr-only">Pay</span></Th></Tr></thead>
            <tbody>
              {rows.map((i) => (
                <Tr key={i.id}>
                  <Td>
                    <a className="text-accent hover:underline" href={`${base}/documents/${i.id}`} target="_blank" rel="noopener noreferrer">{i.number}</a>
                    <span className="block text-xs text-fg-muted">{i.kind === 'CREDIT_NOTE' ? 'Credit note' : 'Invoice'}{i.reference ? ` · ${i.reference}` : ''}</span>
                  </Td>
                  <Td>{date(i.issueDate)}</Td>
                  <Td>{i.dueDate ? date(i.dueDate) : '—'}{i.daysOverdue ? <span className="block text-xs text-negative">{i.daysOverdue} {i.daysOverdue === 1 ? 'day' : 'days'} late</span> : null}</Td>
                  <Td numeric><Money value={i.total} currency={i.currency} /></Td>
                  <Td numeric>{i.kind === 'INVOICE' ? <Money value={i.open} currency={i.currency} /> : <span className="text-fg-muted">−<Money value={i.open} currency={i.currency} /></span>}</Td>
                  <Td><Badge tone={STATE[i.state].tone}>{STATE[i.state].label}</Badge></Td>
                  <Td className="text-right">
                    {i.payLink ? <a className="inline-flex rounded-[var(--t2t-radius-md)] bg-[var(--t2t-accent)] px-3 py-1.5 text-sm font-medium text-[var(--t2t-on-accent,#04121f)]" href={i.payLink.url} target="_blank" rel="noopener noreferrer">Pay <Money value={i.open} currency={i.currency} /></a> : null}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : <p className="px-5 py-5 text-sm text-fg-muted">{show === 'open' ? 'Nothing to pay. Thank you.' : 'No invoices yet.'}</p>}
      </Card>

      <Card className="mt-6" role="region" aria-label="Payments received">
        <div className="px-5 pt-5">
          <h2 className="text-base font-semibold">Payments received</h2>
          <p className="text-sm text-fg-muted">Payments {p.from.tradeName} has recorded from you.</p>
        </div>
        {p.receipts.length ? (
          <Table aria-label="Payments">
            <thead><Tr><Th>Date</Th><Th>Receipt</Th><Th>Your reference</Th><Th numeric>Amount</Th></Tr></thead>
            <tbody>
              {p.receipts.map((r) => (
                <Tr key={r.id}>
                  <Td>{date(r.date)}</Td>
                  <Td className="num">{r.number}{r.status === 'VOID' ? <> <Badge tone="neutral">Cancelled</Badge></> : null}</Td>
                  <Td>{r.reference ?? '—'}</Td>
                  <Td numeric><Money value={r.amount} currency={r.currency} /></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : <p className="px-5 py-5 text-sm text-fg-muted">No payments recorded yet.</p>}
      </Card>

      <StatementCard base={base} today={p.today} />

      <footer className="mt-10 border-t border-line pt-4 text-xs text-fg-faint">
        <p>This page is private to {p.customer.name}. Anyone with the link can see it, so do not forward it.{p.link.expiresAt ? ` The link works until ${date(p.link.expiresAt.slice(0, 10))}.` : ''} If something looks wrong, contact {p.from.tradeName}.</p>
        <p className="mt-1">Customer portal by Talk2Tax.</p>
      </footer>
    </Shell>
  );
}

function BalanceCards({ b, multi }: { b: Portal['balances'][number]; multi: boolean }) {
  const label = (s: string) => (multi ? `${s} (${b.currency})` : s);
  return (
    <>
      <Card className="p-4"><p className="text-sm text-fg-muted">{label('Balance to pay')}</p><p className="mt-1 text-2xl font-semibold"><Money value={b.balance} currency={b.currency} /></p>{b.credits !== '0.00' ? <p className="text-xs text-fg-muted">after <Money value={b.credits} currency={b.currency} /> of credits and payments not yet matched</p> : null}</Card>
      <Card className="p-4"><p className="text-sm text-fg-muted">{label('Overdue')}</p><p className={`mt-1 text-2xl font-semibold ${Number(b.overdue) > 0 ? 'text-negative' : ''}`}><Money value={b.overdue} currency={b.currency} /></p></Card>
      <Card className="p-4"><p className="text-sm text-fg-muted">{label('Open invoices')}</p><p className="mt-1 text-2xl font-semibold"><Money value={b.owed} currency={b.currency} /></p></Card>
    </>
  );
}

function StatementCard({ base, today }: { base: string; today: string }) {
  const [from, setFrom] = useState(`${Number(today.slice(0, 4)) - 1}${today.slice(4, 8)}01`);
  const [to, setTo] = useState(today);
  const [currency, setCurrency] = useState('');
  const q = useQuery({ queryKey: ['portal-statement', base, from, to, currency], queryFn: () => get<Statement>(`${base}/statement?from=${from}&to=${to}${currency ? `&currency=${currency}` : ''}`), enabled: !!from && !!to, retry: false });
  const s = q.data;
  return (
    <Card className="mt-6" role="region" aria-label="Statement">
      <div className="flex flex-wrap items-end justify-between gap-3 px-5 pt-5">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Statement</h2>
          <p className="text-sm text-fg-muted">Every invoice, credit and payment in the period, with the running balance.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-44"><Input aria-label="Statement from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></div>
          <span className="text-sm text-fg-muted">to</span>
          <div className="w-44"><Input aria-label="Statement to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></div>
          {s && s.currencies.length > 1 ? (
            <Select aria-label="Currency" value={currency || s.currency} onChange={(e) => setCurrency(e.target.value)}>{s.currencies.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
          ) : null}
          <button type="button" className="text-sm text-accent hover:underline" onClick={() => window.print()}>Print</button>
        </div>
      </div>
      {q.error ? <p className="px-5 py-4 text-sm text-negative">{q.error.message}</p> : null}
      {s ? (
        <Table aria-label="Statement lines">
          <thead><Tr><Th>Date</Th><Th>Number</Th><Th>Details</Th><Th numeric>Charged</Th><Th numeric>Paid or credited</Th><Th numeric>Balance</Th></Tr></thead>
          <tbody>
            <Tr><Td className="text-fg-muted">{date(s.from)}</Td><Td /><Td className="text-fg-muted">Opening balance</Td><Td /><Td /><Td numeric><Money value={s.openingBalance} currency={s.currency} /></Td></Tr>
            {s.lines.map((l, n) => (
              <Tr key={`${l.kind}-${l.number}-${n}`}>
                <Td>{date(l.date)}</Td>
                <Td className="num">{l.id ? <a className="text-accent hover:underline" href={`${base}/documents/${l.id}`} target="_blank" rel="noopener noreferrer">{l.number}</a> : l.number}</Td>
                <Td>{l.description}</Td>
                <Td numeric>{l.charge ? <Money value={l.charge} currency={s.currency} /> : null}</Td>
                <Td numeric>{l.credit ? <Money value={l.credit} currency={s.currency} /> : null}</Td>
                <Td numeric><Money value={l.balance} currency={s.currency} /></Td>
              </Tr>
            ))}
          </tbody>
          <tfoot><tr><Td colSpan={5} className="text-right font-semibold">Balance on {date(s.to)}</Td><Td numeric className="font-semibold"><Money value={s.closingBalance} currency={s.currency} /></Td></tr></tfoot>
        </Table>
      ) : null}
    </Card>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return <main id="main" className="min-h-screen bg-bg px-4 py-8 text-fg sm:px-8"><div className="mx-auto max-w-5xl">{children}</div></main>;
}

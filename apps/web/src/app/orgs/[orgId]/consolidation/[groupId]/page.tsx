'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { D } from '@talk2tax/accounting-engine';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { BalancedBadge, DateInput, fyStartFor } from '@/components/report-bits';
import { ExportButtons } from '@/components/reports/export-buttons';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import type { ConsolidationReport, GroupDetail, Line, RowKind } from '@/lib/consolidation';
import { date, today } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

type Tab = 'worksheet' | 'income-statement' | 'balance-sheet' | 'setup';
const TABS: [Tab, string][] = [
  ['worksheet', 'Worksheet'],
  ['income-statement', 'Profit and loss'],
  ['balance-sheet', 'Balance sheet'],
  ['setup', 'Companies, rates and rules'],
];
const KIND_NOTE: Record<RowKind, string | null> = {
  ACCOUNT: null,
  EARNINGS_BROUGHT_FORWARD: 'Profit of earlier periods not yet closed to retained earnings',
  TRANSLATION_RESERVE: 'Exchange difference from translating foreign companies',
  INTERCOMPANY_DIFFERENCE: 'The two sides of an elimination rule do not agree',
};

export default function ConsolidationGroupPage() {
  const { org, orgId } = useOrg();
  const { groupId } = useParams<{ groupId: string }>();
  const [tab, setTab] = useState<Tab>('worksheet');
  const [to, setTo] = useState(today());
  const [from, setFrom] = useState(() => fyStartFor(today(), org?.fiscalYearStartMonth ?? 4));
  const base = `/v1/orgs/${orgId}/consolidation/groups/${groupId}`;
  const g = useQuery({ queryKey: ['consolidation-group', orgId, groupId], queryFn: () => api<GroupDetail>(base) });
  const r = useQuery({ queryKey: ['consolidation-report', orgId, groupId, from, to], queryFn: () => api<ConsolidationReport>(`${base}/report?from=${from}&to=${to}`), retry: false });
  if (!org) return null;
  const manage = can(org.role, 'org.manage');
  const c = g.data?.currency ?? org.functionalCurrency;
  return (
    <>
      <PageHeader
        title={g.data?.name ?? 'Group'}
        description={g.data ? `${g.data.members.length} compan${g.data.members.length === 1 ? 'y' : 'ies'} · statements in ${g.data.currency} · ${g.data.rules.filter((x) => x.isActive).length} elimination rule${g.data.rules.length === 1 ? '' : 's'}` : undefined}
        actions={
          <>
            <DateInput label="From" value={from} onChange={setFrom} />
            <DateInput label="To" value={to} onChange={setTo} />
            {r.data ? <BalancedBadge balanced={r.data.balanced && r.data.balanceSheet.balanced}>Balanced</BalancedBadge> : null}
            {tab !== 'setup' ? <ExportButtons orgId={orgId} path={`consolidation/groups/${groupId}/export/${tab}`} params={{ from, to }} disabled={!r.data} /> : null}
          </>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="View">
        {TABS.map(([id, label]) => (
          <Button key={id} role="tab" aria-selected={tab === id} size="sm" variant={tab === id ? 'primary' : 'ghost'} onClick={() => setTab(id)}>
            {label}
          </Button>
        ))}
        <Link href={`/orgs/${orgId}/consolidation`} className="ml-auto self-center text-sm text-accent hover:underline">All groups</Link>
      </div>
      <ErrorAlert title="Could not load the group" error={g.error} />
      {tab !== 'setup' && r.error ? (
        <div className="mb-4">
          <ErrorAlert title="The group cannot be consolidated yet" error={r.error} />
          {manage ? <Button className="mt-2" size="sm" variant="secondary" onClick={() => setTab('setup')}>Open companies, rates and rules</Button> : null}
        </div>
      ) : null}
      {r.data && tab === 'worksheet' ? <Worksheet r={r.data} /> : null}
      {r.data && tab === 'income-statement' ? <IncomeStatement r={r.data} /> : null}
      {r.data && tab === 'balance-sheet' ? <BalanceSheet r={r.data} /> : null}
      {g.data && tab === 'setup' ? <Setup g={g.data} orgId={orgId} base={base} manage={manage} periodEnd={to} currency={c} /> : null}
    </>
  );
}

function Worksheet({ r }: { r: ConsolidationReport }) {
  const c = r.currency;
  const total = (xs: string[]) => xs.reduce((a, x) => a.plus(x), new D(0)).toFixed(2);
  return (
    <>
      <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-4">
        <Stat label="Group revenue" value={<Money value={r.incomeStatement.totalRevenue} currency={c} />} />
        <Stat label="Group net profit" value={<Money value={r.incomeStatement.netIncome} currency={c} signed />} tone="violet" />
        <Stat label="Group total assets" value={<Money value={r.balanceSheet.totalAssets} currency={c} />} />
        <Stat label="Eliminations" value={`${r.eliminations.filter((e) => e.matched).length} of ${r.eliminations.length} agree`} tone={r.eliminations.every((e) => e.matched) ? 'positive' : 'warning'} />
      </div>
      <Card className="mb-4 overflow-x-auto">
        <CardHeader title="Consolidation worksheet" description="Signed balances: debits positive, credits negative. Balance sheet accounts at the end date, revenue and expenses for the period. Each column adds up to zero." />
        <Table aria-label="Consolidation worksheet">
          <thead>
            <tr>
              <Th>Account</Th>
              {r.entities.map((e) => <Th key={e.id} numeric>{e.name}{e.currency !== c ? <span className="block text-[10px] font-normal normal-case text-fg-faint">{e.currency} → {c}</span> : null}</Th>)}
              <Th numeric>Eliminations</Th>
              <Th numeric>Consolidated</Th>
            </tr>
          </thead>
          <tbody>
            {r.rows.map((row) => (
              <Tr key={`${row.kind}-${row.code}`}>
                <Td className="whitespace-nowrap">
                  {row.code ? <span className="num text-fg-muted">{row.code}</span> : null} {row.name}
                  {KIND_NOTE[row.kind] ? <span className="block text-xs text-fg-faint">{KIND_NOTE[row.kind]}</span> : null}
                </Td>
                {row.amounts.map((a, i) => <Td key={i} numeric className="whitespace-nowrap">{Number(a) === 0 ? <span className="text-fg-faint">—</span> : <Money value={a} currency={c} signed />}</Td>)}
                <Td numeric className="whitespace-nowrap">{Number(row.elimination) === 0 ? <span className="text-fg-faint">—</span> : <Money value={row.elimination} currency={c} signed />}</Td>
                <Td numeric className="whitespace-nowrap font-medium">{Number(row.consolidated) === 0 ? <span className="text-fg-faint">—</span> : <Money value={row.consolidated} currency={c} signed />}</Td>
              </Tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <Td className="font-semibold">Total</Td>
              {r.entities.map((e, i) => <Td key={e.id} numeric className="font-semibold">{total(r.rows.map((x) => x.amounts[i]!))}</Td>)}
              <Td numeric className="font-semibold">{total(r.rows.map((x) => x.elimination))}</Td>
              <Td numeric className="font-semibold">{total(r.rows.map((x) => x.consolidated))}</Td>
            </tr>
          </tfoot>
        </Table>
      </Card>
      <Card className="mb-4 p-4">
        <CardHeader title="Eliminations" description="Each rule removes both balances. When they do not cancel, the difference stays in Intercompany differences until the books are corrected." />
        {!r.eliminations.length ? <EmptyState title="No elimination rules">Add rules under Companies, rates and rules to remove balances between group companies.</EmptyState> : null}
        <ul className="space-y-2" aria-label="Eliminations">
          {r.eliminations.map((e) => {
            const name = (id: string) => r.entities.find((x) => x.id === id)?.name ?? 'Removed company';
            return (
              <li key={e.ruleId} className="rounded-md border border-line p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-fg">{e.name}</span>
                  {e.matched ? <Badge tone="positive">Agrees</Badge> : <Badge tone="warning">{e.problem ? 'Not applied' : 'Difference'}</Badge>}
                </div>
                <div className="mt-1 text-fg-muted">
                  {name(e.left.entityId)} {e.left.code} {e.left.name ?? ''} <Money value={e.left.amount} currency={r.currency} signed /> · {name(e.right.entityId)} {e.right.code} {e.right.name ?? ''} <Money value={e.right.amount} currency={r.currency} signed />
                </div>
                {e.problem ? <div className="mt-1 text-negative">{e.problem}</div> : !e.matched ? <div className="mt-1 text-negative">Difference <Money value={e.difference} currency={r.currency} signed /></div> : null}
              </li>
            );
          })}
        </ul>
      </Card>
      {r.entities.some((e) => e.ownershipPercent !== '100') ? (
        <Card className="p-4">
          <CardHeader title="Non-controlling interests" description="Partly owned companies are consolidated in full; the outside shareholders' share of their net assets and profit is shown within equity." />
          <ul className="space-y-1 text-sm text-fg-muted" aria-label="Non-controlling interests">
            {r.entities.filter((e) => e.ownershipPercent !== '100').map((e) => (
              <li key={e.id}>
                {e.name}: {e.ownershipPercent}% owned; outside shareholders hold <Money value={e.nonControllingNetAssets} currency={r.currency} signed /> of net assets <Money value={e.netAssets} currency={r.currency} signed /> and <Money value={e.nonControllingProfit} currency={r.currency} signed /> of the profit
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {r.entities.some((e) => e.rates) ? (
        <Card className="p-4">
          <CardHeader title="Translation" description="Assets and liabilities at the closing rate, revenue and expenses at the average rate, equity at the historical rate." />
          <ul className="space-y-1 text-sm text-fg-muted">
            {r.entities.filter((e) => e.rates).map((e) => (
              <li key={e.id}>{e.name}: {e.currency} closing {e.rates!.closing}, average {e.rates!.average}, historical {e.rates!.historical}; translation reserve <Money value={e.translationReserve} currency={r.currency} signed /></li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}

function StatementTable({ label, sections, footer, after = [], c }: { label: string; sections: { title: string; lines: Line[]; total?: [string, string] }[]; footer: [string, string][]; after?: [string, string][]; c: string }) {
  return (
    <Card className="max-w-3xl">
      <Table aria-label={label}>
        <tbody>
          {sections.map((s) => [
            <tr key={`${s.title}-h`}><Td colSpan={2} className="bg-surface-raised/60 text-xs font-semibold uppercase tracking-wide text-fg-muted">{s.title}</Td></tr>,
            ...s.lines.map((l) => (
              <Tr key={`${s.title}-${l.kind}-${l.code}`}>
                <Td>{l.code ? <span className="num text-fg-muted">{l.code}</span> : null} {l.name}</Td>
                <Td numeric><Money value={l.amount} currency={c} signed /></Td>
              </Tr>
            )),
            s.total ? <tr key={`${s.title}-t`}><Td className="font-semibold">{s.total[0]}</Td><Td numeric className="font-semibold"><Money value={s.total[1]} currency={c} signed /></Td></tr> : null,
          ])}
        </tbody>
        <tfoot>
          {footer.map(([k, v]) => <tr key={k}><Td className="text-base font-semibold">{k}</Td><Td numeric className="text-base font-semibold"><Money value={v} currency={c} signed /></Td></tr>)}
          {after.map(([k, v]) => <tr key={k}><Td className="pl-6 text-fg-muted">{k}</Td><Td numeric className="text-fg-muted"><Money value={v} currency={c} signed /></Td></tr>)}
        </tfoot>
      </Table>
    </Card>
  );
}

function IncomeStatement({ r }: { r: ConsolidationReport }) {
  const is = r.incomeStatement;
  return (
    <StatementTable
      label="Consolidated profit and loss"
      c={r.currency}
      sections={[
        { title: 'Revenue', lines: is.revenue, total: ['Total revenue', is.totalRevenue] },
        { title: 'Expenses', lines: is.expenses, total: ['Total expenses', is.totalExpenses] },
      ]}
      footer={[[Number(is.netIncome) < 0 ? 'Group net loss' : 'Group net profit', is.netIncome]]}
      after={
        r.entities.some((e) => e.ownershipPercent !== '100')
          ? [
              ['Attributable to owners of the parent', is.attributableToOwners],
              ['Attributable to non-controlling interests', is.attributableToNonControlling],
            ]
          : []
      }
    />
  );
}

function BalanceSheet({ r }: { r: ConsolidationReport }) {
  const bs = r.balanceSheet;
  const liabEq = new D(bs.totalLiabilities).plus(bs.totalEquity).toFixed(2);
  const nci = r.entities.some((e) => e.ownershipPercent !== '100');
  const profit: Line = { code: '', name: 'Profit for the period', kind: 'ACCOUNT', amount: bs.periodEarnings };
  return (
    <StatementTable
      label="Consolidated balance sheet"
      c={r.currency}
      sections={[
        { title: 'Assets', lines: bs.assets, total: ['Total assets', bs.totalAssets] },
        { title: 'Liabilities', lines: bs.liabilities, total: ['Total liabilities', bs.totalLiabilities] },
        ...(nci
          ? [
              { title: 'Equity', lines: [...bs.equity, profit], total: ['Equity attributable to owners of the parent', bs.equityAttributableToOwners] as [string, string] },
              { title: 'Non-controlling interests', lines: [{ code: '', name: 'Non-controlling interests', kind: 'ACCOUNT' as const, amount: bs.nonControllingInterests }], total: ['Total equity', bs.totalEquity] as [string, string] },
            ]
          : [{ title: 'Equity', lines: [...bs.equity, profit], total: ['Total equity', bs.totalEquity] as [string, string] }]),
      ]}
      footer={[['Total liabilities and equity', liabEq]]}
    />
  );
}

function Setup({ g, orgId, base, manage, periodEnd, currency }: { g: GroupDetail; orgId: string; base: string; manage: boolean; periodEnd: string; currency: string }) {
  const qc = useQueryClient();
  const done = (d: GroupDetail) => {
    qc.setQueryData(['consolidation-group', orgId, g.id], d);
    void qc.invalidateQueries({ queryKey: ['consolidation-report', orgId, g.id] });
    void qc.invalidateQueries({ queryKey: ['consolidation-groups', orgId] });
  };
  const call = useMutation({ mutationFn: ({ path, method, body }: { path: string; method: string; body?: Record<string, unknown> }) => api<GroupDetail>(`${base}${path}`, { method, body }), onSuccess: done });
  const [member, setMember] = useState('');
  const foreign = g.members.filter((m) => m.currency && m.currency !== currency);
  const [rate, setRate] = useState({ memberOrgId: '', periodEnd, closing: '', average: '', historical: '' });
  const [rule, setRule] = useState({ name: '', leftOrg: '', leftCode: '', rightOrg: '', rightCode: '' });

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <ErrorAlert title="That did not work" error={call.error} />
      <Card className="p-4 xl:col-span-2">
        <CardHeader title="Companies in the group" description="You can add the companies you own or administer. Reading the consolidation needs report access in every one of them." />
        <Table aria-label="Companies in the group">
          <thead><tr><Th>Company</Th><Th>Currency</Th><Th>Group's share</Th><Th>Your role there</Th><Th>Added</Th><Th /></tr></thead>
          <tbody>
            {g.members.map((m) => (
              <Tr key={m.orgId}>
                <Td>{m.name ?? 'An organisation you are not a member of'} {m.isParent ? <Badge tone="accent">Parent</Badge> : null}</Td>
                <Td>{m.currency ?? '—'}</Td>
                <Td>{manage && !m.isParent ? <OwnershipEditor key={m.ownershipPercent} name={m.name ?? ''} value={m.ownershipPercent} pending={call.isPending} onSave={(v) => call.mutate({ path: `/members/${m.orgId}`, method: 'PUT', body: { ownershipPercent: v } })} /> : `${m.ownershipPercent}%`}</Td>
                <Td>{m.yourRole ?? '—'}{m.canReadReports ? null : <span className="ml-1 text-xs text-negative">no report access</span>}</Td>
                <Td>{date(m.addedAt.slice(0, 10))}</Td>
                <Td>{manage && !m.isParent ? <Button size="sm" variant="ghost" aria-label={`Remove ${m.name}`} disabled={call.isPending} onClick={() => confirm(`Remove ${m.name} from the group?`) && call.mutate({ path: `/members/${m.orgId}`, method: 'DELETE' })}>Remove</Button> : null}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
        {manage ? (
          <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); call.mutate({ path: '/members', method: 'POST', body: { orgId: member } }); setMember(''); }}>
            <Field label="Add a company">
              {(p) => (
                <Select {...p} value={member} onChange={(e) => setMember(e.target.value)} className="w-72">
                  <option value="">{g.candidates.length ? 'Choose a company…' : 'No other companies you own or administer'}</option>
                  {g.candidates.map((x) => <option key={x.orgId} value={x.orgId}>{x.name} ({x.currency})</option>)}
                </Select>
              )}
            </Field>
            <Button type="submit" disabled={!member} loading={call.isPending}>Add to group</Button>
          </form>
        ) : null}
      </Card>

      <Card className="p-4">
        <CardHeader title="Translation rates" description={`For companies keeping their books in another currency: ${currency} per one unit of theirs, for each period end you report on.`} />
        {!foreign.length ? <p className="text-sm text-fg-muted">Every company keeps its books in {currency}; no rates are needed.</p> : null}
        {g.rates.length ? (
          <Table aria-label="Translation rates">
            <thead><tr><Th>Company</Th><Th>Period end</Th><Th numeric>Closing</Th><Th numeric>Average</Th><Th numeric>Historical</Th><Th /></tr></thead>
            <tbody>
              {g.rates.map((x) => (
                <Tr key={x.id}>
                  <Td>{x.memberName}</Td><Td>{date(x.periodEnd)}</Td><Td numeric>{x.closing}</Td><Td numeric>{x.average}</Td><Td numeric>{x.historical}</Td>
                  <Td>{manage ? <Button size="sm" variant="ghost" aria-label={`Delete rates for ${x.memberName} ${x.periodEnd}`} onClick={() => call.mutate({ path: `/rates/${x.id}`, method: 'DELETE' })}>Delete</Button> : null}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : null}
        {manage && foreign.length ? (
          <form className="mt-3 grid grid-cols-2 gap-3" onSubmit={(e) => { e.preventDefault(); call.mutate({ path: '/rates', method: 'PUT', body: { ...rate, memberOrgId: rate.memberOrgId || foreign[0]!.orgId } }); }}>
            <Field label="Company">{(p) => <Select {...p} value={rate.memberOrgId || foreign[0]!.orgId} onChange={(e) => setRate({ ...rate, memberOrgId: e.target.value })}>{foreign.map((m) => <option key={m.orgId} value={m.orgId}>{m.name} ({m.currency})</option>)}</Select>}</Field>
            <Field label="Period end">{(p) => <Input {...p} type="date" value={rate.periodEnd} onChange={(e) => setRate({ ...rate, periodEnd: e.target.value })} required />}</Field>
            <Field label="Closing rate">{(p) => <Input {...p} inputMode="decimal" value={rate.closing} onChange={(e) => setRate({ ...rate, closing: e.target.value.trim() })} placeholder="83.25" required />}</Field>
            <Field label="Average rate">{(p) => <Input {...p} inputMode="decimal" value={rate.average} onChange={(e) => setRate({ ...rate, average: e.target.value.trim() })} placeholder="82.90" required />}</Field>
            <Field label="Historical rate" hint="For share capital and earlier profits">{(p) => <Input {...p} inputMode="decimal" value={rate.historical} onChange={(e) => setRate({ ...rate, historical: e.target.value.trim() })} placeholder="75.00" required />}</Field>
            <div className="self-end"><Button type="submit" loading={call.isPending}>Save rates</Button></div>
          </form>
        ) : null}
      </Card>

      <Card className="p-4">
        <CardHeader title="Elimination rules" description="Pair one company's account with another's, such as a receivable from a group company with the matching payable, or intercompany sales with purchases. Both balances are removed." />
        {!g.rules.length ? <p className="text-sm text-fg-muted">No rules yet.</p> : null}
        <ul className="space-y-2" aria-label="Elimination rules">
          {g.rules.map((x) => (
            <li key={x.id} className="rounded-md border border-line p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-fg">{x.name}</span>
                {!x.isActive ? <Badge>Off</Badge> : null}
              </div>
              <div className="text-fg-muted">{x.left.name} {x.left.code} ↔ {x.right.name} {x.right.code}</div>
              {manage ? (
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => call.mutate({ path: `/rules/${x.id}`, method: 'PUT', body: { name: x.name, left: { orgId: x.left.orgId, code: x.left.code }, right: { orgId: x.right.orgId, code: x.right.code }, isActive: !x.isActive } })}>{x.isActive ? 'Turn off' : 'Turn on'}</Button>
                  <Button size="sm" variant="ghost" aria-label={`Delete rule ${x.name}`} onClick={() => confirm(`Delete the rule ${x.name}?`) && call.mutate({ path: `/rules/${x.id}`, method: 'DELETE' })}>Delete</Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {manage ? (
          <form
            className="mt-3 grid grid-cols-2 gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              call.mutate(
                { path: '/rules', method: 'POST', body: { name: rule.name, left: { orgId: rule.leftOrg, code: rule.leftCode }, right: { orgId: rule.rightOrg, code: rule.rightCode } } },
                { onSuccess: () => setRule({ name: '', leftOrg: '', leftCode: '', rightOrg: '', rightCode: '' }) },
              );
            }}
          >
            <div className="col-span-2"><Field label="Rule name">{(p) => <Input {...p} value={rule.name} onChange={(e) => setRule({ ...rule, name: e.target.value })} placeholder="Current accounts with Sub" required maxLength={120} />}</Field></div>
            <SidePicker label="First" members={g.members} org={rule.leftOrg} code={rule.leftCode} onChange={(o, c) => setRule({ ...rule, leftOrg: o, leftCode: c })} />
            <SidePicker label="Second" members={g.members} org={rule.rightOrg} code={rule.rightCode} onChange={(o, c) => setRule({ ...rule, rightOrg: o, rightCode: c })} />
            <div className="col-span-2"><Button type="submit" disabled={!rule.leftCode || !rule.rightCode} loading={call.isPending}>Add rule</Button></div>
          </form>
        ) : null}
        {g.rules.some((x) => x.left.orgId === x.right.orgId) ? <Alert tone="warning" title="A rule pairs two accounts in the same company">That is allowed, but eliminations are usually between two companies.</Alert> : null}
      </Card>
    </div>
  );
}

/** A company and one of its accounts, read from that company's own chart of accounts. */
function OwnershipEditor({ name, value, pending, onSave }: { name: string; value: string; pending: boolean; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  return (
    <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); onSave(v.trim()); }}>
      <Input aria-label={`Group's share of ${name} (%)`} value={v} onChange={(e) => setV(e.target.value)} inputMode="decimal" className="w-24 text-right" />
      <span className="text-sm text-fg-muted">%</span>
      {v.trim() !== value ? <Button type="submit" size="sm" variant="secondary" loading={pending}>Save</Button> : null}
    </form>
  );
}

function SidePicker({ label, members, org, code, onChange }: { label: string; members: GroupDetail['members']; org: string; code: string; onChange: (org: string, code: string) => void }) {
  const accounts = useQuery({
    queryKey: ['accounts', org],
    enabled: !!org,
    queryFn: () => api<{ code: string; name: string; isPostable: boolean }[] | { items: { code: string; name: string; isPostable: boolean }[] }>(`/v1/orgs/${org}/accounts`),
  });
  const list = accounts.data ? (Array.isArray(accounts.data) ? accounts.data : accounts.data.items) : [];
  return (
    <div className="space-y-2">
      <Field label={`${label} company`}>
        {(p) => (
          <Select {...p} value={org} onChange={(e) => onChange(e.target.value, '')}>
            <option value="">Choose…</option>
            {members.filter((m) => m.name).map((m) => <option key={m.orgId} value={m.orgId}>{m.name}</option>)}
          </Select>
        )}
      </Field>
      <Field label={`${label} account`}>
        {(p) => (
          <Select {...p} value={code} disabled={!org} onChange={(e) => onChange(org, e.target.value)}>
            <option value="">{org ? 'Choose an account…' : 'Choose the company first'}</option>
            {list.filter((a) => a.isPostable).map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
          </Select>
        )}
      </Field>
    </div>
  );
}

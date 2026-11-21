'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { useOrg } from '@/lib/org';

type Kind = 'accounts' | 'customers' | 'vendors' | 'opening-balances';
type Column = { key: string; label: string; required: boolean; hint: string };
type Overview = { currency: string; kinds: { kind: Kind; title: string; what: string; allowed: boolean; columns: Column[]; template: string }[] };
type Issue = { row: number; column: string | null; message: string };
type Row = { row: number; action: 'CREATE' | 'SKIP'; reason: string | null; values: Record<string, string | number | boolean | null> };
type Plan = {
  kind: Kind;
  columns: { key: string; label: string; heading: string }[];
  ignored: string[];
  rows: Row[];
  issues: Issue[];
  summary: { rows: number; create: number; skip: number; problems: number };
  totals?: { debit: string; credit: string; difference: string };
};
type Result = { kind: Kind; created: number; skipped: number; failed: { row: number; message: string }[]; journalId?: string };

/** What each kind shows in the preview, as column key and heading. */
const SHOWN: Record<Kind, [string, string][]> = {
  accounts: [['code', 'Code'], ['name', 'Name'], ['type', 'Type'], ['subtype', 'Subtype'], ['parentCode', 'Parent']],
  customers: [['name', 'Name'], ['email', 'Email'], ['gstin', 'GSTIN'], ['paymentTermsDays', 'Terms'], ['creditLimit', 'Credit limit']],
  vendors: [['name', 'Name'], ['email', 'Email'], ['gstin', 'GSTIN'], ['pan', 'PAN'], ['paymentTermsDays', 'Terms']],
  'opening-balances': [['code', 'Code'], ['name', 'Account'], ['debit', 'Debit'], ['credit', 'Credit']],
};
const LINKS: Record<Kind, [string, string]> = {
  accounts: ['/accounts', 'Open the chart of accounts'],
  customers: ['/sales/customers', 'Open customers'],
  vendors: ['/purchases/vendors', 'Open vendors'],
  'opening-balances': ['/opening-balances', 'Open opening balances'],
};

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Import data from a spreadsheet saved as CSV (UX-009 to UX-012). */
export default function ImportPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/imports`;
  const q = useQuery({ queryKey: ['imports', orgId], queryFn: () => api<Overview>(base) });
  const [kind, setKind] = useState<Kind>('accounts');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [date, setDate] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const preview = useMutation({ mutationFn: () => api<Plan>(`${base}/${kind}/preview`, { method: 'POST', body: { csv } }), onSuccess: (p) => { setPlan(p); setResult(null); } });
  const run = useMutation({
    mutationFn: () => api<Result & { plan: Plan }>(`${base}/${kind}`, { method: 'POST', body: { csv, ...(kind === 'opening-balances' ? { date } : {}) } }),
    onSuccess: (r) => {
      setResult(r);
      setPlan(null);
      void qc.invalidateQueries();
    },
  });
  if (!org) return null;
  const o = q.data;
  const current = o?.kinds.find((k) => k.kind === kind);
  const choose = (k: Kind) => {
    setKind(k);
    setPlan(null);
    setResult(null);
    setCsv('');
    setFileName(null);
  };
  const problemsByRow = new Map<number, Issue[]>();
  for (const i of plan?.issues ?? []) problemsByRow.set(i.row, [...(problemsByRow.get(i.row) ?? []), i]);
  const fileProblems = (plan?.issues ?? []).filter((i) => i.row <= 1);
  const ready = !!plan && plan.issues.length === 0 && plan.summary.create > 0 && (kind !== 'opening-balances' || !!date);

  return (
    <>
      <PageHeader
        title="Import data"
        description="Bring your chart of accounts, customers, vendors and opening balances from another system or a spreadsheet. Save the sheet as CSV, check the preview, then import. Nothing is written until you press Import, and a file with any problem is refused whole."
      />
      <ErrorAlert title="Could not load imports" error={q.error} />
      {o ? (
        <>
          <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="What to import">
            {o.kinds.map((k) => (
              <Button key={k.kind} variant={k.kind === kind ? 'primary' : 'secondary'} aria-pressed={k.kind === kind} onClick={() => choose(k.kind)}>
                {k.title}
              </Button>
            ))}
          </div>
          {current ? (
            <Card className="mb-4">
              <CardHeader
                title="Import file"
                description={current.what}
                actions={<Button variant="secondary" size="sm" onClick={() => download(`talk2tax-${kind}-template.csv`, current.template)}>Download template</Button>}
              />
              {!current.allowed ? <div className="px-5 pt-4"><Alert tone="warning" title="Your role cannot import this">Ask an owner or admin, or someone who can manage {current.title.toLowerCase()}.</Alert></div> : null}
              <div className="grid gap-4 px-5 py-4 md:grid-cols-2">
                <div>
                  <Field label="CSV file" hint="Comma, semicolon or tab separated; the first row holds the headings. Up to 2,000 rows.">
                    {(p) => (
                      <Input
                        {...p}
                        type="file"
                        accept=".csv,text/csv,text/plain"
                        onChange={async (e) => {
                          const f = e.target.files?.[0];
                          if (!f) return;
                          setCsv(await f.text());
                          setFileName(f.name);
                          setPlan(null);
                          setResult(null);
                        }}
                      />
                    )}
                  </Field>
                  <Field label="Or paste the rows" hint={fileName ? `Read from ${fileName}.` : undefined}>
                    {(p) => <Textarea {...p} rows={6} className="font-mono text-xs" value={csv} onChange={(e) => { setCsv(e.target.value); setPlan(null); setResult(null); }} />}
                  </Field>
                  {kind === 'opening-balances' ? (
                    <Field label="Opening balance date" hint="Usually the day before your first transaction in Talk2Tax.">
                      {(p) => <Input {...p} type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-48" />}
                    </Field>
                  ) : null}
                  <div className="mt-3 flex gap-2">
                    <Button variant="secondary" disabled={!csv.trim() || !current.allowed} loading={preview.isPending} onClick={() => preview.mutate()}>Preview</Button>
                    <Button disabled={!ready || !current.allowed} loading={run.isPending} onClick={() => run.mutate()}>
                      {plan ? `Import ${plan.summary.create} ${plan.summary.create === 1 ? 'row' : 'rows'}` : 'Import'}
                    </Button>
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-sm font-medium">Columns</p>
                  <Table aria-label="Columns read from the file">
                    <thead><tr><Th>Column</Th><Th>Needed</Th><Th>Notes</Th></tr></thead>
                    <tbody>
                      {current.columns.map((c) => (
                        <Tr key={c.key}>
                          <Td className="whitespace-nowrap">{c.label}</Td>
                          <Td>{c.required ? <Badge tone="accent">Required</Badge> : <span className="text-fg-muted">Optional</span>}</Td>
                          <Td className="text-xs text-fg-muted">{c.hint}</Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              </div>
            </Card>
          ) : null}
          <ErrorAlert title="Could not read the file" error={preview.error} />
          <ErrorAlert title="The import did not run" error={run.error} />
          {result ? (
            <Alert tone={result.failed.length ? 'warning' : 'positive'} title={`Imported ${result.created} ${result.created === 1 ? 'row' : 'rows'}${result.skipped ? `, skipped ${result.skipped} already there` : ''}`}>
              {result.failed.length ? (
                <ul className="list-disc pl-5">{result.failed.map((f) => <li key={f.row}>Row {f.row}: {f.message}</li>)}</ul>
              ) : null}
              <Link className="text-accent hover:underline" href={`/orgs/${orgId}${LINKS[result.kind][0]}`}>{LINKS[result.kind][1]}</Link>
            </Alert>
          ) : null}
          {plan ? (
            <Card className="mt-4">
              <CardHeader
                title="Import preview"
                description={`${plan.summary.rows} rows read: ${plan.summary.create} to create, ${plan.summary.skip} skipped, ${plan.summary.problems} ${plan.summary.problems === 1 ? 'problem' : 'problems'}.${plan.ignored.length ? ` Columns left out: ${plan.ignored.join(', ')}.` : ''}`}
              />
              {fileProblems.length ? (
                <div className="px-5 pt-4"><Alert title="Fix the file first">
                  <ul className="list-disc pl-5">{fileProblems.map((i, n) => <li key={n}>{i.message}</li>)}</ul>
                </Alert></div>
              ) : null}
              {plan.totals ? (
                <p className="px-5 py-3 text-sm">
                  Debits {money(plan.totals.debit, o.currency)} · Credits {money(plan.totals.credit, o.currency)}
                  {/^-?0(\.0+)?$/.test(plan.totals.difference) ? null : (
                    <span className="text-fg-muted"> · A difference of {money(plan.totals.difference.replace(/^-/, ''), o.currency)} goes to Opening Balance Equity until you agree it.</span>
                  )}
                </p>
              ) : null}
              {!plan.rows.length && !fileProblems.length ? <EmptyState title="No rows">The file has headings but no rows below them.</EmptyState> : (
                <Table aria-label="Import preview">
                  <thead>
                    <tr>
                      <Th>Row</Th>
                      <Th>Result</Th>
                      {SHOWN[kind].map(([, h]) => <Th key={h}>{h}</Th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {[...plan.rows, ...[...problemsByRow.keys()].filter((r) => r > 1 && !plan.rows.some((x) => x.row === r)).map((r): Row => ({ row: r, action: 'SKIP', reason: null, values: {} }))]
                      .sort((a, b) => a.row - b.row)
                      .map((r) => {
                        const problems = problemsByRow.get(r.row) ?? [];
                        return (
                          <Tr key={r.row}>
                            <Td>{r.row}</Td>
                            <Td>
                              {problems.length ? (
                                <>
                                  <Badge tone="negative">Fix</Badge>
                                  {problems.map((i, n) => <span key={n} className="block text-xs text-negative">{i.column ? `${i.column}: ` : ''}{i.message}</span>)}
                                </>
                              ) : r.action === 'CREATE' ? <Badge tone="positive">Create</Badge> : (
                                <>
                                  <Badge tone="neutral">Skip</Badge>
                                  {r.reason ? <span className="block text-xs text-fg-muted">{r.reason}</span> : null}
                                </>
                              )}
                            </Td>
                            {SHOWN[kind].map(([k]) => <Td key={k} className="text-sm">{r.values[k] === null || r.values[k] === undefined || r.values[k] === '' ? '—' : String(r.values[k])}</Td>)}
                          </Tr>
                        );
                      })}
                  </tbody>
                </Table>
              )}
            </Card>
          ) : null}
        </>
      ) : null}
    </>
  );
}

'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { FindingCard, HealthCard, Recommendations } from '@/components/cfo/finding';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { GRADE, KIND, type CfoAnswer, type CfoAssessment, type CfoQuestion, type CfoReport, type CfoReportKind, type CfoReportRow } from '@/lib/cfo';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { monthLabel } from '@/lib/twin';
import { can } from '@/lib/types';

export default function CfoPage() {
  return (
    <Suspense>
      <Cfo />
    </Suspense>
  );
}

/**
 * The virtual CFO: financial health, the analyses behind it and what to do, answers to common
 * finance questions, and board packs and investor updates. Everything is worked out from the
 * posted books when the page is opened.
 */
function Cfo() {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const [question, setQuestion] = useState<string | null>(params.get('q'));
  const a = useQuery({ queryKey: ['cfo', orgId], queryFn: () => api<CfoAssessment & { questions: CfoQuestion[] }>(`/v1/orgs/${orgId}/cfo/assessment`) });
  const answer = useQuery({ queryKey: ['cfo-answer', orgId, question], enabled: !!question, queryFn: () => api<CfoAnswer>(`/v1/orgs/${orgId}/cfo/questions/${question}`) });
  const reports = useQuery({ queryKey: ['cfo-reports', orgId], queryFn: () => api<CfoReportRow[]>(`/v1/orgs/${orgId}/cfo/reports`) });
  const create = useMutation({
    mutationFn: (kind: CfoReportKind) => api<CfoReport>(`/v1/orgs/${orgId}/cfo/reports`, { method: 'POST', body: { kind } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['cfo-reports', orgId] });
      router.push(`/orgs/${orgId}/cfo/reports/${r.id}`);
    },
  });
  if (!org) return null;
  const d = a.data;
  const c = d?.currency ?? org.functionalCurrency;
  const prepare = can(org.role, 'cfo.reports');
  const exists = create.error instanceof ApiError && create.error.code === 'REPORT_EXISTS';
  const ask = (k: string) => {
    setQuestion(k);
    router.replace(`/orgs/${orgId}/cfo?q=${k}`, { scroll: false });
  };
  return (
    <>
      <PageHeader title="Virtual CFO" description="Financial health, analysis and recommendations worked out from your posted books. Every figure shows where it came from, how it was calculated and how sure it is." />
      <ErrorAlert title="Could not work out the assessment" error={a.error ?? reports.error} />
      {d ? (
        <div className="space-y-4">
          <HealthCard health={d.health} headline={d.headline} />
          <p className="text-xs text-fg-muted">Figures to {date(d.asOf)} (last complete month {monthLabel(d.lastMonth)}), with today's balances, forecast and open items.</p>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <Card className="p-4">
              <CardHeader title="What to do next" description="From the areas that need action or watching, most urgent first. Nothing is done automatically; each says who has to approve it." />
              <Recommendations items={d.recommendations} orgId={orgId} />
            </Card>
            <Card className="p-4">
              <CardHeader title="Ask the CFO" description="Worked answers from the books, each with its records, method, assumptions and confidence." />
              <div className="flex flex-wrap gap-2" role="group" aria-label="Questions">
                {d.questions.map((q) => (
                  <Button key={q.key} size="sm" variant={question === q.key ? 'primary' : 'secondary'} disabled={!q.allowed} title={q.allowed ? undefined : 'Needs access to customer or vendor records'} onClick={() => ask(q.key)}>
                    {q.question}
                  </Button>
                ))}
              </div>
              <p className="mt-3 text-xs text-fg-muted">
                Something else? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/copilot`}>Ask the copilot</Link>; it can use these answers too.
              </p>
            </Card>
          </div>

          {question ? (
            <section aria-label="Answer">
              <ErrorAlert title="Could not answer" error={answer.error} />
              {answer.isLoading ? <Card className="p-4 text-sm text-fg-muted">Working it out from the books…</Card> : null}
              {answer.data ? <FindingCard f={answer.data} currency={c} orgId={orgId} heading={answer.data.question} open /> : null}
            </section>
          ) : null}

          <section aria-label="Analysis" className="space-y-3">
            <h2 className="text-sm font-semibold text-fg">Analysis</h2>
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              {d.findings.map((f) => <FindingCard key={f.key} f={f} currency={c} orgId={orgId} />)}
            </div>
          </section>

          <Card className="p-4">
            <CardHeader
              title="Board packs and investor updates"
              description="A pack keeps the assessment as it stood when it was made, with your commentary and an optional AI summary. Finalise it to keep it as a record."
              actions={
                prepare ? (
                  <div className="flex flex-wrap gap-2">
                    {(Object.keys(KIND) as CfoReportKind[]).map((k) => (
                      <Button key={k} size="sm" variant="secondary" loading={create.isPending && create.variables === k} onClick={() => create.mutate(k)}>
                        Prepare {KIND[k].label.toLowerCase()}
                      </Button>
                    ))}
                  </div>
                ) : null
              }
            />
            {exists ? <Alert tone="warning" title="Already prepared">{create.error?.message}</Alert> : <ErrorAlert title="Could not prepare the pack" error={create.error} />}
            {reports.data?.length ? (
              <Table aria-label="Packs">
                <thead>
                  <tr><Th>Pack</Th><Th>Month</Th><Th>Health</Th><Th>Status</Th><Th>Prepared by</Th></tr>
                </thead>
                <tbody>
                  {reports.data.map((r) => (
                    <Tr key={r.id}>
                      <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/cfo/reports/${r.id}`}>{r.title}</Link></Td>
                      <Td>{monthLabel(r.month)}</Td>
                      <Td><span className="num">{r.score}</span> <Badge tone={GRADE[r.grade].tone}>{GRADE[r.grade].label}</Badge></Td>
                      <Td>{r.status === 'FINAL' ? <Badge tone="positive">Final</Badge> : <Badge>Draft</Badge>}</Td>
                      <Td>{r.createdBy}{r.finalisedBy ? <span className="text-fg-muted"> · finalised by {r.finalisedBy}</span> : null}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p className="text-sm text-fg-muted">No packs yet.</p>
            )}
          </Card>
          <Alert tone="violet" title="Read-only advice">The virtual CFO reads the books and never posts, pays, borrows or changes anything. Confirm tax and legal positions with your chartered accountant.</Alert>
        </div>
      ) : a.isLoading ? (
        <Card className="p-6 text-sm text-fg-muted">Working out the assessment from the books…</Card>
      ) : null}
    </>
  );
}

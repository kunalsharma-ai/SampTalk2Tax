'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { Money } from '@/components/money';
import { date, dateTime } from '@/lib/format';

/**
 * The external auditor portal (AUDIT-002): what an external auditor sees when they open the
 * private link an organisation sent them. No sign-in: the secret in the link is the check. One
 * internal audit engagement, read-only: scope, work and sign-offs, accepted evidence (files can
 * be opened), findings, samples and the trial balance at the end of the scope.
 */
interface Portal {
  organisation: { name: string; legalName: string | null };
  auditor: { name: string; firm: string | null };
  link: { expiresAt: string };
  engagement: {
    reference: string;
    name: string;
    objective: string;
    scopeFrom: string;
    scopeTo: string;
    status: 'PLANNING' | 'FIELDWORK' | 'REVIEW' | 'CLOSED';
    lead: string | null;
    reviewer: string | null;
    progress: { steps: number; done: number; signedOff: number };
    steps: { title: string; status: 'OPEN' | 'DONE' | 'SIGNED_OFF'; work: string | null; doneBy: string | null; doneAt: string | null; signedOffBy: string | null; signedOffAt: string | null }[];
    conclusion: string | null;
    closedAt: string | null;
  };
  evidence: { reference: string; title: string; details: string; submittedBy: string | null; submittedAt: string | null; acceptedBy: string | null; acceptedAt: string | null; files: { attachmentId: string; fileName: string; sha256: string }[] }[];
  findings: { reference: string; title: string; description: string; severity: 'LOW' | 'MEDIUM' | 'HIGH'; status: string; plan: string; dueDate: string }[];
  samples: { reference: string; name: string; method: string; population: string; from: string; to: string; seed: string; populationCount: number; populationTotal: string; status: 'OPEN' | 'COMPLETED'; progress: { tested: number; exceptions: number; remaining: number } }[];
  trialBalance: { currency: string; asOf: string; balanced: boolean; totals: { netDebit: string; netCredit: string }; rows: { code: string; name: string; type: string; netDebit: string; netCredit: string }[] };
}
const STATUS = { PLANNING: 'Planning', FIELDWORK: 'Fieldwork', REVIEW: 'In review', CLOSED: 'Closed' } as const;
const STEP = { OPEN: { label: 'To do', tone: 'neutral' }, DONE: { label: 'Done, awaiting sign-off', tone: 'warning' }, SIGNED_OFF: { label: 'Signed off', tone: 'positive' } } as const;

/** Whether an amount as text is zero, without converting money to a floating-point number. */
const zero = (v: string) => /^-?0(\.0+)?$/.test(v);

class PortalError extends Error {}
async function call<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: 'no-store' });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new PortalError(body?.message ?? 'This page could not be loaded. Try again in a minute.');
  return body as T;
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card className="mt-6" role="region" aria-label={title}>
      <div className="px-5 pt-5">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-sm text-fg-muted">{description}</p>
      </div>
      <div className="mt-3">{children}</div>
    </Card>
  );
}

export default function AuditorPortalPage() {
  const { token } = useParams<{ token: string }>();
  const base = `/api/auditor-portal/${encodeURIComponent(token)}`;
  const q = useQuery({ queryKey: ['auditor-portal', token], queryFn: () => call<Portal>(base), retry: false });
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
  const e = p.engagement;
  const tb = p.trialBalance;
  return (
    <Shell>
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-6">
        <div>
          <p className="text-sm text-fg-muted">Internal audit of {p.organisation.legalName ?? p.organisation.name}</p>
          <h1 className="text-2xl font-semibold">{e.reference}: {e.name}</h1>
          <p className="mt-1 text-sm text-fg-muted">{e.objective}</p>
          <p className="mt-1 text-sm">Scope {date(e.scopeFrom)} to {date(e.scopeTo)} · Led by {e.lead}, reviewed by {e.reviewer} · <Badge tone={e.status === 'CLOSED' ? 'positive' : 'warning'}>{STATUS[e.status]}</Badge></p>
        </div>
        <div className="sm:text-right">
          <p className="text-sm text-fg-muted">Read-only access for</p>
          <p className="text-lg font-medium">{p.auditor.name}{p.auditor.firm ? `, ${p.auditor.firm}` : ''}</p>
          <p className="text-sm text-fg-muted">until {date(p.link.expiresAt.slice(0, 10))}</p>
        </div>
      </header>

      {e.conclusion ? (
        <Section title="Conclusion" description={`Signed off by ${e.reviewer} on ${date((e.closedAt ?? '').slice(0, 10))}.`}>
          <p className="px-5 pb-5 text-sm">{e.conclusion}</p>
        </Section>
      ) : null}

      <Section title="Work performed" description={`${e.progress.done} of ${e.progress.steps} steps done, ${e.progress.signedOff} signed off by the reviewer.`}>
        {e.steps.length ? (
          <Table aria-label="Work performed">
            <thead><Tr><Th>Step</Th><Th>Work done</Th><Th>Status</Th></Tr></thead>
            <tbody>
              {e.steps.map((s, i) => (
                <Tr key={i}>
                  <Td>{s.title}</Td>
                  <Td className="text-sm">{s.work ? <>{s.work}<span className="block text-xs text-fg-muted">{s.doneBy}, {dateTime(s.doneAt ?? '')}</span></> : <span className="text-fg-muted">Not done yet</span>}</Td>
                  <Td><Badge tone={STEP[s.status].tone}>{STEP[s.status].label}</Badge>{s.signedOffBy ? <span className="block text-xs text-fg-muted">{s.signedOffBy}, {dateTime(s.signedOffAt ?? '')}</span> : null}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : <p className="px-5 pb-5 text-sm text-fg-muted">No steps planned yet.</p>}
      </Section>

      <Section title="Accepted evidence" description="Evidence the audit accepted, with each file's SHA-256 as submitted. Open a file to download it; each opening is recorded.">
        {p.evidence.length ? (
          <Table aria-label="Accepted evidence">
            <thead><Tr><Th>Evidence</Th><Th>Files</Th><Th>Accepted</Th></Tr></thead>
            <tbody>
              {p.evidence.map((r) => (
                <Tr key={r.reference}>
                  <Td>{r.reference} {r.title}{r.details ? <span className="block text-xs text-fg-muted">{r.details}</span> : null}</Td>
                  <Td className="text-sm">
                    {r.files.map((f) => (
                      <div key={f.attachmentId}>
                        <a className="text-accent hover:underline" href={`${base}/files/${f.attachmentId}`}>{f.fileName}</a>
                        <span className="block break-all font-mono text-xs text-fg-muted">{f.sha256}</span>
                      </div>
                    ))}
                  </Td>
                  <Td className="text-sm">{r.acceptedBy}<span className="block text-xs text-fg-muted">{dateTime(r.acceptedAt ?? '')}; submitted by {r.submittedBy}</span></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : <p className="px-5 pb-5 text-sm text-fg-muted">No evidence accepted yet.</p>}
      </Section>

      <Section title="Findings" description="Problems the audit raised, with the fix planned and where each stands.">
        {p.findings.length ? (
          <Table aria-label="Findings">
            <thead><Tr><Th>Finding</Th><Th>Severity</Th><Th>Plan</Th><Th>Status</Th></Tr></thead>
            <tbody>
              {p.findings.map((f) => (
                <Tr key={f.reference}>
                  <Td>{f.reference} {f.title}<span className="block text-xs text-fg-muted">{f.description}</span></Td>
                  <Td className="text-sm">{f.severity.toLowerCase()}</Td>
                  <Td className="text-sm">{f.plan}<span className="block text-xs text-fg-muted">due {date(f.dueDate)}</span></Td>
                  <Td><Badge tone={f.status === 'CLOSED' ? 'positive' : 'negative'}>{f.status === 'CLOSED' ? 'Closed' : 'Open'}</Badge></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : <p className="px-5 pb-5 text-sm text-fg-muted">No findings linked.</p>}
      </Section>

      <Section title="Samples tested" description="Samples drawn for the audit, with the seed anyone can draw them again from, and how testing went.">
        {p.samples.length ? (
          <Table aria-label="Samples tested">
            <thead><Tr><Th>Sample</Th><Th>Population</Th><Th>Tested</Th></Tr></thead>
            <tbody>
              {p.samples.map((s) => (
                <Tr key={s.reference}>
                  <Td>{s.reference} {s.name}<span className="block text-xs text-fg-muted">Seed {s.seed}</span></Td>
                  <Td className="text-sm">{s.populationCount} items, <Money value={s.populationTotal} currency={tb.currency} /><span className="block text-xs text-fg-muted">{date(s.from)} to {date(s.to)}</span></Td>
                  <Td className="text-sm">{s.progress.tested} of {s.progress.tested + s.progress.remaining}{s.progress.exceptions ? `, ${s.progress.exceptions} with exceptions` : ''}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : <p className="px-5 pb-5 text-sm text-fg-muted">No samples linked.</p>}
      </Section>

      <Section title="Trial balance" description={`Posted balances at ${date(tb.asOf)}, the end of the scope, as the books stand now. ${tb.balanced ? 'Debits equal credits.' : 'Debits do not equal credits.'}`}>
        <Table aria-label="Trial balance">
          <thead><Tr><Th>Account</Th><Th numeric>Debit</Th><Th numeric>Credit</Th></Tr></thead>
          <tbody>
            {tb.rows.map((r) => (
              <Tr key={r.code}>
                <Td><span className="num">{r.code}</span> {r.name}</Td>
                <Td numeric>{!zero(r.netDebit) ? <Money value={r.netDebit} currency={tb.currency} /> : null}</Td>
                <Td numeric>{!zero(r.netCredit) ? <Money value={r.netCredit} currency={tb.currency} /> : null}</Td>
              </Tr>
            ))}
            <Tr>
              <Td className="font-semibold">Total</Td>
              <Td numeric className="font-semibold"><Money value={tb.totals.netDebit} currency={tb.currency} /></Td>
              <Td numeric className="font-semibold"><Money value={tb.totals.netCredit} currency={tb.currency} /></Td>
            </Tr>
          </tbody>
        </Table>
      </Section>
      <p className="mt-6 text-center text-xs text-fg-muted">Read-only. Nothing you do here changes {p.organisation.name}&apos;s records.</p>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return <main id="main" className="min-h-screen bg-bg px-4 py-8 text-fg sm:px-8"><div className="mx-auto max-w-5xl">{children}</div></main>;
}

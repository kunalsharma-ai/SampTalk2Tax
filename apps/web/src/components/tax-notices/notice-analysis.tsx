'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Select } from '@talk2tax/ui';
import Link from 'next/link';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { api } from '@/lib/api';
import { date } from '@/lib/format';

interface Analysis {
  type: { key: string; title: string; what: string; replyWithinDays: number | null; howToReply: string; source: string } | null;
  recognisedBy: 'SECTION' | 'CHOSEN' | null;
  deadline: { date: string; source: 'NOTICE' | 'RULE' } | null;
  usualDeadline: string | null;
  interest: { from: string; months: number; ratePerMonth: string; amount: string; note: string } | null;
  checklist: { key: string; label: string; done: boolean }[];
  progress: { done: number; total: number };
  warnings: string[];
  chosenType: string | null;
  types: { key: string; title: string }[];
  related: { samePeriod: boolean; notices: { id: string; reference: string; section: string | null; subject: string; period: string | null; status: string; receivedOn: string }[] };
  updatedBy: string | null;
  currency: string;
}

/** Tax notice analysis (TAX-050): what the notice is, by when and how to reply, and what to gather. */
export function NoticeAnalysis({ orgId, noticeId, canManage }: { orgId: string; noticeId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const key = ['tax-notice-analysis', orgId, noticeId];
  const url = `/v1/orgs/${orgId}/tax-notices/${noticeId}/analysis`;
  const q = useQuery({ queryKey: key, queryFn: () => api<Analysis>(url) });
  const save = useMutation({ mutationFn: (b: { chosenType: string | null; checked: string[] }) => api<Analysis>(url, { method: 'PUT', body: b }), onSuccess: (a) => qc.setQueryData(key, a) });
  const a = q.data;
  const checked = (a?.checklist ?? []).filter((c) => c.done).map((c) => c.key);
  return (
    <Card className="mt-6" role="region" aria-label="Notice analysis">
      <CardHeader
        title="Notice analysis"
        description="What this kind of notice asks for, by when and how to reply, from the authority and section you entered. Rule-based: each type names the provision it comes from. Check the notice itself; it prepares, it does not advise."
      />
      <ErrorAlert title="Could not analyse the notice" error={q.error} />
      <ErrorAlert title="Not saved" error={save.error} />
      {a ? (
        <div className="grid gap-4 p-5 lg:grid-cols-2">
          <div className="grid content-start gap-3 text-sm">
            {a.type ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-semibold">{a.type.title}</span>
                  <Badge tone={a.recognisedBy === 'CHOSEN' ? 'violet' : 'accent'}>{a.recognisedBy === 'CHOSEN' ? 'Type chosen' : 'From the section'}</Badge>
                </div>
                <p>{a.type.what}</p>
                <p><span className="font-medium">How to reply: </span>{a.type.howToReply}</p>
                <p className="text-xs text-fg-muted">Source: {a.type.source}</p>
              </>
            ) : <p className="text-fg-muted">Not recognised.</p>}
            {a.deadline ? (
              <p><span className="font-medium">Reply by {date(a.deadline.date)}</span> {a.deadline.source === 'RULE' ? `(the usual ${a.type?.replyWithinDays} days from receipt)` : '(the date entered from the notice)'}</p>
            ) : null}
            {a.interest ? (
              <Alert tone="warning" title="Interest is building up on the demand">
                About <Money value={a.interest.amount} currency={a.currency} /> so far: {a.interest.ratePerMonth}% a month for {a.interest.months} {a.interest.months === 1 ? 'month' : 'months'} from {date(a.interest.from)}. {a.interest.note}
              </Alert>
            ) : null}
            {a.warnings.map((w) => <Alert key={w} tone="neutral" title="Check">{w}</Alert>)}
            {canManage && a.types.length ? (
              <Field label="Notice type">
                {(p) => (
                  <Select {...p} value={a.chosenType ?? ''} disabled={save.isPending} onChange={(e) => save.mutate({ chosenType: e.target.value || null, checked: [] })}>
                    <option value="">Go by the section</option>
                    {a.types.map((t) => <option key={t.key} value={t.key}>{t.title}</option>)}
                  </Select>
                )}
              </Field>
            ) : null}
          </div>
          <div className="grid content-start gap-3 text-sm">
            {a.checklist.length ? (
              <div>
                <div className="mb-2 font-medium">What to do and gather ({a.progress.done} of {a.progress.total} done)</div>
                <ul aria-label="Notice checklist" className="grid gap-2">
                  {a.checklist.map((c) => (
                    <li key={c.key}>
                      <label className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-1 accent-[var(--t2t-accent)]"
                          checked={c.done}
                          disabled={!canManage || save.isPending}
                          onChange={(e) => save.mutate({ chosenType: a.chosenType, checked: e.target.checked ? [...checked, c.key] : checked.filter((k) => k !== c.key) })}
                        />
                        <span className={c.done ? 'text-fg-muted line-through' : ''}>{c.label}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                {a.updatedBy ? <p className="mt-2 text-xs text-fg-muted">Last ticked by {a.updatedBy}.</p> : null}
              </div>
            ) : null}
            <div>
              <div className="mb-2 font-medium">{a.related.samePeriod ? 'Other notices from this authority for the same period' : 'Other notices from this authority'}</div>
              {a.related.notices.length ? (
                <ul className="grid gap-1">
                  {a.related.notices.map((o) => (
                    <li key={o.id}><Link className="underline" href={`/orgs/${orgId}/tax/notices/${o.id}`}>{o.reference}</Link> · {o.subject} · {date(o.receivedOn)} · {o.status.toLowerCase()}</li>
                  ))}
                </ul>
              ) : <p className="text-fg-muted">None.</p>}
            </div>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

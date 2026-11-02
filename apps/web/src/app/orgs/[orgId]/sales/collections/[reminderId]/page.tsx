'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Field, Input, Table, Td, Textarea, Th, Tr, cn } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime, RISK, STATUS, type DraftCheck, type Reminder } from '@/lib/collections';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

export default function ReminderPage() {
  const { org, orgId } = useOrg();
  const { reminderId } = useParams<{ reminderId: string }>();
  const qc = useQueryClient();
  const path = `/v1/orgs/${orgId}/collections/reminders/${reminderId}`;
  const q = useQuery({ queryKey: ['reminder', orgId, reminderId], queryFn: () => api<Reminder>(path), refetchInterval: (x) => (x.state.data?.status === 'DRAFTING' ? 1500 : false) });
  const r = q.data;
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => {
    if (r?.subject !== undefined && r.subject !== null) setSubject(r.subject);
    if (r?.body !== undefined && r.body !== null) setBody(r.body);
  }, [r?.id, r?.status, r?.subject, r?.body]);

  const editable = r?.status === 'READY';
  const changed = !!r && editable && (subject !== r.subject || body !== r.body);
  // Checks run on the server against the facts the draft was written from, as the person types.
  const [checked, setChecked] = useState<{ subject: string; body: string; checks: DraftCheck[] } | null>(null);
  const check = useMutation({
    mutationFn: (v: { subject: string; body: string }) => api<{ checks: DraftCheck[]; passes: boolean }>(`${path}/check`, { method: 'POST', body: v }),
    onSuccess: (res, v) => setChecked({ ...v, checks: res.checks }),
  });
  useEffect(() => {
    if (!changed) return;
    const t = setTimeout(() => check.mutate({ subject, body }), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changed, subject, body]);
  const checks = changed ? (checked && checked.subject === subject && checked.body === body ? checked.checks : null) : (r?.checks ?? []);
  const passes = !!checks && checks.every((c) => c.ok);

  const done = (x: Reminder) => {
    qc.setQueryData(['reminder', orgId, reminderId], x);
    void qc.invalidateQueries({ queryKey: ['reminders', orgId] });
    void qc.invalidateQueries({ queryKey: ['collections', orgId] });
  };
  const send = useMutation({ mutationFn: () => api<Reminder>(`${path}/send`, { method: 'POST', body: r?.status === 'READY' ? { subject, body } : {} }), onSuccess: done });
  const reject = useMutation({ mutationFn: () => api<Reminder>(`${path}/reject`, { method: 'POST', body: { note: note.trim() || null } }), onSuccess: (x) => { done(x); setRejecting(false); } });

  if (!org) return null;
  const canManage = can(org.role, 'collections.manage');
  const f = r?.facts;
  return (
    <>
      <div className="mb-2 text-sm">
        <Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/collections`}>← Collections</Link>
      </div>
      <PageHeader
        title={r ? `Payment reminder for ${r.customer}` : 'Payment reminder'}
        description={r ? `To ${r.toEmail} · drafted ${dateTime(r.createdAt)} by ${r.model}${r.servedModel && r.servedModel !== r.model ? ` (answered by ${r.servedModel})` : ''}` : undefined}
      />
      <ErrorAlert title="Could not load the reminder" error={q.error} />
      {r && f ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="flex flex-col gap-4">
            <Card className="p-5" aria-label="Reminder">
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                {r.risk ? <Badge tone={RISK[r.risk].tone}>{RISK[r.risk].label}</Badge> : null}
                {r.edited ? <Badge>Edited before sending</Badge> : null}
                {r.usage ? <span className="text-xs text-fg-faint">{r.usage.inputTokens.toLocaleString('en-IN')} tokens in · {r.usage.outputTokens.toLocaleString('en-IN')} out</span> : null}
              </div>
              {r.status === 'DRAFTING' ? <p className="text-sm text-fg-muted" role="status">The AI model is writing this reminder…</p> : null}
              {r.status === 'FAILED' ? (
                <Alert title="This reminder could not be drafted">
                  {r.errorMessage} <span className="text-xs">({r.errorCode})</span>
                </Alert>
              ) : null}
              {r.subject !== null && r.body !== null ? (
                <div className="flex flex-col gap-3">
                  <Field label="Subject">{(p) => <Input {...p} value={subject} onChange={(e) => setSubject(e.target.value)} readOnly={!editable || !canManage} maxLength={300} />}</Field>
                  <Field label="Message" hint={editable && canManage ? 'Edit freely. The checks below run again on what you write.' : undefined}>
                    {(p) => <Textarea {...p} className="font-mono text-[13px] leading-relaxed" rows={Math.min(22, Math.max(10, body.split('\n').length + 2))} value={body} onChange={(e) => setBody(e.target.value)} readOnly={!editable || !canManage} maxLength={20000} />}
                  </Field>
                  {changed ? (
                    <button type="button" className="w-fit text-xs text-accent hover:underline" onClick={() => { setSubject(r.aiSubject ?? ''); setBody(r.aiBody ?? ''); }}>
                      Undo my edits
                    </button>
                  ) : null}
                </div>
              ) : null}
            </Card>

            {r.subject !== null ? (
              <Card className="p-5" aria-label="Checks against the books">
                <h2 className="mb-2 text-sm font-semibold">Checks against the books</h2>
                {checks ? (
                  <ul className="flex flex-col gap-1 text-sm">
                    {checks.map((c) => (
                      <li key={c.label} className={cn('flex gap-2', c.ok ? 'text-fg' : 'text-negative')}>
                        <span aria-hidden>{c.ok ? '✓' : '✕'}</span>
                        <span>{c.label}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-fg-muted" role="status">Checking…</p>
                )}
                {r.status === 'READY' && checks && !passes ? <p className="mt-2 text-xs text-fg-muted">Fix the message so these pass before it can be sent.</p> : null}
              </Card>
            ) : null}

            {canManage && (r.status === 'READY' || r.status === 'SEND_FAILED') ? (
              <Card className="p-5" aria-label="Decide">
                <ErrorAlert title="Not sent" error={send.error} />
                <ErrorAlert title="Not rejected" error={reject.error} />
                {r.status === 'SEND_FAILED' ? (
                  <div className="mb-3">
                    <Alert tone="warning" title="The mail server did not accept this reminder">
                      {r.errorMessage}. Sending again sends it exactly as it was approved.
                    </Alert>
                  </div>
                ) : null}
                {rejecting ? (
                  <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); reject.mutate(); }}>
                    <Field label="Why not send it? (optional)">{(p) => <Textarea {...p} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />}</Field>
                    <div className="flex justify-end gap-2">
                      <Button type="button" variant="ghost" onClick={() => setRejecting(false)}>Cancel</Button>
                      <Button type="submit" variant="danger" loading={reject.isPending}>Reject reminder</Button>
                    </div>
                  </form>
                ) : (
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <p className="mr-auto text-xs text-fg-muted">Sending emails {r.toEmail} now. The books are checked again first.</p>
                    {r.status === 'READY' ? <Button variant="ghost" onClick={() => setRejecting(true)}>Reject…</Button> : null}
                    <Button loading={send.isPending} disabled={r.status === 'READY' && (!passes || !subject.trim() || !body.trim())} onClick={() => send.mutate()}>
                      {r.status === 'SEND_FAILED' ? 'Send again' : changed ? 'Send with my edits' : 'Approve and send'}
                    </Button>
                  </div>
                )}
              </Card>
            ) : null}

            {r.decidedBy ? (
              <Card className="p-5" aria-label="Decision">
                <h2 className="mb-2 text-sm font-semibold">Decision</h2>
                <p className="text-sm">
                  {r.status === 'REJECTED' ? 'Rejected' : 'Approved'} by {r.decidedBy} on {dateTime(r.decidedAt!)}
                  {r.sentAt ? `, sent ${dateTime(r.sentAt)}` : ''}.
                </p>
                {r.decisionNote ? <p className="mt-1 text-sm text-fg-muted">{r.decisionNote}</p> : null}
                {r.sendLog.length ? (
                  <ol className="mt-3 flex flex-col gap-1 border-l border-line pl-3 text-xs text-fg-muted" aria-label="Delivery attempts">
                    {r.sendLog.map((l) => (
                      <li key={l.at}>
                        {dateTime(l.at)} · {l.ok ? 'Accepted' : 'Refused'}{l.status ? ` (${l.status})` : ''}
                        {l.responseSnippet ? <span className="block font-mono text-fg-faint">{l.responseSnippet}</span> : null}
                      </li>
                    ))}
                  </ol>
                ) : null}
              </Card>
            ) : null}
          </div>

          <div className="flex flex-col gap-4">
            <Card className="p-5" aria-label="Overdue invoices">
              <h2 className="mb-1 text-sm font-semibold">What the draft was written from</h2>
              <p className="mb-3 text-xs text-fg-muted">Taken from the books on {date(f.today)}. These are the only figures a reminder may state.</p>
              <div className="overflow-x-auto">
                <Table aria-label="Overdue invoices">
                  <thead>
                    <tr>
                      <Th>Invoice</Th>
                      <Th>Due</Th>
                      <Th numeric>Days late</Th>
                      <Th numeric>Still to pay</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {f.overdue.map((i) => (
                      <Tr key={i.number}>
                        <Td className="whitespace-nowrap">{i.documentId ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/invoices/${i.documentId}`}>{i.number}</Link> : i.number}</Td>
                        <Td className="whitespace-nowrap">{date(i.dueDate)}</Td>
                        <Td numeric>{i.daysOverdue}</Td>
                        <Td numeric><Money value={i.balance} currency={f.currency} /></Td>
                      </Tr>
                    ))}
                    <Tr>
                      <Td className="font-semibold" colSpan={3}>Total overdue</Td>
                      <Td numeric className="font-semibold"><Money value={f.totalOverdue} currency={f.currency} /></Td>
                    </Tr>
                  </tbody>
                </Table>
              </div>
              <dl className="mt-3 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-4 gap-y-1 text-sm">
                <dt className="text-fg-muted">Payment history</dt>
                <dd>{f.averageDaysLate === null ? 'No invoices paid in full in the last 12 months' : `${f.paidInvoicesConsidered} paid, on average ${Math.abs(f.averageDaysLate)} days ${f.averageDaysLate >= 0 ? 'late' : 'early'}`}</dd>
                <dt className="text-fg-muted">Last payment</dt>
                <dd>{f.lastPayment ? <><Money value={f.lastPayment.amount} currency={f.currency} /> on {date(f.lastPayment.date)}</> : 'None on record'}</dd>
                <dt className="text-fg-muted">Not yet due</dt>
                <dd>{f.notYetDue.length ? f.notYetDue.map((i) => i.number).join(', ') : 'None'}</dd>
                <dt className="text-fg-muted">Earlier reminders</dt>
                <dd>{f.previousReminders.length ? f.previousReminders.map((p) => date(p.sentOn)).join(', ') : 'None'}</dd>
              </dl>
            </Card>
            {r.risk ? (
              <Card className="p-5" aria-label="Risk">
                <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  Risk the customer will not pay <Badge tone={RISK[r.risk].tone}>{RISK[r.risk].label}</Badge>
                </h2>
                <ul className="list-inside list-disc text-sm text-fg-muted">{r.riskReasons.map((x) => <li key={x}>{x}</li>)}</ul>
                <p className="mt-2 text-xs text-fg-faint">The AI model&rsquo;s assessment, from the facts above. It is a prompt for judgement, not a credit decision.</p>
              </Card>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { AREAS, FREQUENCIES, STATUS, words, type Control, type ControlTest, type Period, type Register } from '@/components/controls/types';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

type Detail = Control & { tests: ControlTest[]; canManage: boolean };
type Outcome = { period: Period; result: 'PASS' | 'FAIL'; summary: string; exceptions: string[] };

/** One control: test it for a period, see every test recorded, and change its owner or frequency. */
export default function ControlPage() {
  const { org, orgId } = useOrg();
  const { controlId } = useParams<{ controlId: string }>();
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/controls/${controlId}`;
  const key = ['control', orgId, controlId];
  const q = useQuery({ queryKey: key, queryFn: () => api<Detail>(base) });
  const reg = useQuery({ queryKey: ['controls', orgId], queryFn: () => api<Register>(`/v1/orgs/${orgId}/controls`) });
  const c = q.data;
  const [period, setPeriod] = useState('');
  const [result, setResult] = useState('');
  const [notes, setNotes] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [edit, setEdit] = useState<{ title: string; objective: string; area: string; frequency: string; ownerId: string; active: boolean } | null>(null);
  useEffect(() => {
    if (c && !period) setPeriod(c.duePeriod.key);
    if (c && !edit) setEdit({ title: c.title, objective: c.objective, area: c.area, frequency: c.frequency, ownerId: c.owner.id, active: c.active });
  }, [c, period, edit]);
  const refresh = (d: Detail) => {
    qc.setQueryData(key, d);
    void qc.invalidateQueries({ queryKey: ['controls', orgId] });
  };
  const run = useMutation({ mutationFn: () => api<Outcome>(`${base}/check`, { method: 'POST', body: { period } }), onSuccess: setOutcome });
  const record = useMutation({
    mutationFn: () => api<Detail>(`${base}/tests`, { method: 'POST', body: c?.check ? { period, notes: notes || null } : { period, result, notes } }),
    onSuccess: (d) => {
      refresh(d);
      setOutcome(null);
      setNotes('');
      setResult('');
    },
  });
  const save = useMutation({ mutationFn: () => api<Detail>(base, { method: 'PUT', body: edit ?? undefined }), onSuccess: (d) => { refresh(d); setEdit(null); } });
  if (!org) return null;
  if (q.error) return <ErrorAlert title="Could not load the control" error={q.error} />;
  if (!c) return null;
  const blocked = c.isOwner && (reg.data?.members.filter((m) => m.id !== c.owner.id && m.role !== 'VIEWER').length ?? 0) > 0;
  return (
    <>
      <PageHeader
        title={c.title}
        description={<>{c.objective} Owner: {c.owner.name}. {words(c.frequency)}, {words(c.area).toLowerCase()}. <Link className="text-accent" href={`/orgs/${orgId}/controls`}>All controls</Link></>}
        actions={<Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label} for {c.duePeriod.label}</Badge>}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Test this control" description={c.check ? `Automatic check: ${c.checkDescription}.` : 'Tested by hand: say whether it worked and what you checked.'} />
          {!c.active ? (
            <EmptyState title="Not in use">Put the control back in use to test it.</EmptyState>
          ) : blocked ? (
            <Alert tone="warning" title="You own this control">Someone other than its owner must test it.</Alert>
          ) : (
            <form
              className="flex flex-col gap-3 p-4"
              onSubmit={(e) => {
                e.preventDefault();
                record.mutate();
              }}
            >
              <Field label="Period tested" hint="Such as 2026-10, 2026-Q2 or FY2026">
                {(p) => <Input {...p} className="w-40" value={period} onChange={(e) => { setPeriod(e.target.value); setOutcome(null); }} />}
              </Field>
              {c.check ? (
                <>
                  <div><Button type="button" size="sm" variant="secondary" loading={run.isPending} disabled={!period} onClick={() => run.mutate()}>Run check</Button></div>
                  {outcome ? (
                    <div className="rounded-md border border-line p-3 text-sm" aria-label="Check outcome">
                      <Badge tone={outcome.result === 'PASS' ? 'positive' : 'negative'}>{outcome.result === 'PASS' ? 'Passes' : 'Fails'}</Badge> {outcome.period.label}: {outcome.summary}
                      {outcome.exceptions.length ? <ul className="mt-2 list-disc pl-5">{outcome.exceptions.map((x) => <li key={x}>{x}</li>)}</ul> : null}
                    </div>
                  ) : null}
                  <ErrorAlert title="The check did not run" error={run.error} />
                </>
              ) : (
                <Field label="Result">
                  {(p) => (
                    <Select {...p} className="w-48" value={result} onChange={(e) => setResult(e.target.value)}>
                      <option value="">Choose…</option>
                      <option value="PASS">Worked as intended</option>
                      <option value="FAIL">Did not work</option>
                    </Select>
                  )}
                </Field>
              )}
              <Field label="What you checked">{(p) => <Textarea {...p} rows={3} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={c.check ? 'Optional notes' : 'At least 10 characters'} />}</Field>
              <div><Button type="submit" size="sm" loading={record.isPending} disabled={!period || (!c.check && (!result || notes.trim().length < 10))}>Record test</Button></div>
              <p className="text-xs text-fg-muted">{c.check ? 'The result and evidence are worked out from the books when you record the test.' : 'The test is kept as recorded and cannot be changed.'}</p>
              <ErrorAlert title="The test was not recorded" error={record.error} />
            </form>
          )}
        </Card>
        {c.canManage && edit ? (
          <Card>
            <CardHeader title="Control details" description="Change the owner, frequency or wording, or take the control out of use" />
            <form
              className="flex flex-col gap-3 p-4"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
            >
              <Field label="Title">{(p) => <Input {...p} maxLength={120} value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />}</Field>
              <Field label="Objective">{(p) => <Textarea {...p} rows={2} maxLength={500} value={edit.objective} onChange={(e) => setEdit({ ...edit, objective: e.target.value })} />}</Field>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Area">{(p) => <Select {...p} value={edit.area} onChange={(e) => setEdit({ ...edit, area: e.target.value })}>{AREAS.map((a) => <option key={a} value={a}>{words(a)}</option>)}</Select>}</Field>
                <Field label="Frequency">{(p) => <Select {...p} value={edit.frequency} onChange={(e) => setEdit({ ...edit, frequency: e.target.value })}>{FREQUENCIES.map((f) => <option key={f} value={f}>{words(f)}</option>)}</Select>}</Field>
                <Field label="Owner">{(p) => <Select {...p} value={edit.ownerId} onChange={(e) => setEdit({ ...edit, ownerId: e.target.value })}>{(reg.data?.members ?? [c.owner]).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>}</Field>
              </div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />In use</label>
              <div><Button type="submit" size="sm" loading={save.isPending}>Save control</Button></div>
              <ErrorAlert title="The control was not saved" error={save.error} />
            </form>
          </Card>
        ) : null}
      </div>
      <Card className="mt-4">
        <CardHeader title="Test history" description="Every test recorded, newest first" />
        {!c.tests.length ? (
          <EmptyState title="Not tested yet">Tests recorded above show here.</EmptyState>
        ) : (
          <Table aria-label="Test history">
            <thead><Tr><Th>Period</Th><Th>Result</Th><Th>How</Th><Th>Evidence and notes</Th><Th>Tested by</Th></Tr></thead>
            <tbody>
              {c.tests.map((t) => (
                <Tr key={t.id}>
                  <Td className="whitespace-nowrap">{t.periodKey}</Td>
                  <Td><Badge tone={t.result === 'PASS' ? 'positive' : 'negative'}>{t.result === 'PASS' ? 'Passed' : 'Failed'}</Badge></Td>
                  <Td>{t.method === 'AUTOMATIC' ? 'Checked against the books' : 'By hand'}</Td>
                  <Td className="text-sm">
                    {t.evidence ? <div>{t.evidence.summary}</div> : null}
                    {t.evidence?.exceptions.length ? <ul className="list-disc pl-5 text-fg-muted">{t.evidence.exceptions.map((x) => <li key={x}>{x}</li>)}</ul> : null}
                    {t.notes ? <div className="text-fg-muted">{t.notes}</div> : null}
                  </Td>
                  <Td className="text-sm">{t.testedBy.name}, {date(t.testedAt.slice(0, 10))}{t.selfTested ? <div><Badge tone="warning">Owner tested own control</Badge></div> : null}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}

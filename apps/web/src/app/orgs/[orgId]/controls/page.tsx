'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Stat, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { AREAS, FREQUENCIES, STATUS, words, type Register } from '@/components/controls/types';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

/** Internal controls register (AUDIT-008, AUDIT-013): each control, its owner, and where its testing stands. */
export default function ControlsPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const key = ['controls', orgId];
  const q = useQuery({ queryKey: key, queryFn: () => api<Register>(`/v1/orgs/${orgId}/controls`) });
  const [templateId, setTemplateId] = useState('');
  const [libraryOwner, setLibraryOwner] = useState('');
  const [custom, setCustom] = useState({ title: '', objective: '', area: 'OTHER', frequency: 'MONTHLY', ownerId: '' });
  const done = () => void qc.invalidateQueries({ queryKey: key });
  const addLibrary = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/controls`, { method: 'POST', body: { templateId, ownerId: libraryOwner } }),
    onSuccess: () => {
      setTemplateId('');
      done();
    },
  });
  const addCustom = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/controls`, { method: 'POST', body: custom }),
    onSuccess: () => {
      setCustom({ title: '', objective: '', area: 'OTHER', frequency: 'MONTHLY', ownerId: '' });
      done();
    },
  });
  if (!org) return null;
  const d = q.data;
  const template = d?.library.find((t) => t.id === templateId);
  return (
    <>
      <PageHeader title="Controls register" description="The checks that keep the books right, who owns each one, and whether it was tested for the last period. Tests are kept as recorded." />
      <ErrorAlert title="Could not load" error={q.error} />
      {d ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-4">
            <Stat label="Passed" value={d.summary.passed} sub="For the last period" tone={d.summary.passed ? 'positive' : 'neutral'} />
            <Stat label="Failed" value={d.summary.failed} sub="Needs fixing" tone={d.summary.failed ? 'negative' : 'neutral'} />
            <Stat label="Due" value={d.summary.due} sub="Within 15 days of period end" tone={d.summary.due ? 'warning' : 'neutral'} />
            <Stat label="Overdue" value={d.summary.overdue} sub="Not tested in time" tone={d.summary.overdue ? 'negative' : 'neutral'} />
          </div>
          <Card className="mb-4">
            <CardHeader title="Controls register" description="Open a control to test it or see its history" />
            {!d.controls.length ? (
              <EmptyState title="No controls yet">{d.canManage ? 'Add one from the library below, or write your own.' : 'An owner or admin adds controls.'}</EmptyState>
            ) : (
              <Table aria-label="Controls">
                <thead><Tr><Th>Control</Th><Th>Area</Th><Th>Frequency</Th><Th>Owner</Th><Th>Period</Th><Th>Status</Th><Th>Last test</Th></Tr></thead>
                <tbody>
                  {d.controls.map((c) => (
                    <Tr key={c.id}>
                      <Td>
                        <Link className="hover:text-accent" href={`/orgs/${orgId}/controls/${c.id}`}>{c.title}</Link>
                        <div className="text-xs text-fg-muted">{c.check ? 'Checked against the books' : 'Tested by hand'}</div>
                      </Td>
                      <Td>{words(c.area)}</Td>
                      <Td>{words(c.frequency)}</Td>
                      <Td>{c.owner.name}</Td>
                      <Td className="whitespace-nowrap">{c.duePeriod.label}</Td>
                      <Td><Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge></Td>
                      <Td className="text-sm text-fg-muted">{c.lastTest ? `${c.lastTest.result === 'PASS' ? 'Passed' : 'Failed'} for ${c.lastTest.periodKey}, ${date(c.lastTest.testedAt.slice(0, 10))}` : 'Never tested'}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          {d.canManage ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader title="Control library" description="Common controls for a small finance team. The first four are checked against the books for you." />
                <form
                  className="flex flex-col gap-3 p-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    addLibrary.mutate();
                  }}
                >
                  <Field label="Library control">
                    {(p) => (
                      <Select {...p} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                        <option value="">{d.library.length ? 'Choose a control…' : 'Every library control is in the register'}</option>
                        {d.library.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                      </Select>
                    )}
                  </Field>
                  {template ? <p className="text-sm text-fg-muted">{template.objective} {words(template.frequency)}. {template.checkDescription ? `Automatic check: ${template.checkDescription.charAt(0).toLowerCase()}${template.checkDescription.slice(1)}.` : 'Tested by hand.'}</p> : null}
                  <Field label="Owner">
                    {(p) => (
                      <Select {...p} value={libraryOwner} onChange={(e) => setLibraryOwner(e.target.value)}>
                        <option value="">Choose a member…</option>
                        {d.members.map((m) => <option key={m.id} value={m.id}>{m.name} ({words(m.role)})</option>)}
                      </Select>
                    )}
                  </Field>
                  <div><Button type="submit" size="sm" disabled={!templateId || !libraryOwner} loading={addLibrary.isPending}>Add to register</Button></div>
                  <ErrorAlert title="The control was not added" error={addLibrary.error} />
                </form>
              </Card>
              <Card>
                <CardHeader title="Write a control" description="One of your own, tested by hand with notes on what was checked" />
                <form
                  className="flex flex-col gap-3 p-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    addCustom.mutate();
                  }}
                >
                  <Field label="Control title">{(p) => <Input {...p} maxLength={120} value={custom.title} onChange={(e) => setCustom({ ...custom, title: e.target.value })} />}</Field>
                  <Field label="Objective">{(p) => <Textarea {...p} rows={2} maxLength={500} value={custom.objective} onChange={(e) => setCustom({ ...custom, objective: e.target.value })} />}</Field>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="Area">{(p) => <Select {...p} value={custom.area} onChange={(e) => setCustom({ ...custom, area: e.target.value })}>{AREAS.map((a) => <option key={a} value={a}>{words(a)}</option>)}</Select>}</Field>
                    <Field label="Frequency">{(p) => <Select {...p} value={custom.frequency} onChange={(e) => setCustom({ ...custom, frequency: e.target.value })}>{FREQUENCIES.map((f) => <option key={f} value={f}>{words(f)}</option>)}</Select>}</Field>
                    <Field label="Control owner">
                      {(p) => (
                        <Select {...p} value={custom.ownerId} onChange={(e) => setCustom({ ...custom, ownerId: e.target.value })}>
                          <option value="">Choose…</option>
                          {d.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                        </Select>
                      )}
                    </Field>
                  </div>
                  <div><Button type="submit" size="sm" disabled={!custom.title.trim() || !custom.objective.trim() || !custom.ownerId} loading={addCustom.isPending}>Add control</Button></div>
                  <ErrorAlert title="The control was not added" error={addCustom.error} />
                </form>
              </Card>
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

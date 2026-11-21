'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Select, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';

type Option = { id: string; name: string };
type Check = { id: string; title: string; status: 'DONE' | 'TODO'; required: boolean; detail: string; link: string };
type Suggestion = { framework: string; aiPreference: string; reasons: string[] };
type Recommendation = { id: string; kind: 'PROFILE' | 'STEP' | 'NOTE'; field: string | null; value: string | null; title: string; reason: string; link: string | null; status: 'PENDING' | 'ACCEPTED' | 'DISMISSED' };
type Assistant = {
  ai: { configured: boolean; available: boolean; reason: string | null };
  maxLength: number;
  reading: { description: string; source: 'AI' | 'RULES'; model: string | null; dropped: string[]; readAt: string; recommendations: Recommendation[] } | null;
};
type Profile = { industry: string | null; size: string | null; framework: string | null; aiPreference: string | null };
type SetupOverview = {
  countryCode: string;
  canManage: boolean;
  profile: Profile;
  suggestion: Suggestion;
  suggestionsBySize: Record<string, Suggestion>;
  options: { industries: Option[]; sizes: Option[]; frameworks: Option[]; aiPreferences: (Option & { what: string })[] };
  checks: Check[];
  activation: { ok: boolean; missing: string[]; activatedAt: string | null; activatedById: string | null };
  assistant: Assistant;
};

/** Organisation setup: business profile, AI preference, the setup checklist and activation (UX-004 to UX-019). */
export default function SetupPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/setup`;
  const q = useQuery({ queryKey: ['setup', orgId], queryFn: () => api<SetupOverview>(base) });
  const [form, setForm] = useState<Profile>({ industry: null, size: null, framework: null, aiPreference: null });
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (q.data) setForm(q.data.profile);
  }, [q.data?.profile.industry, q.data?.profile.size, q.data?.profile.framework, q.data?.profile.aiPreference]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: () => api<SetupOverview>(`${base}/profile`, { method: 'PUT', body: form }),
    onSuccess: (o) => {
      qc.setQueryData(['setup', orgId], o);
      void qc.invalidateQueries({ queryKey: ['ai-control', orgId] });
      setSaved(true);
    },
  });
  const [description, setDescription] = useState('');
  useEffect(() => {
    if (q.data?.assistant.reading) setDescription((d) => d || q.data!.assistant.reading!.description);
  }, [q.data?.assistant.reading?.readAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const readIt = useMutation({
    mutationFn: (useAi: boolean) => api<SetupOverview>(`${base}/assistant`, { method: 'POST', body: { description, useAi } }),
    onSuccess: (o) => qc.setQueryData(['setup', orgId], o),
  });
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'ACCEPTED' | 'DISMISSED' }) => api<SetupOverview>(`${base}/assistant/recommendations/${encodeURIComponent(v.id)}`, { method: 'POST', body: { decision: v.decision } }),
    onSuccess: (o) => {
      qc.setQueryData(['setup', orgId], o);
      void qc.invalidateQueries({ queryKey: ['ai-control', orgId] });
    },
  });
  const activate = useMutation({ mutationFn: () => api<SetupOverview>(`${base}/activate`, { method: 'POST' }), onSuccess: (o) => qc.setQueryData(['setup', orgId], o) });
  if (!org) return null;
  const o = q.data;
  const set = (k: keyof Profile) => (e: React.ChangeEvent<HTMLSelectElement>) => {
    setForm((f) => ({ ...f, [k]: e.target.value || null }));
    setSaved(false);
  };
  const complete = !!(form.industry && form.size && form.framework && form.aiPreference);
  const suggestion = o ? ((form.size && o.suggestionsBySize[form.size]) || o.suggestion) : null;
  const done = o?.checks.filter((c) => c.status === 'DONE').length ?? 0;

  return (
    <>
      <PageHeader
        title="Set up your organisation"
        description="Tell Talk2Tax about the business, choose how much the AI agents do, and work through the checklist. Activate the organisation once every required step is done; the optional ones can wait."
      />
      <ErrorAlert title="Could not load setup" error={q.error} />
      {o ? (
        <>
          {!o.activation.activatedAt && o.canManage ? (
            <Card className="mb-4">
              <CardHeader title="Describe your business" description="Say in your own words what the business does. The assistant recommends a profile and the setup steps that fit; nothing changes until you accept a recommendation." />
              <div className="px-5 py-4">
                <Field label="What does your business do?" hint="For example: who your customers are, how many people work with you, whether you sell abroad, bill monthly or own machinery.">
                  {(p) => <Textarea {...p} rows={3} maxLength={o.assistant.maxLength} value={description} onChange={(e) => setDescription(e.target.value)} />}
                </Field>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button variant="secondary" disabled={description.trim().length < 10} loading={readIt.isPending && readIt.variables === false} onClick={() => readIt.mutate(false)}>Recommend setup</Button>
                  <Button variant="secondary" disabled={description.trim().length < 10 || !o.assistant.ai.available} loading={readIt.isPending && readIt.variables === true} onClick={() => readIt.mutate(true)}>Recommend with AI</Button>
                  <span className="text-xs text-fg-muted">{o.assistant.ai.available ? 'With AI, the description is sent to the AI model; each finding must quote your words.' : o.assistant.ai.reason}</span>
                </div>
                <ErrorAlert title="No recommendations" error={readIt.error} />
              </div>
              {o.assistant.reading ? (
                <>
                  <p className="border-t border-line px-5 py-3 text-sm text-fg-muted">
                    {o.assistant.reading.source === 'AI' ? `Read by the AI model${o.assistant.reading.model ? ` (${o.assistant.reading.model})` : ''}` : 'Read from the words you used'} on {dateTime(o.assistant.reading.readAt)}.
                    {o.assistant.reading.dropped.length ? ` Left out because they did not quote your words or were not on the lists: ${o.assistant.reading.dropped.join('; ')}.` : ''}
                  </p>
                  <Table aria-label="Recommendations">
                    <thead><tr><Th>Recommendation</Th><Th>Why</Th><Th>Decision</Th></tr></thead>
                    <tbody>
                      {o.assistant.reading.recommendations.map((r) => (
                        <Tr key={r.id}>
                          <Td>
                            <span className="font-medium">{r.title}</span>
                            <span className="block text-xs text-fg-muted">{r.kind === 'PROFILE' ? 'Fills the business profile' : r.kind === 'STEP' ? 'Setup step' : 'Note'}</span>
                          </Td>
                          <Td className="text-sm">
                            {r.reason}
                            {r.link && r.status === 'ACCEPTED' ? <> <Link className="text-accent hover:underline" href={`/orgs/${orgId}${r.link}`}>Go there</Link></> : null}
                          </Td>
                          <Td className="whitespace-nowrap">
                            {r.status === 'PENDING' ? (
                              <div className="flex gap-2">
                                <Button size="sm" aria-label={`Accept: ${r.title}`} loading={decide.isPending && decide.variables?.id === r.id && decide.variables.decision === 'ACCEPTED'} onClick={() => decide.mutate({ id: r.id, decision: 'ACCEPTED' })}>{r.kind === 'NOTE' ? 'Noted' : 'Accept'}</Button>
                                <Button size="sm" variant="ghost" aria-label={`Dismiss: ${r.title}`} loading={decide.isPending && decide.variables?.id === r.id && decide.variables.decision === 'DISMISSED'} onClick={() => decide.mutate({ id: r.id, decision: 'DISMISSED' })}>Dismiss</Button>
                              </div>
                            ) : <Badge tone={r.status === 'ACCEPTED' ? 'positive' : 'neutral'}>{r.status === 'ACCEPTED' ? 'Accepted' : 'Dismissed'}</Badge>}
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                  <div className="px-5 pb-4"><ErrorAlert title="The decision was not saved" error={decide.error} /></div>
                </>
              ) : null}
            </Card>
          ) : null}

          <Card className="mb-4">
            <CardHeader title="Business profile" description="Used for the suggestions below and kept with your organisation's records." />
            <div className="grid gap-4 px-5 py-4 md:grid-cols-2">
              <Field label="Industry">
                {(p) => (
                  <Select {...p} value={form.industry ?? ''} onChange={set('industry')} disabled={!o.canManage}>
                    <option value="">Choose…</option>
                    {o.options.industries.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                  </Select>
                )}
              </Field>
              <Field label="Business size">
                {(p) => (
                  <Select {...p} value={form.size ?? ''} onChange={set('size')} disabled={!o.canManage}>
                    <option value="">Choose…</option>
                    {o.options.sizes.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                  </Select>
                )}
              </Field>
              <Field label="Accounting framework" hint="The standards your financial statements follow. Confirm with your accountant.">
                {(p) => (
                  <Select {...p} value={form.framework ?? ''} onChange={set('framework')} disabled={!o.canManage}>
                    <option value="">Choose…</option>
                    {o.options.frameworks.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                  </Select>
                )}
              </Field>
              <Field label="AI agents" hint={o.options.aiPreferences.find((a) => a.id === form.aiPreference)?.what ?? 'Every AI action still needs a person to approve it.'}>
                {(p) => (
                  <Select {...p} value={form.aiPreference ?? ''} onChange={set('aiPreference')} disabled={!o.canManage}>
                    <option value="">Choose…</option>
                    {o.options.aiPreferences.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                  </Select>
                )}
              </Field>
            </div>
            <div className="border-t border-line px-5 py-4">
              <p className="text-sm font-medium">Suggested for you</p>
              <ul className="mt-1 list-disc pl-5 text-sm text-fg-muted">
                {suggestion!.reasons.map((r) => <li key={r}>{r}</li>)}
              </ul>
              {o.canManage ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setForm((f) => ({ ...f, framework: suggestion!.framework, aiPreference: suggestion!.aiPreference }));
                      setSaved(false);
                    }}
                  >
                    Use the suggestions
                  </Button>
                  <Button disabled={!complete} loading={save.isPending} onClick={() => save.mutate()}>Save profile</Button>
                  {saved ? <span className="text-sm text-positive" role="status">Profile saved.</span> : null}
                </div>
              ) : <p className="mt-2 text-sm text-fg-muted">An owner or admin can change the profile.</p>}
              <ErrorAlert title="The profile was not saved" error={save.error} />
            </div>
          </Card>

          <Card className="mb-4">
            <CardHeader title="Setup checklist" description={`${done} of ${o.checks.length} done. Worked out from your books each time you open this page.`} />
            <Table aria-label="Setup checklist">
              <thead><tr><Th>Step</Th><Th>Status</Th><Th>Details</Th><Th /></tr></thead>
              <tbody>
                {o.checks.map((c) => (
                  <Tr key={c.id}>
                    <Td className="whitespace-nowrap">
                      <span className="font-medium">{c.title}</span>
                      <span className="block text-xs text-fg-muted">{c.required ? 'Required' : 'Optional'}</span>
                    </Td>
                    <Td>{c.status === 'DONE' ? <Badge tone="positive">Done</Badge> : <Badge tone={c.required ? 'warning' : 'neutral'}>To do</Badge>}</Td>
                    <Td className="text-sm">{c.detail}</Td>
                    <Td className="whitespace-nowrap">{c.status === 'TODO' && c.link !== '/setup' ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}${c.link}`}>Go there</Link> : null}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>

          <Card>
            <CardHeader title="Activation" description="Activating records that setup was reviewed and the books are ready for day-to-day use. It is recorded in the audit trail." />
            <div className="px-5 py-4">
              {o.activation.activatedAt ? (
                <Alert tone="positive" title="Organisation active">Activated on {dateTime(o.activation.activatedAt)}.</Alert>
              ) : o.activation.ok ? (
                o.canManage ? <Button loading={activate.isPending} onClick={() => activate.mutate()}>Activate organisation</Button> : <p className="text-sm text-fg-muted">Every required step is done; an owner or admin can activate the organisation.</p>
              ) : (
                <Alert tone="warning" title="Finish the required steps first">{o.activation.missing.join(', ')}.</Alert>
              )}
              <ErrorAlert title="The organisation was not activated" error={activate.error} />
            </div>
          </Card>
        </>
      ) : null}
    </>
  );
}

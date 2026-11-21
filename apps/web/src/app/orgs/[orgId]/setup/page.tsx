'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
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

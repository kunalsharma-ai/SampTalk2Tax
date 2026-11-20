'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import { FormEvent, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';

const ROLES = ['ADMIN', 'ACCOUNTANT', 'APPROVER', 'VIEWER', 'EMPLOYEE'] as const;
const ROLE_NAMES: Record<string, string> = { ADMIN: 'Admin', ACCOUNTANT: 'Accountant', APPROVER: 'Approver', VIEWER: 'Viewer', EMPLOYEE: 'Employee' };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type Rule = {
  id: string;
  name: string;
  roles: string[];
  userIds: string[];
  people: { id: string; name: string }[];
  appliesTo: 'ALL' | 'CHANGES';
  networks: string[];
  days: number[];
  startMinute: number | null;
  endMinute: number | null;
  active: boolean;
  refusesYou: { access: string | null; changes: string | null };
};
type Overview = { rules: Rule[]; you: { ip: string | null; role: string; localTime: string; day: string; timeZone: string }; members: { id: string; name: string; role: string }[] };
type Body = Omit<Rule, 'id' | 'people' | 'refusesYou'>;

const toTime = (m: number | null) => (m === null ? '' : `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
const fromTime = (t: string) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);
const EMPTY: Body = { name: '', roles: [], userIds: [], appliesTo: 'ALL', networks: [], days: [], startMinute: null, endMinute: null, active: true };

/** Access rules (SEC-004): where and when roles and people may open the books, on top of their role. */
export default function AccessRulesPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/access-rules`;
  const q = useQuery({ queryKey: ['access-rules', orgId], queryFn: () => api<Overview>(base) });
  const done = () => qc.invalidateQueries({ queryKey: ['access-rules', orgId] });
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<Body>(EMPTY);
  const [networks, setNetworks] = useState('');
  const save = useMutation({
    mutationFn: (b: Body) => api<Rule>(editing && editing !== 'new' ? `${base}/${editing}` : base, { method: editing && editing !== 'new' ? 'PUT' : 'POST', body: b }),
    onSuccess: () => {
      setEditing(null);
      done();
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => api(`${base}/${id}`, { method: 'DELETE' }), onSuccess: done });
  if (!org) return null;
  const o = q.data;
  const manage = org.role === 'OWNER' || org.role === 'ADMIN';
  const open = (r?: Rule) => {
    save.reset();
    setEditing(r?.id ?? 'new');
    setForm(r ? { name: r.name, roles: r.roles, userIds: r.userIds, appliesTo: r.appliesTo, networks: r.networks, days: r.days, startMinute: r.startMinute, endMinute: r.endMinute, active: r.active } : EMPTY);
    setNetworks(r ? r.networks.join(', ') : '');
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ ...form, networks: networks.split(/[\s,]+/).filter(Boolean) });
  };
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <>
      <PageHeader
        title="Access rules"
        description="Roles decide what each person may do. Access rules add where and when: for the roles or people a rule names, the books open only from the networks, days and hours you list, or only changes are limited. Owners are never bound, so you cannot lock yourselves out."
        actions={manage && editing === null ? <Button onClick={() => open()}>New rule</Button> : null}
      />
      <ErrorAlert title="Could not load access rules" error={q.error} />
      <ErrorAlert title="The rule was not saved" error={save.error} />
      <ErrorAlert title="The rule was not deleted" error={remove.error} />
      {o ? (
        <>
          <Card className="mb-4 p-4" role="region" aria-label="Your access now">
            <CardHeader title="Your access now" description="What the rules see of this request." />
            <p className="mt-2 text-sm">
              Address <code>{o.you.ip ?? 'unknown'}</code> · {o.you.day} {o.you.localTime} ({o.you.timeZone}) · {ROLE_NAMES[o.you.role] ?? 'Owner'}
            </p>
          </Card>
          {editing !== null ? (
            <Card className="mb-4 p-4" role="region" aria-label="Access rule">
              <CardHeader title={editing === 'new' ? 'New access rule' : 'Edit access rule'} description="Give at least one condition. Every active rule that names a person must be met." />
              <form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={submit}>
                <Field label="Name">{(p) => <Input {...p} value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} required />}</Field>
                <Field label="Applies to">
                  {(p) => (
                    <Select {...p} value={form.appliesTo} onChange={(e) => setForm({ ...form, appliesTo: e.target.value as Body['appliesTo'] })}>
                      <option value="ALL">Everything: reading and changing</option>
                      <option value="CHANGES">Changes only: reading stays open</option>
                    </Select>
                  )}
                </Field>
                <fieldset className="sm:col-span-2">
                  <legend className="text-sm font-medium">Roles</legend>
                  <div className="mt-1 flex flex-wrap gap-3">
                    {ROLES.map((r) => (
                      <label key={r} className="inline-flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={form.roles.includes(r)} onChange={() => setForm({ ...form, roles: toggle(form.roles, r) })} /> {ROLE_NAMES[r]}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset className="sm:col-span-2">
                  <legend className="text-sm font-medium">People</legend>
                  <div className="mt-1 flex flex-wrap gap-3">
                    {o.members.length ? o.members.map((m) => (
                      <label key={m.id} className="inline-flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={form.userIds.includes(m.id)} onChange={() => setForm({ ...form, userIds: toggle(form.userIds, m.id) })} /> {m.name} ({ROLE_NAMES[m.role] ?? m.role})
                      </label>
                    )) : <span className="text-sm text-fg-muted">No members besides owners.</span>}
                  </div>
                </fieldset>
                <Field label="Networks" hint="IP addresses or ranges, such as 203.0.113.0/24; empty means any network">
                  {(p) => <Input {...p} value={networks} placeholder="203.0.113.0/24, 2001:db8::/32" onChange={(e) => setNetworks(e.target.value)} />}
                </Field>
                <fieldset>
                  <legend className="text-sm font-medium">Days</legend>
                  <div className="mt-1 flex flex-wrap gap-3">
                    {DAYS.map((d, i) => (
                      <label key={d} className="inline-flex items-center gap-1 text-sm">
                        <input type="checkbox" checked={form.days.includes(i)} onChange={() => setForm({ ...form, days: toggle(form.days, i) })} /> {d}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <Field label="From" hint={`Organisation time (${o.you.timeZone}); empty for any hour`}>
                  {(p) => <Input {...p} type="time" value={toTime(form.startMinute)} onChange={(e) => setForm({ ...form, startMinute: fromTime(e.target.value) })} />}
                </Field>
                <Field label="Until" hint="A window past midnight, such as 22:00 to 06:00, works">
                  {(p) => <Input {...p} type="time" value={toTime(form.endMinute === 1440 ? 0 : form.endMinute)} onChange={(e) => setForm({ ...form, endMinute: e.target.value === '00:00' ? 1440 : fromTime(e.target.value) })} />}
                </Field>
                <label className="inline-flex items-center gap-2 text-sm sm:col-span-2">
                  <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> The rule is on
                </label>
                <div className="flex gap-2 sm:col-span-2">
                  <Button type="submit" loading={save.isPending}>Save rule</Button>
                  <Button type="button" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
                </div>
              </form>
            </Card>
          ) : null}
          <Card>
            <CardHeader title="Rules in this organisation" description="Each change is in the audit trail. A request a rule refuses gets a message naming the rule." />
            {o.rules.length ? (
              <Table aria-label="Access rules">
                <thead><tr><Th>Rule</Th><Th>Who</Th><Th>Conditions</Th><Th>State</Th><Th /></tr></thead>
                <tbody>
                  {o.rules.map((r) => (
                    <Tr key={r.id}>
                      <Td>
                        <div className="font-medium">{r.name}</div>
                        <div className="text-xs text-fg-muted">{r.appliesTo === 'CHANGES' ? 'Changes only' : 'Everything'}</div>
                      </Td>
                      <Td className="text-sm">{[...r.roles.map((x) => `${ROLE_NAMES[x]}s`), ...r.people.map((p) => p.name)].join(', ')}</Td>
                      <Td className="text-sm">
                        {[r.networks.length ? `From ${r.networks.join(', ')}` : null, r.days.length ? r.days.map((d) => DAYS[d]).join(' ') : null, r.startMinute !== null ? `${toTime(r.startMinute)} to ${toTime(r.endMinute)}` : null].filter(Boolean).join(' · ')}
                      </Td>
                      <Td>
                        {r.active ? <Badge tone="positive">On</Badge> : <Badge>Off</Badge>}
                        {r.refusesYou.access ? <div className="mt-1"><Badge tone="warning">Refuses you now</Badge></div> : null}
                      </Td>
                      <Td>
                        {manage ? (
                          <div className="flex gap-2">
                            <Button size="sm" variant="secondary" onClick={() => open(r)}>Edit</Button>
                            <Button size="sm" variant="secondary" loading={remove.isPending && remove.variables === r.id} onClick={() => remove.mutate(r.id)}>Delete</Button>
                          </div>
                        ) : null}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="No access rules">Everyone can open the books from anywhere, at any time their role allows. Add a rule to limit some roles or people to your office network or working hours.</EmptyState>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}

'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { BacktestResults, TestResults } from '@/components/policies/test-results';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useMe, useOrg } from '@/lib/org';
import { EVENT, STATUS, type Backtest, type PolicyDetail } from '@/lib/policies';
import { can } from '@/lib/types';

/** A policy: its words, its rules described in words with the workflows that run them, its tests, approval and history. */
export default function PolicyPage() {
  const { org, orgId } = useOrg();
  const me = useMe();
  const { policyId } = useParams<{ policyId: string }>();
  const qc = useQueryClient();
  const key = ['policy', orgId, policyId];
  const q = useQuery({ queryKey: key, queryFn: () => api<PolicyDetail>(`/v1/orgs/${orgId}/policies/${policyId}`), enabled: !!org });
  const [note, setNote] = useState('');
  const done = (p: PolicyDetail) => {
    qc.setQueryData(key, p);
    void qc.invalidateQueries({ queryKey: ['policies', orgId] });
    void qc.invalidateQueries({ queryKey: ['workflows', orgId] });
    setNote('');
  };
  const approve = useMutation({ mutationFn: (version: number) => api<PolicyDetail>(`/v1/orgs/${orgId}/policies/${policyId}/approve`, { method: 'POST', body: { version, note: note || null } }), onSuccess: done });
  const retire = useMutation({ mutationFn: () => api<PolicyDetail>(`/v1/orgs/${orgId}/policies/${policyId}/retire`, { method: 'POST', body: { note: note || null } }), onSuccess: done });
  const backtest = useMutation({ mutationFn: () => api<Backtest>(`/v1/orgs/${orgId}/policies/${policyId}/backtest`) });
  if (!org) return null;
  const p = q.data;
  const approver = can(org.role, 'workflows.manage');
  const writer = can(org.role, 'policies.manage');
  const name = (id: string | null) => (id ? (p?.people[id] ?? 'Former member') : '');
  const selfEdited = !!p && p.updatedById === me.data?.user.id;
  return (
    <>
      <PageHeader
        title={p ? `${p.number} · ${p.name}` : 'Policy'}
        description={p ? <Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Badge> : undefined}
        actions={
          <>
            {writer && p ? <Link className="rounded-[var(--t2t-radius-md)] border border-line px-3 py-2 text-sm font-medium hover:bg-surface-hover" href={`/orgs/${orgId}/governance/policies/${p.id}/edit`}>Edit</Link> : null}
            <Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/governance/policies`}>Policy studio</Link>
          </>
        }
      />
      <ErrorAlert title="Could not load the policy" error={q.error} />
      {p ? (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="The policy" description={`Version ${p.version}, last changed by ${name(p.updatedById)} on ${dateTime(p.updatedAt)}.${p.approvedAt ? ` Version ${p.activeVersion ?? p.version} approved by ${name(p.approvedById)} on ${dateTime(p.approvedAt)}.` : ''}`} />
            <p className="whitespace-pre-line px-5 pb-5 text-sm" data-testid="statement">{p.statement}</p>
          </Card>

          {p.status !== 'ACTIVE' && approver ? (
            <Card>
              <CardHeader title={p.status === 'RETIRED' ? 'Bring back' : `Approve version ${p.version}`} description="Approving turns each rule into a running automation (or updates the one it already has). Rules the policy no longer has are turned off." />
              <div className="flex flex-col gap-3 p-5">
                {!p.testsPassing ? <Alert tone="warning" title="Tests are failing">Fix the rules or the tests before this version can be approved.</Alert> : null}
                {selfEdited ? <Alert tone="neutral" title="Someone else must approve">You made the last change, so another owner or admin approves it.</Alert> : null}
                <Field label="Approval note (optional)">{(f) => <Input {...f} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />}</Field>
                <ErrorAlert title="Not approved" error={approve.error} />
                <div>
                  <Button disabled={!p.testsPassing || selfEdited} loading={approve.isPending} onClick={() => approve.mutate(p.version)}>
                    Approve and turn on
                  </Button>
                </div>
              </div>
            </Card>
          ) : null}
          {p.status === 'DRAFT' && !approver ? <Alert tone="neutral" title="Waiting for approval">An owner or admin approves policies; then the rules run.</Alert> : null}

          <Card>
            <CardHeader title="Rules" description="Each rule in plain words, and the automation that runs it." />
            <Table aria-label="Rules">
              <thead>
                <tr>
                  <Th>Rule</Th>
                  <Th>What it does</Th>
                  <Th>Automation</Th>
                </tr>
              </thead>
              <tbody>
                {p.rules.map((r, i) => {
                  const w = p.workflows.find((x) => x.rule === i + 1);
                  return (
                    <Tr key={i}>
                      <Td className="font-medium">{i + 1}. {r.name}</Td>
                      <Td>{r.description}</Td>
                      <Td>
                        {w ? (
                          <>
                            <Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/automations/${w.id}`}>{w.name ?? 'Automation'}</Link>
                            <p className="text-xs text-fg-muted">{w.enabled ? 'On' : 'Off'}{w.currentVersion ? `, version ${w.currentVersion}` : ''}</p>
                          </>
                        ) : (
                          <span className="text-xs text-fg-muted">Created on approval</span>
                        )}
                      </Td>
                    </Tr>
                  );
                })}
                {p.workflows.filter((w) => w.rule > p.rules.length).map((w) => (
                  <Tr key={w.id}>
                    <Td className="text-fg-muted">Removed rule</Td>
                    <Td className="text-xs text-fg-muted">No longer part of the policy.</Td>
                    <Td><Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/automations/${w.id}`}>{w.name ?? 'Automation'}</Link><p className="text-xs text-fg-muted">{w.enabled ? 'On' : 'Off'}</p></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>

          <Card>
            <CardHeader title="Tests" actions={<Button variant="secondary" size="sm" loading={backtest.isPending} onClick={() => backtest.mutate()}>Back-test on the last 90 days</Button>} />
            <TestResults results={p.testResults} />
            <ErrorAlert title="Could not back-test the rules" error={backtest.error} />
            {backtest.data ? <BacktestResults b={backtest.data} ruleNames={p.rules.map((r) => r.name)} /> : null}
          </Card>

          <Card>
            <CardHeader title="History" description="Every version is kept as it was and cannot be changed." />
            <Table aria-label="History">
              <thead>
                <tr>
                  <Th>Version</Th>
                  <Th>What happened</Th>
                  <Th>Who</Th>
                  <Th>When</Th>
                  <Th>Note</Th>
                </tr>
              </thead>
              <tbody>
                {p.versions.map((v, i) => (
                  <Tr key={i}>
                    <Td>v{v.version}</Td>
                    <Td>{EVENT[v.event]}{v.event === 'CREATED' || v.event === 'EDITED' ? ` · ${v.rules.length} rule${v.rules.length === 1 ? '' : 's'}, ${v.tests.length} test${v.tests.length === 1 ? '' : 's'}` : ''}</Td>
                    <Td>{name(v.createdById)}</Td>
                    <Td className="text-xs">{dateTime(v.createdAt)}</Td>
                    <Td className="text-xs text-fg-muted">{v.note ?? ''}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>

          {p.status !== 'RETIRED' && approver ? (
            <Card>
              <CardHeader title="Retire" description="Turns off every automation the policy runs. Its history stays." />
              <div className="flex flex-col gap-3 p-5">
                <ErrorAlert title="Not retired" error={retire.error} />
                <div>
                  <Button variant="ghost" loading={retire.isPending} onClick={() => confirm(`Retire ${p.number}? Its automations are turned off.`) && retire.mutate()}>
                    Retire policy
                  </Button>
                </div>
              </div>
            </Card>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-fg-muted">Loading…</p>
      )}
    </>
  );
}

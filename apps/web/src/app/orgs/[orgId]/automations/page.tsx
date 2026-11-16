'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, EmptyState, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { ago } from '@/lib/alerts';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';
import { RUN_STATUS, type WorkflowSummary } from '@/lib/workflows';

export default function AutomationsPage() {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const allowed = can(org?.role, 'workflows.manage');
  const q = useQuery({ queryKey: ['workflows', orgId], queryFn: () => api<WorkflowSummary[]>(`/v1/orgs/${orgId}/workflows`), enabled: !!org && allowed });
  if (!org) return null;
  const base = `/orgs/${orgId}/automations`;
  return (
    <>
      <PageHeader
        title="Automations"
        description="Workflows that act when something happens in the books: give someone a task, or tell another system through a signed webhook. A workflow acts only on what happens after it is turned on, and every run is kept in its log."
        actions={allowed ? <Button onClick={() => router.push(`${base}/new`)}>New workflow</Button> : null}
      />
      {!allowed ? (
        <Card><EmptyState title="Only owners and admins set up automations">Tasks that automations give you are under My tasks.</EmptyState></Card>
      ) : (
        <>
          <ErrorAlert title="Could not load workflows" error={q.error} />
          {q.data && !q.data.length ? (
            <Card>
              <EmptyState title="No workflows yet" action={<Button onClick={() => router.push(`${base}/new`)}>New workflow</Button>}>
                For example: when a bill over ₹1,00,000 is posted, give the approvers a task to check it; when a customer pays, tell the CRM.
              </EmptyState>
            </Card>
          ) : null}
          {q.data?.length ? (
            <Card>
              <Table aria-label="Workflows">
                <thead>
                  <tr><Th>Workflow</Th><Th>When</Th><Th>Does</Th><Th>Last run</Th><Th numeric>Last 30 days</Th><Th>State</Th></tr>
                </thead>
                <tbody>
                  {q.data.map((w) => (
                    <Tr key={w.id}>
                      <Td>
                        <Link className="font-medium text-accent hover:underline" href={`${base}/${w.id}`}>{w.name}</Link>
                        <p className="text-xs text-fg-muted">Version {w.version}{w.description ? ` · ${w.description}` : ''}</p>
                      </Td>
                      <Td>{w.triggerLabel}{w.conditions ? <span className="text-fg-muted"> · {w.conditions} condition{w.conditions === 1 ? '' : 's'}</span> : null}</Td>
                      <Td>{summariseActions(w.actions)}</Td>
                      <Td>{w.lastRun ? <span className="flex items-center gap-2"><Badge tone={RUN_STATUS[w.lastRun.status].tone}>{RUN_STATUS[w.lastRun.status].label}</Badge><span className="text-xs text-fg-muted">{ago(w.lastRun.at)}</span></span> : <span className="text-fg-muted">Not yet</span>}</Td>
                      <Td numeric className="text-xs"><span className="num">{w.last30Days.acted}</span> acted · <span className="num">{w.last30Days.skipped}</span> skipped{w.last30Days.failed ? <> · <span className="num text-negative">{w.last30Days.failed} failed</span></> : null}</Td>
                      <Td>{w.enabled ? <Badge tone="positive">On</Badge> : <Badge>Off</Badge>}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          ) : null}
        </>
      )}
    </>
  );
}

function summariseActions(types: ('CREATE_TASK' | 'WEBHOOK')[]) {
  const tasks = types.filter((t) => t === 'CREATE_TASK').length;
  const hooks = types.length - tasks;
  return [tasks ? `${tasks} task${tasks === 1 ? '' : 's'}` : null, hooks ? `${hooks} webhook${hooks === 1 ? '' : 's'}` : null].filter(Boolean).join(', ');
}

'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Table, Td, Th, Tr } from '@talk2tax/ui';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useOrg, usePeriods } from '@/lib/org';
import { can, type Period } from '@/lib/types';

export default function PeriodsPage() {
  const { org, orgId } = useOrg();
  const periods = usePeriods();
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (p: Period) => api<Period>(`/v1/orgs/${orgId}/periods/${p.id}/${p.status === 'OPEN' ? 'lock' : 'unlock'}`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['periods', orgId] }),
  });
  const years = [...new Set((periods.data ?? []).map((p) => p.fiscalYear))].sort();
  const nextYear = years.length ? years[years.length - 1] + 1 : null;
  const addYear = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/periods/fiscal-years`, { method: 'POST', body: { fiscalYear: nextYear } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['periods', orgId] }),
  });
  if (!org) return null;
  const t = today();
  const err = toggle.error ?? addYear.error;

  return (
    <>
      <PageHeader
        title="Fiscal periods"
        description="Journals can only be posted into open periods. Locking a period waits for any posting in progress and then blocks new ones."
        actions={can(org.role, 'periods.manage') && nextYear ? <Button variant="secondary" loading={addYear.isPending} onClick={() => addYear.mutate()}>Add FY{nextYear}</Button> : null}
      />
      {err ? <div className="mb-4"><Alert title="Action failed">{err instanceof ApiError ? err.message : 'Try again.'}</Alert></div> : null}
      <div className="flex flex-col gap-6">
        {years.map((y) => (
          <Card key={y}>
            <CardHeader title={`Fiscal year ${y}`} />
            <Table>
              <thead>
                <tr>
                  <Th>Period</Th>
                  <Th>From</Th>
                  <Th>To</Th>
                  <Th>Status</Th>
                  <Th><span className="sr-only">Actions</span></Th>
                </tr>
              </thead>
              <tbody>
                {(periods.data ?? []).filter((p) => p.fiscalYear === y).map((p) => {
                  const current = p.startDate <= t && t <= p.endDate;
                  return (
                    <Tr key={p.id}>
                      <Td>
                        {p.name} {current ? <Badge tone="accent" className="ml-2">Current</Badge> : null}
                      </Td>
                      <Td>{date(p.startDate)}</Td>
                      <Td>{date(p.endDate)}</Td>
                      <Td>{p.status === 'OPEN' ? <Badge tone="positive">Open</Badge> : p.status === 'LOCKED' ? <Badge tone="warning">Locked</Badge> : <Badge>Closed</Badge>}</Td>
                      <Td className="text-right">
                        {can(org.role, 'periods.lock') && p.status !== 'CLOSED' ? (
                          <Button variant={p.status === 'OPEN' ? 'secondary' : 'ghost'} size="sm" loading={toggle.isPending && toggle.variables?.id === p.id} onClick={() => toggle.mutate(p)}>
                            {p.status === 'OPEN' ? 'Lock' : 'Unlock'}
                          </Button>
                        ) : null}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </Card>
        ))}
      </div>
    </>
  );
}

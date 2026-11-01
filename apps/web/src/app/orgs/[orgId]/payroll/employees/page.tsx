'use client';
import { Badge, Button, Card, EmptyState, Table, Td, Th } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Money } from '@/components/money';
import { EmployeeDialog } from '@/components/payroll/employee-dialog';
import { PageHeader } from '@/components/shell';
import { date } from '@/lib/format';
import { useEmployees, useGstRegistration, useOrg, usePayrollSettings } from '@/lib/org';
import { can } from '@/lib/types';

export default function EmployeesPage() {
  const { org, orgId } = useOrg();
  const employees = useEmployees();
  const settings = usePayrollSettings();
  const gst = useGstRegistration();
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  if (!org) return null;
  const canManage = can(org.role, 'payroll.manage');
  const rows = employees.data ?? [];
  const defaultState = gst.data?.registered ? gst.data.stateCode : '';
  return (
    <>
      <PageHeader
        title="Employees"
        description="People on the payroll, their salary and what decides their PF, ESI, professional tax and TDS."
        actions={canManage && settings.data?.configured ? <Button onClick={() => setAdding(true)}>New employee</Button> : null}
      />
      {settings.data && !settings.data.configured ? (
        <Card><EmptyState title="Payroll is not set up" action={<Link href={`/orgs/${orgId}/settings/payroll`}><Button>Set up payroll</Button></Link>}>Choose the accounts pay runs post to, then add employees.</EmptyState></Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <Table className="min-w-[860px]">
              <thead><tr><Th>Code</Th><Th>Name</Th><Th>PAN</Th><Th>Joined</Th><Th>Status</Th><Th>Salary from</Th><Th numeric>Monthly gross</Th></tr></thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} className="cursor-pointer hover:bg-surface-hover" onClick={() => router.push(`/orgs/${orgId}/payroll/employees/${e.id}`)}>
                    <Td className="num">{e.code}</Td>
                    <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/payroll/employees/${e.id}`} onClick={(ev) => ev.stopPropagation()}>{e.name}</Link></Td>
                    <Td className="num text-sm">{e.pan ?? <span className="text-warning">No PAN</span>}</Td>
                    <Td className="whitespace-nowrap">{date(e.dateOfJoining)}</Td>
                    <Td>{e.status === 'LEFT' ? <Badge>Left {date(e.dateOfLeaving!)}</Badge> : e.status === 'JOINING' ? <Badge tone="accent">Joining</Badge> : <Badge tone="positive">Active</Badge>}</Td>
                    <Td className="whitespace-nowrap">{e.currentSalary ? date(e.currentSalary.effectiveFrom) : '—'}</Td>
                    <Td numeric>{e.currentSalary ? <Money value={e.currentSalary.monthlyGross} currency="INR" /> : '—'}</Td>
                  </tr>
                ))}
                {rows.length === 0 && !employees.isLoading ? <tr><Td colSpan={7} className="py-8 text-center text-fg-muted">No employees yet.</Td></tr> : null}
              </tbody>
            </Table>
          </div>
        </Card>
      )}
      {adding ? <EmployeeDialog open employee={null} defaultState={defaultState} onClose={(e) => { setAdding(false); if (e) router.push(`/orgs/${orgId}/payroll/employees/${e.id}`); }} /> : null}
    </>
  );
}

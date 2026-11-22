'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { type Trip, type TripRow, TRIP_STATUS_LABEL, TRIP_STATUS_TONE } from '@/components/expenses/trips';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

const AMOUNT = /^\d{1,13}(\.\d{1,2})?$/;
const EMPTY = { purpose: '', destination: '', startDate: '', endDate: '', transport: '', lodging: '', meals: '', other: '' };

/** Business trips (EXP-007): request a trip with an estimate, and every trip you can see. */
export default function TripsPage() {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['expense-trips', orgId], queryFn: () => api<TripRow[]>(`/v1/orgs/${orgId}/expense-trips`) });
  const [f, setF] = useState(EMPTY);
  const create = useMutation({
    mutationFn: () =>
      api<Trip>(`/v1/orgs/${orgId}/expense-trips`, {
        method: 'POST',
        body: { purpose: f.purpose, destination: f.destination, startDate: f.startDate, endDate: f.endDate, estimate: { transport: f.transport || '0', lodging: f.lodging || '0', meals: f.meals || '0', other: f.other || '0' } },
      }),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: ['expense-trips', orgId] });
      router.push(`/orgs/${orgId}/expenses/trips/${t.id}`);
    },
  });
  if (!org) return null;
  const amountsOk = (['transport', 'lodging', 'meals', 'other'] as const).every((k) => !f[k] || AMOUNT.test(f[k]));
  const ready = f.purpose.trim() && f.destination.trim() && f.startDate && f.endDate && f.endDate >= f.startDate && amountsOk;
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <>
      <PageHeader title="Business trips" description="Request a trip with its purpose, place, dates and an estimate before you travel. Someone else approves it; then link your expense claims to the trip to see what it cost against the estimate." />
      {can(org.role, 'expenses.submit') ? (
        <Card className="mb-4">
          <CardHeader title="Request a trip" description="The estimate is what you expect to spend, before tax is split out. Leave a part blank for nothing." />
          <form
            className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <div className="sm:col-span-2"><Field label="Purpose">{(p) => <Input {...p} maxLength={200} value={f.purpose} onChange={set('purpose')} />}</Field></div>
            <div className="sm:col-span-2"><Field label="Destination">{(p) => <Input {...p} maxLength={120} value={f.destination} onChange={set('destination')} />}</Field></div>
            <Field label="Leaving on">{(p) => <Input {...p} type="date" value={f.startDate} onChange={set('startDate')} />}</Field>
            <Field label="Back on">{(p) => <Input {...p} type="date" value={f.endDate} onChange={set('endDate')} />}</Field>
            <div className="hidden lg:block lg:col-span-2" />
            <Field label="Travel and transport">{(p) => <Input {...p} inputMode="decimal" value={f.transport} onChange={set('transport')} />}</Field>
            <Field label="Hotels and lodging">{(p) => <Input {...p} inputMode="decimal" value={f.lodging} onChange={set('lodging')} />}</Field>
            <Field label="Meals and daily allowance">{(p) => <Input {...p} inputMode="decimal" value={f.meals} onChange={set('meals')} />}</Field>
            <Field label="Other costs">{(p) => <Input {...p} inputMode="decimal" value={f.other} onChange={set('other')} />}</Field>
            <div className="flex items-center justify-end gap-3 sm:col-span-2 lg:col-span-4">
              <ErrorAlert title="Trip not requested" error={create.error} />
              <Button type="submit" disabled={!ready} loading={create.isPending}>Request trip</Button>
            </div>
          </form>
        </Card>
      ) : null}
      <ErrorAlert title="Could not load trips" error={q.error} />
      <Card>
        <CardHeader title="Trips" description={can(org.role, 'expenses.read') ? 'Everyone\'s trips, newest first.' : 'Your trips, newest first.'} />
        {q.data && !q.data.length ? (
          <EmptyState title="No trips yet">Request a trip before you travel.</EmptyState>
        ) : q.data ? (
          <Table aria-label="Trips">
            <thead><Tr><Th>Trip</Th><Th>Traveller</Th><Th>Purpose</Th><Th>Destination</Th><Th>Dates</Th><Th>Status</Th><Th numeric>Estimate</Th><Th numeric>Claims</Th></Tr></thead>
            <tbody>
              {q.data.map((t) => (
                <Tr key={t.id}>
                  <Td className="whitespace-nowrap"><Link className="text-accent hover:underline" href={`/orgs/${orgId}/expenses/trips/${t.id}`}>{t.reference}</Link></Td>
                  <Td>{t.traveller}</Td>
                  <Td>{t.purpose}</Td>
                  <Td>{t.destination}</Td>
                  <Td className="whitespace-nowrap">{date(t.startDate)} to {date(t.endDate)}</Td>
                  <Td><Badge tone={TRIP_STATUS_TONE[t.status]}>{TRIP_STATUS_LABEL[t.status]}</Badge></Td>
                  <Td numeric><Money value={t.estimate} currency={org.functionalCurrency} /></Td>
                  <Td numeric>{t.claims}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : null}
      </Card>
    </>
  );
}

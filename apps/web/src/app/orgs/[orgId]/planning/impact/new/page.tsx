'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ImpactBuilder } from '@/components/impact/impact-builder';
import { PageHeader } from '@/components/shell';
import type { Lever } from '@/lib/impact';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

const LEVERS = new Set(['NEW_CUSTOMER', 'LOSE_CUSTOMER', 'PRICE_CHANGE', 'SALES_HIRES', 'CUSTOMER_TERMS', 'HIRE', 'PAY_RISE', 'HEADCOUNT_REDUCTION', 'SUPPLIER_PRICE', 'SUPPLIER_TERMS', 'NEW_SITE', 'EQUIPMENT', 'RUNNING_COSTS']);

/** A new business impact assessment, empty or started from one business change. */
export default function NewImpactPage() {
  return (
    <Suspense fallback={null}>
      <NewImpact />
    </Suspense>
  );
}

function NewImpact() {
  const { org, orgId } = useOrg();
  const sp = useSearchParams();
  const lever = sp.get('lever');
  if (!org) return null;
  return (
    <>
      <PageHeader
        title="New impact assessment"
        description="Combine changes from sales, people, procurement and operations, assess them against the posted books, and save the assessment to come back to."
        actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/planning/impact`}>Business impact</Link>}
      />
      <ImpactBuilder orgId={orgId} canManage={can(org.role, 'scenarios.manage')} startLever={lever && LEVERS.has(lever) ? (lever as Lever) : null} init={{ name: '', description: '', baselineMonths: 6, horizonMonths: 12, changes: [] }} />
    </>
  );
}

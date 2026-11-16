'use client';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import type { Org } from '@/lib/types';

/** Sends you to your first organisation, or to onboarding if you have none. */
export default function Home() {
  const router = useRouter();
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: () => api<Org[]>('/v1/orgs') });
  useEffect(() => {
    if (!orgs.data) return;
    const first = orgs.data.find((o) => o.dataRegion?.here !== false) ?? orgs.data[0];
    router.replace(first ? `/orgs/${first.id}` : '/onboarding');
  }, [orgs.data, router]);
  return (
    <main id="main" className="grid min-h-screen place-items-center text-sm text-fg-muted">
      {orgs.error ? 'Could not load your organisations.' : 'Loading your workspace…'}
    </main>
  );
}

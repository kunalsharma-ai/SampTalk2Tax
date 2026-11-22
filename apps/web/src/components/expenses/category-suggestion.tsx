'use client';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@talk2tax/ui';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

export interface CategorySuggestion {
  accountId: string;
  code: string;
  name: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  because: string[];
  score: number;
}

function useDebounced<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const LEVEL = { HIGH: 'likely', MEDIUM: 'possible', LOW: 'a guess' } as const;

/**
 * The likely expense account for a receipt line (EXP-020) or a bill line (AP-020), from how this
 * business booked the same merchant or vendor before and the words used. Shown under the account
 * picker; nothing changes until the person presses Use.
 */
export function CategorySuggestionHint({ orgId, kind, line, merchant, contactId, description, current, onUse }: { orgId: string; kind: 'claim-line' | 'bill-line'; line: number; merchant?: string; contactId?: string; description: string; current: string; onUse: (accountId: string) => void }) {
  const body = useDebounced(kind === 'claim-line' ? { merchant: merchant?.trim() || null, description: description.trim() || null } : { contactId: contactId || null, description: description.trim() || null });
  const asked = Object.values(body).some(Boolean);
  const q = useQuery({
    queryKey: ['category-suggestion', orgId, kind, body],
    queryFn: () => api<{ suggestions: CategorySuggestion[] }>(`/v1/orgs/${orgId}/expense-categorization/${kind}`, { method: 'POST', body }),
    enabled: asked,
    staleTime: 60_000,
    retry: false,
  });
  const top = asked ? q.data?.suggestions[0] : undefined;
  if (!top || top.accountId === current) return null;
  return (
    <div className="mt-1 text-xs text-fg-muted" role="status" aria-label={`Suggested account for line ${line}`}>
      <span>
        Suggested: <span className="font-medium text-fg">{top.code} · {top.name}</span> ({LEVEL[top.confidence]})
      </span>{' '}
      <Button type="button" variant="ghost" size="sm" aria-label={`Use the suggested account for line ${line}`} onClick={() => onUse(top.accountId)}>Use</Button>
      <span className="block">{top.because.join('; ')}</span>
    </div>
  );
}

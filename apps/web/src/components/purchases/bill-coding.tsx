'use client';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@talk2tax/ui';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { CategorySuggestion } from '@/components/expenses/category-suggestion';

interface CodedLine {
  lineNo: number;
  account: CategorySuggestion | null;
  taxRateId: string | null;
  departmentId: string | null;
  projectId: string | null;
  because: string[];
}
export interface CodingPatch {
  accountId?: string;
  taxRateId?: string;
  departmentId?: string;
  projectId?: string;
}
type Line = { key: number; accountId: string; description: string; taxRateId: string; departmentId: string; projectId: string };

/**
 * Invoice coding (AP-026): fills the blank account, tax, department and project of every line from
 * how this vendor's earlier bills were coded. Only blank fields change, and only to a tax rate the
 * bill can use; the person reviews the lines before saving.
 */
export function BillCodingButton({ orgId, contactId, lines, taxIds, onApply }: { orgId: string; contactId: string; lines: Line[]; taxIds: Set<string>; onApply: (patches: Map<number, CodingPatch>) => void }) {
  const [note, setNote] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () => api<{ vendor: string; vendorLines: number; lines: CodedLine[] }>(`/v1/orgs/${orgId}/expense-categorization/bill-coding`, { method: 'POST', body: { contactId, lines: lines.map((l, i) => ({ lineNo: i + 1, description: l.description.trim() || null })) } }),
    onSuccess: (r) => {
      const patches = new Map<number, CodingPatch>();
      let filled = 0;
      for (const c of r.lines) {
        const l = lines[c.lineNo - 1];
        if (!l) continue;
        const p: CodingPatch = {};
        if (!l.accountId && c.account) p.accountId = c.account.accountId;
        const account = l.accountId || p.accountId;
        // Tax and dimensions follow the account they were suggested for.
        if (account === c.account?.accountId) {
          if (!l.taxRateId && c.taxRateId && taxIds.has(c.taxRateId)) p.taxRateId = c.taxRateId;
          if (!l.departmentId && c.departmentId) p.departmentId = c.departmentId;
          if (!l.projectId && c.projectId) p.projectId = c.projectId;
        }
        if (Object.keys(p).length) {
          patches.set(l.key, p);
          filled++;
        }
      }
      onApply(patches);
      setNote(filled ? `Filled ${filled} ${filled === 1 ? 'line' : 'lines'} from the ${r.vendorLines} lines on earlier bills from ${r.vendor}. Check them before saving.` : r.vendorLines ? 'Nothing to fill: the blank fields have no clear pattern in this vendor\'s earlier bills.' : `${r.vendor} has no posted bills yet to learn from.`);
    },
    onError: (e) => setNote(e instanceof ApiError ? e.message : 'Could not code the lines'),
  });
  if (!contactId) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button type="button" variant="secondary" size="sm" loading={run.isPending} onClick={() => run.mutate()}>Code lines from history</Button>
      {note ? <span role="status" aria-label="Bill coding" className="text-xs text-fg-muted">{note}</span> : null}
    </span>
  );
}

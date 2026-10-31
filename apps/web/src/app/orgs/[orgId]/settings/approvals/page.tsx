'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Dialog, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';
import { can, type ApprovalPolicy, type DocumentKindName } from '@/lib/types';

const LABEL: Record<DocumentKindName, string> = { INVOICE: 'Invoices', CREDIT_NOTE: 'Credit notes', BILL: 'Bills', VENDOR_CREDIT: 'Vendor credits' };

interface Draft {
  kind: DocumentKindName;
  minAmount: string;
  requireDifferentApprover: boolean;
  isActive: boolean;
}

export default function ApprovalRulesPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const q = useQuery({ queryKey: ['approval-policies', orgId], queryFn: () => api<ApprovalPolicy[]>(`/v1/orgs/${orgId}/approval-policies`) });
  const save = useMutation({
    mutationFn: (d: Draft) => api<ApprovalPolicy>(`/v1/orgs/${orgId}/approval-policies/${d.kind}`, { method: 'PUT', body: { minAmount: d.minAmount, requireDifferentApprover: d.requireDifferentApprover, isActive: d.isActive } }),
    onSuccess: async () => {
      setDraft(null);
      for (const k of ['approval-policies', 'approval']) await qc.invalidateQueries({ queryKey: [k, orgId] });
    },
  });
  if (!org) return null;
  const canManage = can(org.role, 'org.manage');
  return (
    <>
      <PageHeader
        title="Approval rules"
        description="Choose which drafts need an approval before they post. A covered draft can only be posted once someone with the Approver, Admin or Owner role approves it, and only for the exact total they approved. The database enforces this, not just this screen."
      />
      <Card>
        <Table>
          <thead><tr><Th>Document type</Th><Th>Rule</Th><Th numeric>Needs approval from</Th><Th>Approver</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
          <tbody>
            {(q.data ?? []).map((p) => (
              <Tr key={p.documentKind}>
                <Td>{LABEL[p.documentKind]}</Td>
                <Td>{p.isActive ? <Badge tone="accent">On</Badge> : <Badge>Off</Badge>}</Td>
                <Td numeric>{p.isActive && p.minAmount ? <Money value={p.minAmount} currency={org.functionalCurrency} /> : <span className="text-fg-muted">—</span>}</Td>
                <Td className="text-fg-muted">{p.isActive ? (p.requireDifferentApprover ? 'Someone other than the preparer' : 'Anyone who can approve') : '—'}</Td>
                <Td className="text-right">
                  {canManage ? (
                    <Button size="sm" variant="ghost" aria-label={`Edit the rule for ${LABEL[p.documentKind].toLowerCase()}`} onClick={() => { save.reset(); setDraft({ kind: p.documentKind, minAmount: p.minAmount ?? '0.00', requireDifferentApprover: p.requireDifferentApprover, isActive: p.configured ? p.isActive : true }); }}>Edit</Button>
                  ) : null}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>
      {!canManage ? <p className="mt-3 text-sm text-fg-muted">Only owners and admins can change these rules.</p> : null}
      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)} title={draft ? `Approval rule for ${LABEL[draft.kind].toLowerCase()}` : ''} description="Changing a rule does not affect documents already posted. Drafts already approved keep their approval.">
        {draft ? (
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(draft); }}>
            {save.error ? <Alert title="Could not save">{save.error.message}</Alert> : null}
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[var(--t2t-accent)]" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} /> Require an approval</label>
            <Field label="For totals of at least" hint={`In ${org.functionalCurrency}, tax included. 0 means every document of this type.`}>
              {(p) => <Input {...p} required inputMode="decimal" value={draft.minAmount} onChange={(e) => /^\d{0,18}(\.\d{0,2})?$/.test(e.target.value) && setDraft({ ...draft, minAmount: e.target.value })} />}
            </Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[var(--t2t-accent)]" checked={draft.requireDifferentApprover} onChange={(e) => setDraft({ ...draft, requireDifferentApprover: e.target.checked })} /> The approver must be someone other than the person who prepared or submitted it</label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
              <Button type="submit" loading={save.isPending} disabled={draft.minAmount === ''}>Save rule</Button>
            </div>
          </form>
        ) : null}
      </Dialog>
    </>
  );
}

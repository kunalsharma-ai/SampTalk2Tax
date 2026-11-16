import { D } from '@talk2tax/accounting-engine';
import { DocumentKind } from '@talk2tax/database';
import { Tx } from '../common/prisma.service';

/** The active policy that covers a document of this kind and total, if any. Mirrors t2t_check_document_approval. */
export async function policyFor(tx: Pick<Tx, 'approvalPolicy'>, orgId: string, kind: DocumentKind, total: string) {
  const p = await tx.approvalPolicy.findUnique({ where: { orgId_documentKind: { orgId, documentKind: kind } } });
  if (!p || !p.isActive) return null;
  return new D(total).gte(p.minAmount.toFixed()) ? p : null;
}

/** An approval that still matches the draft: approved, and for exactly its current total. */
export async function currentApproval(tx: Pick<Tx, 'approvalRequest'>, documentId: string, total: string) {
  const r = await tx.approvalRequest.findFirst({ where: { documentId, status: 'APPROVED' } });
  return r && new D(r.total.toFixed()).eq(total) ? r : null;
}

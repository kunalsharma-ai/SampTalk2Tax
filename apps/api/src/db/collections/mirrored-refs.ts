import { GuardViolation, type CollectionDef, type GuardContext } from '@talk2tax/document-db';

/**
 * Mirrored tables (their documents have the Prisma model's fields) that the guards of the tables
 * moved by hand look up. The store knows them by the mirror's own definitions, which are looked
 * up when a guard runs (the mirror module imports these collections, so not at load time).
 */
type RefDoc = Record<string, unknown> & { id: string; orgId: string };
const ref = (model: string) => async (): Promise<CollectionDef<RefDoc>> => {
  const { modelInfo } = await import('../mirror-writes');
  const info = modelInfo(model);
  if (!info) throw new Error(`${model} is not mirrored`);
  return info.def as unknown as CollectionDef<RefDoc>;
};

export const eWayBillsRef = ref('EWayBill');
export const eInvoicesRef = ref('EInvoice');
export const withholdingDepositItemsRef = ref('WithholdingDepositItem');
export const purchaseOrdersRef = ref('PurchaseOrder');
export const purchaseOrderLinesRef = ref('PurchaseOrderLine');
export const invoiceTemplatesRef = ref('InvoiceTemplate');
export const dimensionValuesRef = ref('DimensionValue');

interface DimensionLine {
  id: string;
  departmentId: string | null;
  projectId: string | null;
}

/** Were document_lines_dimensions and journal_lines_dimensions: a line's department is a department and its project a project. */
export async function checkLineDimensions(orgId: string, lines: DimensionLine[], before: DimensionLine[] | null, ctx: GuardContext) {
  const was = new Map((before ?? []).map((l) => [l.id, l]));
  const values = ctx.collection(await dimensionValuesRef());
  for (const l of lines) {
    const old = was.get(l.id);
    if (old && old.departmentId === l.departmentId && old.projectId === l.projectId) continue;
    if (l.departmentId !== null && !(await values.findOne({ id: l.departmentId, orgId, type: 'DEPARTMENT' }))) throw new GuardViolation('The department on a line must be a department');
    if (l.projectId !== null && !(await values.findOne({ id: l.projectId, orgId, type: 'PROJECT' }))) throw new GuardViolation('The project on a line must be a project');
  }
}

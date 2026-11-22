import { HttpStatus, Injectable } from '@nestjs/common';
import { D } from '@talk2tax/accounting-engine';
import { GST_RECON_HEADS, gstDiscrepancies, gstPeriodRange, gstReconciliation, GstReconEntry } from '@talk2tax/tax-engine';
import { OrgContext } from '../auth/decorators';
import { fromDbDate, todayIso, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { gstPayments } from '../db/collections/gst-payments';
import { journalEntries } from '../db/collections/ledger';
import { lineSums, postedBetween } from '../db/ledger-queries';
import { runInOrg } from '../common/tenant-context';
import { GstService } from './gst.service';

/**
 * GST reconciliation (TAX-045) and discrepancy checks (TAX-044) for a month: the GST accounts in
 * the ledger against the month's documents, every difference explained by the entry that caused
 * it, and the month's documents checked for tax mistakes. Read-only; the rules are in
 * packages/tax-engine (gst-reconciliation.ts).
 */
@Injectable()
export class GstReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DocumentStoreService,
    private readonly gst: GstService,
  ) {}

  async month(org: OrgContext, period?: string) {
    const reg = await this.gst.registration(this.prisma, org.id);
    if (!reg) throw new DomainError('GST_NOT_REGISTERED', 'Set up the GST registration first (Settings → GST)', HttpStatus.CONFLICT);
    const month = period ?? todayIso().slice(0, 7);
    let range: { from: string; to: string };
    try {
      range = gstPeriodRange(month);
    } catch {
      throw new DomainError('INVALID_PERIOD', 'Give the month as YYYY-MM', HttpStatus.BAD_REQUEST);
    }
    const { from, to } = range;
    const outputIds = { igst: reg.outputIgstAccountId, cgst: reg.outputCgstAccountId, sgst: reg.outputSgstAccountId };
    const inputIds = { igst: reg.inputIgstAccountId, cgst: reg.inputCgstAccountId, sgst: reg.inputSgstAccountId };
    const ids = [...Object.values(outputIds), ...Object.values(inputIds)];
    const sums = await lineSums(this.store, org.id, { entry: postedBetween(toDbDate(from), toDbDate(to)), line: { accountId: { $in: ids } }, by: { entryId: '_id', accountId: 'lines.accountId' } });
    const entryIds = [...new Set(sums.map((s) => s.key.entryId as string))];
    const meta = entryIds.length ? await runInOrg(org.id, () => this.store.collection(journalEntries).find({ id: { $in: entryIds } })) : [];
    const entries: GstReconEntry[] = meta.map((e) => {
      const mine = sums.filter((s) => s.key.entryId === e.id);
      const net = (id: string, credit: boolean) => {
        const s = mine.find((x) => x.key.accountId === id);
        return (s ? (credit ? s.credit.minus(s.debit) : s.debit.minus(s.credit)) : new D(0)).toFixed(2);
      };
      return {
        id: e.id,
        number: e.entryNumber ?? null,
        date: fromDbDate(e.date),
        source: e.source,
        memo: e.memo ?? null,
        gst: {
          output: Object.fromEntries(GST_RECON_HEADS.map((h) => [h, net(outputIds[h], true)])) as Record<(typeof GST_RECON_HEADS)[number], string>,
          input: Object.fromEntries(GST_RECON_HEADS.map((h) => [h, net(inputIds[h], false)])) as Record<(typeof GST_RECON_HEADS)[number], string>,
        },
      };
    });
    const payments = await runInOrg(org.id, () => this.store.collection(gstPayments).find({}));
    const settlementEntryIds = new Set(payments.flatMap((p) => [p.journalEntryId, p.reversalEntryId].filter((x): x is string => !!x)));
    const documents = await this.gst.reconciliationDocuments(org.id, from, to, entryIds);
    const recon = gstReconciliation({ from, to, documents, entries, settlementEntryIds });
    const discrepancies = gstDiscrepancies(documents.filter((d) => d.issueDate >= from && d.issueDate <= to));
    const count = (s: string) => discrepancies.filter((d) => d.severity === s).length;
    return {
      period: month,
      gstin: reg.gstin,
      currency: 'INR',
      ...recon,
      accounts: { output: outputIds, input: inputIds },
      documentsChecked: documents.filter((d) => d.issueDate >= from && d.issueDate <= to && d.status === 'POSTED').length,
      discrepancies,
      discrepancyCounts: { high: count('HIGH'), medium: count('MEDIUM'), low: count('LOW') },
    };
  }
}

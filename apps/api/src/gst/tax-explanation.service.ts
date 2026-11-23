import { Injectable } from '@nestjs/common';
import { type Ledger, rateEffectiveOn } from '@talk2tax/accounting-engine';
import { explainDocumentTax, type GstCategory, type SupplyNature } from '@talk2tax/tax-engine';
import type { OrgContext } from '../auth/decorators';
import { PrismaService } from '../common/prisma.service';
import { DocumentsService } from '../ledgers/documents.service';
import { TaxRateVersionsService } from '../tax-rates/tax-rate-versions.service';
import { GstService } from './gst.service';

/**
 * Source-backed tax explanations (TAX-052): how the tax on one invoice, credit note, bill or
 * vendor credit was worked out, each point naming the record in the books or the provision it
 * comes from. Read-only, built from the document as posted; the rules are in packages/tax-engine
 * (india/tax-explanations.ts). No AI model is used. Needs sales.read or purchases.read.
 */
@Injectable()
export class TaxExplanationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly docs: DocumentsService,
    private readonly gst: GstService,
    private readonly versions: TaxRateVersionsService,
  ) {}

  async explain(org: OrgContext, ledger: Ledger, id: string) {
    const d = await this.docs.get(org, ledger, id);
    const reg = d.gst ? await this.gst.registration(this.prisma, org.id) : null;
    const rateIds = [...new Set(d.lines.map((l) => l.taxRateId).filter((x): x is string => !!x))];
    const rates = rateIds.length ? await this.prisma.taxRate.findMany({ where: { orgId: org.id, id: { in: rateIds } } }) : [];
    const versions = await this.versions.versionsFor(rateIds);
    const record = (rateId: string | null) => {
      const t = rateId ? rates.find((r) => r.id === rateId) : null;
      if (!t) return null;
      const vs = versions.get(t.id) ?? [];
      const changed = vs.filter((v) => v.effectiveFrom <= d.issueDate).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
      return { original: t.rate.toFixed(), inForce: rateEffectiveOn(t.rate.toFixed(), vs, d.issueDate), changedOn: changed?.effectiveFrom ?? null };
    };
    const explanation = explainDocumentTax({
      kind: d.kind as 'INVOICE' | 'CREDIT_NOTE' | 'BILL' | 'VENDOR_CREDIT',
      number: d.number,
      issueDate: d.issueDate,
      currency: d.currency,
      exchangeRate: d.exchangeRate,
      functionalCurrency: d.functionalCurrency,
      contactName: d.contact.name,
      gst: d.gst ? { placeOfSupply: d.gst.placeOfSupply, supplierState: d.gst.supplierState, supplyNature: d.gst.supplyNature as SupplyNature, counterpartyGstin: d.gst.counterpartyGstin, orgState: reg?.stateCode ?? null } : null,
      reverseCharge: d.reverseCharge,
      debitNoteFor: d.debitNoteFor?.number ?? null,
      lines: d.lines.map((l) => ({
        lineNo: l.lineNo,
        description: l.description ?? '',
        hsnCode: l.hsnCode,
        taxName: l.taxName,
        taxKind: (l.taxKind as 'GST' | 'SIMPLE' | null) ?? null,
        gstCategory: (l.gstCategory as GstCategory | null) ?? null,
        taxRate: l.taxRate,
        netAmount: l.netAmount,
        cgst: l.cgstAmount,
        sgst: l.sgstAmount,
        igst: l.igstAmount,
        taxAmount: l.taxAmount,
        rateRecord: record(l.taxRateId),
      })),
      withholding: d.withholding ? { kind: d.withholding.kind as 'TDS' | 'TCS', code: d.withholding.section.code, name: d.withholding.section.name, rate: d.withholding.rate, subject: d.withholding.subject, base: d.withholding.base, amount: d.withholding.amount, pan: d.withholding.pan } : null,
    });
    return { documentId: d.id, kind: d.kind, number: d.number, status: d.status, issueDate: d.issueDate, currency: d.currency, ...explanation };
  }
}

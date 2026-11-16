import { ChartService } from '../accounts/chart.service';
import { HttpStatus, Injectable } from '@nestjs/common';
import { D, Ledger, toFunctional } from '@talk2tax/accounting-engine';
import { Contact, GstRegistration, Prisma } from '@talk2tax/database';
import {
  checkGstin,
  FOREIGN_PLACE_OF_SUPPLY,
  GstCategory,
  GstReturnDocument,
  gstr1Summary,
  gstr3bSummary,
  indiaState,
  isPlaceOfSupply,
  SupplyNature,
  supplyNature,
} from '@talk2tax/tax-engine';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';

export interface GstAccountsInput {
  outputCgstAccountId: string;
  outputSgstAccountId: string;
  outputIgstAccountId: string;
  inputCgstAccountId: string;
  inputSgstAccountId: string;
  inputIgstAccountId: string;
}

export interface GstRegistrationInput {
  gstin: string;
  legalName?: string | null;
  effectiveFrom: string;
  /** Omit to create (or reuse) the standard GST accounts. */
  accounts?: GstAccountsInput;
}

/** The GST facts a document carries, decided when it is saved and again when it posts. */
export interface SupplyFacts {
  placeOfSupply: string;
  supplierState: string;
  supplyNature: SupplyNature;
  counterpartyGstin: string | null;
}

const ACCOUNT_KEYS = ['outputCgstAccountId', 'outputSgstAccountId', 'outputIgstAccountId', 'inputCgstAccountId', 'inputSgstAccountId', 'inputIgstAccountId'] as const;

/** Standard accounts created when an organisation registers for GST without choosing its own. */
const DEFAULT_ACCOUNTS: Record<(typeof ACCOUNT_KEYS)[number], { code: string; name: string; type: 'ASSET' | 'LIABILITY'; subtype: string; parentCode: string }> = {
  outputCgstAccountId: { code: '2310', name: 'Output CGST', type: 'LIABILITY', subtype: 'TAX_PAYABLE', parentCode: '2000' },
  outputSgstAccountId: { code: '2311', name: 'Output SGST/UTGST', type: 'LIABILITY', subtype: 'TAX_PAYABLE', parentCode: '2000' },
  outputIgstAccountId: { code: '2312', name: 'Output IGST', type: 'LIABILITY', subtype: 'TAX_PAYABLE', parentCode: '2000' },
  inputCgstAccountId: { code: '1451', name: 'Input CGST', type: 'ASSET', subtype: 'TAX_RECEIVABLE', parentCode: '1100' },
  inputSgstAccountId: { code: '1452', name: 'Input SGST/UTGST', type: 'ASSET', subtype: 'TAX_RECEIVABLE', parentCode: '1100' },
  inputIgstAccountId: { code: '1453', name: 'Input IGST', type: 'ASSET', subtype: 'TAX_RECEIVABLE', parentCode: '1100' },
};

/**
 * India GST (Directive Part 8): the organisation's registration, the GST facts of
 * each sales and purchase document, and return summaries. The rules themselves
 * live in packages/tax-engine so the web form computes exactly what posts.
 */
@Injectable()
export class GstService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly chart: ChartService,
  ) {}

  registration(db: Tx | PrismaService, orgId: string) {
    return db.gstRegistration.findUnique({ where: { orgId } });
  }

  async get(orgId: string) {
    const r = await this.registration(this.prisma, orgId);
    if (!r) return { registered: false as const };
    const accounts = await this.prisma.account.findMany({ where: { orgId, id: { in: ACCOUNT_KEYS.map((k) => r[k]) } }, select: { id: true, code: true, name: true } });
    const firstGstDocument = await this.prisma.document.findFirst({ where: { orgId, placeOfSupply: { not: null } }, orderBy: { issueDate: 'asc' }, select: { issueDate: true } });
    return { registered: true as const, ...serialize(r, accounts), firstDocumentDate: firstGstDocument ? fromDbDate(firstGstDocument.issueDate) : null };
  }

  async register(orgId: string, actor: { id: string }, input: GstRegistrationInput) {
    const check = checkGstin(input.gstin);
    if (!check.valid) throw new DomainError('INVALID_GSTIN', check.issues.join('; '));
    return this.prisma.$transaction(async (tx) => {
      // Serialise registration changes per organisation.
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE`;
      const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId } });
      if (org.countryCode !== 'IN' || org.functionalCurrency !== 'INR') {
        throw new DomainError('NOT_INDIA', 'GST registration is available to organisations in India that keep their books in INR');
      }
      const before = await tx.gstRegistration.findUnique({ where: { orgId } });
      const firstDoc = await tx.document.findFirst({ where: { orgId, placeOfSupply: { not: null } }, orderBy: { issueDate: 'asc' }, select: { issueDate: true } });
      if (before && firstDoc) {
        if (before.gstin !== check.gstin) throw new DomainError('GST_IN_USE', 'Documents already carry this GSTIN, so it cannot change. A new registration needs a new organisation.', HttpStatus.CONFLICT);
        if (input.effectiveFrom > fromDbDate(firstDoc.issueDate)) {
          throw new DomainError('GST_IN_USE', `GST documents exist from ${fromDbDate(firstDoc.issueDate)}, so the effective date cannot be later than that`, HttpStatus.CONFLICT);
        }
      }
      const accounts = input.accounts ?? (await this.defaultAccounts(tx, orgId, actor));
      await this.checkAccounts(tx, orgId, accounts);
      if (before && firstDoc && ACCOUNT_KEYS.some((k) => before[k] !== accounts[k])) {
        throw new DomainError('GST_IN_USE', 'GST has already posted to these accounts, so they cannot change', HttpStatus.CONFLICT);
      }
      const data = { gstin: check.gstin, stateCode: check.stateCode!, legalName: input.legalName?.trim() || null, effectiveFrom: toDbDate(input.effectiveFrom), ...accounts };
      const r = before ? await tx.gstRegistration.update({ where: { orgId }, data }) : await tx.gstRegistration.create({ data: { orgId, ...data } });
      await this.audit.append(tx, {
        orgId,
        actorId: actor.id,
        action: before ? 'gst.registration_updated' : 'gst.registered',
        entityType: 'gst_registration',
        entityId: orgId,
        data: { gstin: r.gstin, stateCode: r.stateCode, effectiveFrom: input.effectiveFrom, ...accounts },
      });
      const accs = await tx.account.findMany({ where: { orgId, id: { in: ACCOUNT_KEYS.map((k) => r[k]) } }, select: { id: true, code: true, name: true } });
      return { registered: true as const, ...serialize(r, accs), firstDocumentDate: firstDoc ? fromDbDate(firstDoc.issueDate) : null };
    });
  }

  /**
   * Place of supply and nature of a document. Sales: the supplier is this
   * organisation and the place of supply defaults to the customer's state.
   * Purchases: the supplier is the vendor and the place of supply defaults to
   * this organisation's state (where the goods or services are received).
   */
  supplyFacts(reg: GstRegistration, ledger: Ledger, contact: Contact, placeOfSupply: string | null | undefined): SupplyFacts {
    const pos = placeOfSupply || (ledger === 'SALES' ? contact.stateCode : reg.stateCode);
    if (!pos) throw new DomainError('PLACE_OF_SUPPLY_REQUIRED', `Choose the place of supply: ${contact.name} has no state on file`);
    if (!isPlaceOfSupply(pos)) throw new DomainError('INVALID_PLACE_OF_SUPPLY', `${pos} is not a GST place of supply`);
    const supplierState = ledger === 'SALES' ? reg.stateCode : contact.stateCode;
    if (!supplierState) throw new DomainError('VENDOR_STATE_REQUIRED', `Add ${contact.name}'s GSTIN or state before entering a GST bill`);
    if (ledger === 'PURCHASES' && pos === FOREIGN_PLACE_OF_SUPPLY) throw new DomainError('INVALID_PLACE_OF_SUPPLY', 'Purchases are received in India; choose the state where they are received');
    return { placeOfSupply: pos, supplierState, supplyNature: supplyNature(supplierState, pos), counterpartyGstin: contact.gstin };
  }

  accountsFor(reg: GstRegistration, ledger: Ledger) {
    return ledger === 'SALES'
      ? { cgst: reg.outputCgstAccountId, sgst: reg.outputSgstAccountId, igst: reg.outputIgstAccountId }
      : { cgst: reg.inputCgstAccountId, sgst: reg.inputSgstAccountId, igst: reg.inputIgstAccountId };
  }

  // ------------------------------------------------------------------ returns

  async gstr1(orgId: string, from: string, to: string) {
    const reg = await this.requireRegistration(orgId);
    const docs = await this.returnDocuments(orgId, ['INVOICE', 'CREDIT_NOTE'], from, to);
    return { gstin: reg.gstin, from, to, ...gstr1Summary(docs) };
  }

  async gstr3b(orgId: string, from: string, to: string) {
    const reg = await this.requireRegistration(orgId);
    const docs = await this.returnDocuments(orgId, ['INVOICE', 'CREDIT_NOTE', 'BILL', 'VENDOR_CREDIT'], from, to);
    const summary = gstr3bSummary(docs);
    return { gstin: reg.gstin, from, to, ...summary, ledger: await this.ledgerMovements(orgId, reg, from, to, summary) };
  }

  /**
   * Movement on the six GST accounts over the period, read from posted journals,
   * next to what the documents say. A difference means something else touched
   * a GST account (a manual journal, or a document voided in a later period).
   */
  private async ledgerMovements(orgId: string, reg: GstRegistration, from: string, to: string, s: ReturnType<typeof gstr3bSummary>) {
    const ids = ACCOUNT_KEYS.map((k) => reg[k]);
    const rows = await this.prisma.$queryRaw<{ account_id: string; dr: Prisma.Decimal | null; cr: Prisma.Decimal | null }[]>`
      SELECT l.account_id, SUM(l.functional_debit) AS dr, SUM(l.functional_credit) AS cr
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.org_id = ${orgId}::uuid AND e.status = 'POSTED' AND e.date BETWEEN ${toDbDate(from)}::date AND ${toDbDate(to)}::date
        AND l.account_id IN (${Prisma.join(ids.map((x) => Prisma.sql`${x}::uuid`))})
      GROUP BY l.account_id`;
    const net = (id: string, credit: boolean) => {
      const r = rows.find((x) => x.account_id === id);
      const dr = new D(r?.dr?.toFixed() ?? '0');
      const cr = new D(r?.cr?.toFixed() ?? '0');
      return (credit ? cr.minus(dr) : dr.minus(cr)).toFixed(2);
    };
    const output = { igst: net(reg.outputIgstAccountId, true), cgst: net(reg.outputCgstAccountId, true), sgst: net(reg.outputSgstAccountId, true) };
    const input = { igst: net(reg.inputIgstAccountId, false), cgst: net(reg.inputCgstAccountId, false), sgst: net(reg.inputSgstAccountId, false) };
    const heads = ['igst', 'cgst', 'sgst'] as const;
    // Output accounts carry outward tax and reverse-charge tax; input accounts all input tax credit.
    const outward = {
      igst: new D(s.outwardTaxable.igst).plus(s.outwardZeroRated.igst).plus(s.inwardReverseCharge.igst),
      cgst: new D(s.outwardTaxable.cgst).plus(s.inwardReverseCharge.cgst),
      sgst: new D(s.outwardTaxable.sgst).plus(s.inwardReverseCharge.sgst),
    };
    const agrees = heads.every((h) => new D(output[h]).eq(outward[h]) && new D(input[h]).eq(s.itcTotal[h]));
    return { output, input, agrees };
  }

  private async requireRegistration(orgId: string) {
    const reg = await this.registration(this.prisma, orgId);
    if (!reg) throw new DomainError('GST_NOT_REGISTERED', 'Set up the GST registration first (Settings → GST)', HttpStatus.CONFLICT);
    return reg;
  }

  private async returnDocuments(orgId: string, kinds: GstReturnDocument['kind'][], from: string, to: string): Promise<GstReturnDocument[]> {
    const docs = await this.prisma.document.findMany({
      where: { orgId, kind: { in: kinds }, status: { in: ['POSTED', 'VOID'] }, placeOfSupply: { not: null }, issueDate: { gte: toDbDate(from), lte: toDbDate(to) } },
      include: { contact: { select: { name: true } }, debitNoteFor: { select: { number: true } }, lines: { orderBy: { lineNo: 'asc' }, include: { tax: { select: { gstCategory: true } } } } },
      orderBy: [{ issueDate: 'asc' }, { number: 'asc' }],
    });
    // Returns are in rupees: a document in another currency is converted at its own rate.
    return docs.map((d) => {
      const r = d.exchangeRate.toFixed();
      const inr = (v: Prisma.Decimal) => (d.currency === 'INR' ? v.toFixed(2) : toFunctional(new D(v.toFixed()), r, 'INR').toFixed(2));
      return {
      id: d.id,
      kind: d.kind,
      status: d.status as 'POSTED' | 'VOID',
      number: d.number!,
      issueDate: fromDbDate(d.issueDate),
      contactName: d.contact.name,
      gstin: d.counterpartyGstin,
      placeOfSupply: d.placeOfSupply!,
      nature: d.supplyNature!,
      total: inr(d.subtotal.plus(d.taxTotal)),
      reverseCharge: d.reverseCharge,
      supplierState: d.supplierState ?? undefined,
      ...(d.debitNoteForId ? { debitNote: true, originalNumber: d.debitNoteFor?.number ?? null } : {}),
      lines: d.lines.map((l) => ({
        hsnCode: l.hsnCode,
        quantity: l.quantity.toFixed(),
        category: (l.tax?.gstCategory ?? 'NON_GST') as GstCategory,
        rate: l.taxRate.toFixed(),
        taxable: inr(l.netAmount),
        cgst: inr(l.cgstAmount),
        sgst: inr(l.sgstAmount),
        igst: inr(l.igstAmount),
      })),
      };
    });
  }

  // ------------------------------------------------------------------ helpers

  private async defaultAccounts(tx: Tx, orgId: string, actor: { id: string }): Promise<GstAccountsInput> {
    return this.chart.ensure(tx, orgId, actor.id, DEFAULT_ACCOUNTS, 'GST registration');
  }

  private async checkAccounts(tx: Tx, orgId: string, accounts: GstAccountsInput) {
    const ids = ACCOUNT_KEYS.map((k) => accounts[k]);
    if (new Set(ids).size !== ids.length) throw new DomainError('INVALID_ACCOUNT', 'Each GST head needs its own account');
    const found = await tx.account.findMany({ where: { orgId, id: { in: ids } } });
    const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { arAccountId: true, apAccountId: true, claimsAccountId: true } });
    const control = new Set([org.arAccountId, org.apAccountId, org.claimsAccountId]);
    const issues: string[] = [];
    for (const key of ACCOUNT_KEYS) {
      const a = found.find((x) => x.id === accounts[key]);
      const label = DEFAULT_ACCOUNTS[key].name;
      if (!a) issues.push(`${label}: account not found`);
      else if (!a.isPostable || !a.isActive) issues.push(`${label}: ${a.code} is a header or inactive account`);
      else if (control.has(a.id)) issues.push(`${label}: ${a.code} is a control account`);
      else if (a.type !== DEFAULT_ACCOUNTS[key].type) issues.push(`${label}: must be ${DEFAULT_ACCOUNTS[key].type === 'ASSET' ? 'an asset' : 'a liability'} account`);
    }
    if (issues.length) throw new DomainError('INVALID_ACCOUNT', 'GST accounts are invalid', HttpStatus.UNPROCESSABLE_ENTITY, { issues });
  }
}

function serialize(r: GstRegistration, accounts: { id: string; code: string; name: string }[]) {
  const acc = (id: string) => accounts.find((a) => a.id === id) ?? { id, code: '', name: '' };
  return {
    gstin: r.gstin,
    legalName: r.legalName,
    stateCode: r.stateCode,
    stateName: indiaState(r.stateCode)?.name ?? r.stateCode,
    effectiveFrom: fromDbDate(r.effectiveFrom),
    accounts: {
      outputCgst: acc(r.outputCgstAccountId),
      outputSgst: acc(r.outputSgstAccountId),
      outputIgst: acc(r.outputIgstAccountId),
      inputCgst: acc(r.inputCgstAccountId),
      inputSgst: acc(r.inputSgstAccountId),
      inputIgst: acc(r.inputIgstAccountId),
    },
  };
}

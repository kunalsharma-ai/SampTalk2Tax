import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ALLOWANCE_UNIT, allowanceRateIssues, computeAllowance, ExpenseLineInput, minorUnits, MoneyError } from '@talk2tax/accounting-engine';
import { isDuplicateKeyError } from '@talk2tax/document-db';
import { AuditService } from '../audit/audit.service';
import { OrgContext } from '../auth/decorators';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { AllowanceKindName, allowanceRates, AllowanceRateDoc, ClaimAllowanceDoc, claimAllowances } from '../db/collections/allowances';
import { accounts } from '../db/collections/chart';
import { organizations } from '../db/collections/tenancy';

export interface AllowanceInput {
  rateId: string;
  quantity: string;
  from?: string | null;
  to?: string | null;
  purpose?: string | null;
}

/** A claim line as it arrives: a receipt line, or an allowance whose amount and account the server works out. */
export interface ClaimLineInput {
  date: string;
  accountId?: string | null;
  merchant?: string | null;
  description?: string | null;
  amount?: string | null;
  taxRateId?: string | null;
  allowance?: AllowanceInput | null;
  departmentId?: string | null;
}

type Detail = Omit<ClaimAllowanceDoc, 'id' | 'orgId' | 'claimId' | 'createdAt'>;

const invalid = (issues: string[]) => new DomainError('CLAIM_INVALID', 'The claim is invalid', HttpStatus.UNPROCESSABLE_ENTITY, { issues });

/**
 * Mileage and per diem rates, and turning an allowance line of a claim into an ordinary claim
 * line (EXP-006, EXP-008). MongoDB only. Rates are set by finance (expenses.reimburse); a rate
 * that changes later leaves claims already saved as they were.
 */
@Injectable()
export class AllowancesService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private serializeRate(r: AllowanceRateDoc, names: Map<string, { code: string; name: string }>) {
    const a = names.get(r.accountId);
    return { id: r.id, kind: r.kind, unit: ALLOWANCE_UNIT[r.kind], name: r.name, rate: r.rate, accountId: r.accountId, account: a ? `${a.code} · ${a.name}` : null, isActive: r.isActive, updatedAt: r.updatedAt.toISOString() };
  }

  async listRates(org: OrgContext, opts: { activeOnly?: boolean } = {}) {
    const rows = await this.store.collection(allowanceRates).find(opts.activeOnly ? { isActive: true } : {}, { sort: { kind: 1, name: 1 } });
    const accs = await this.store.collection(accounts).find({ id: { $in: [...new Set(rows.map((r) => r.accountId))] } });
    const names = new Map(accs.map((a) => [a.id, { code: a.code, name: a.name }]));
    return rows.map((r) => this.serializeRate(r, names));
  }

  /** An expense account an employee may claim to: postable, active, and not a control account. */
  private async assertAccount(orgId: string, accountId: string) {
    const a = await this.store.collection(accounts).findById(accountId);
    const o = await this.store.collection(organizations).findById(orgId);
    const control = new Set([o?.arAccountId, o?.apAccountId, o?.claimsAccountId].filter(Boolean));
    if (!a || a.type !== 'EXPENSE' || !a.isPostable || !a.isActive || control.has(a.id)) throw invalid(['Choose an active expense account the rate posts to']);
  }

  async createRate(org: OrgContext, actorId: string, input: { kind: AllowanceKindName; name: string; rate: string; accountId: string }) {
    const issues = allowanceRateIssues(input, org.functionalCurrency);
    if (issues.length) throw new DomainError('RATE_INVALID', 'The rate is invalid', HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    await this.assertAccount(org.id, input.accountId);
    const now = new Date();
    const r = await this.store
      .collection(allowanceRates)
      .insertOne({ orgId: org.id, kind: input.kind, name: input.name.trim(), rate: input.rate, accountId: input.accountId, isActive: true, createdById: actorId, createdAt: now, updatedAt: now })
      .catch((e: unknown) => {
        throw isDuplicateKeyError(e) ? new DomainError('RATE_EXISTS', `There is already a ${input.kind === 'MILEAGE' ? 'mileage' : 'per diem'} rate called ${input.name.trim()}`, HttpStatus.CONFLICT) : e;
      });
    await this.record(org.id, actorId, 'expense_allowance_rate.created', r.id, { kind: r.kind, name: r.name, rate: r.rate });
    return (await this.listRates(org)).find((x) => x.id === r.id)!;
  }

  async updateRate(org: OrgContext, actorId: string, id: string, input: { name: string; rate: string; accountId: string; isActive: boolean }) {
    const before = await this.store.collection(allowanceRates).findById(id);
    if (!before) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Rate not found' });
    const issues = allowanceRateIssues({ kind: before.kind, name: input.name, rate: input.rate }, org.functionalCurrency);
    if (issues.length) throw new DomainError('RATE_INVALID', 'The rate is invalid', HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    await this.assertAccount(org.id, input.accountId);
    await this.store
      .collection(allowanceRates)
      .updateOne({ id }, { $set: { name: input.name.trim(), rate: input.rate, accountId: input.accountId, isActive: input.isActive, updatedAt: new Date() } })
      .catch((e: unknown) => {
        throw isDuplicateKeyError(e) ? new DomainError('RATE_EXISTS', `There is already a rate called ${input.name.trim()}`, HttpStatus.CONFLICT) : e;
      });
    await this.record(org.id, actorId, 'expense_allowance_rate.updated', id, { before: { name: before.name, rate: before.rate, isActive: before.isActive }, after: { name: input.name.trim(), rate: input.rate, isActive: input.isActive } });
    return (await this.listRates(org)).find((x) => x.id === id)!;
  }

  private record(orgId: string, actorId: string, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId, actorId, action, entityType: 'expense_allowance_rate', entityId, data }));
  }

  /**
   * Allowance lines become ordinary claim lines: the amount is quantity × rate, the account is
   * the rate's, no tax. Receipt lines pass through. Details are returned by line number.
   */
  async expand(org: OrgContext, lines: ClaimLineInput[]): Promise<{ lines: ExpenseLineInput[]; details: Detail[] }> {
    const ids = [...new Set(lines.map((l) => l.allowance?.rateId).filter((x): x is string => !!x))];
    const rates = new Map((ids.length ? await this.store.collection(allowanceRates).find({ id: { $in: ids } }) : []).map((r) => [r.id, r]));
    const issues: string[] = [];
    const details: Detail[] = [];
    const out = lines.map((l, i): ExpenseLineInput => {
      const n = i + 1;
      if (!l.allowance) {
        if (!l.accountId) issues.push(`Line ${n}: choose a category`);
        if (!l.amount) issues.push(`Line ${n}: enter the amount paid`);
        return { date: l.date, accountId: l.accountId ?? '', merchant: l.merchant, description: l.description, amount: l.amount ?? '0', taxRateId: l.taxRateId, departmentId: l.departmentId ?? null };
      }
      const r = rates.get(l.allowance.rateId);
      if (!r || !r.isActive) {
        issues.push(`Line ${n}: choose an active mileage or per diem rate`);
        return { date: l.date, accountId: '', amount: '0' };
      }
      try {
        const a = computeAllowance({ kind: r.kind, rateName: r.name, rate: r.rate, quantity: l.allowance.quantity, from: l.allowance.from, to: l.allowance.to, purpose: l.allowance.purpose }, org.functionalCurrency);
        const scale = minorUnits(org.functionalCurrency);
        details.push({
          lineNo: n,
          kind: r.kind,
          rateId: r.id,
          rateName: r.name,
          rate: r.rate,
          unit: ALLOWANCE_UNIT[r.kind],
          quantity: a.quantity.toFixed(),
          from: r.kind === 'MILEAGE' ? l.allowance.from!.trim() : null,
          to: l.allowance.to!.trim(),
          purpose: l.allowance.purpose?.trim() || null,
          amount: a.amount.toFixed(scale),
        });
        return { date: l.date, accountId: r.accountId, merchant: null, description: a.description, amount: a.amount.toFixed(scale), taxRateId: null, departmentId: l.departmentId ?? null };
      } catch (e) {
        issues.push(`Line ${n}: ${e instanceof MoneyError ? e.message : 'the allowance is invalid'}`);
        return { date: l.date, accountId: r.accountId, amount: '0' };
      }
    });
    if (issues.length) throw invalid(issues);
    return { lines: out, details };
  }

  /** Replaces the allowance details of a claim (inside the caller's transaction). */
  async save(claimId: string, details: Detail[]) {
    const c = this.store.collection(claimAllowances);
    await c.deleteMany({ claimId });
    const now = new Date();
    if (details.length) await c.insertMany(details.map((d) => ({ ...d, claimId, createdAt: now }) as never));
  }

  async forClaim(claimId: string) {
    const rows = await this.store.collection(claimAllowances).find({ claimId }, { sort: { lineNo: 1 } });
    return new Map(rows.map((r) => [r.lineNo, { kind: r.kind, rateId: r.rateId, rateName: r.rateName, rate: r.rate, unit: r.unit, quantity: r.quantity, from: r.from, to: r.to, purpose: r.purpose }]));
  }
}

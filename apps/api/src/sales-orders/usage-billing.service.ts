import { Injectable, NotFoundException } from '@nestjs/common';
import {
  contractPeriod,
  D,
  meterPricingIssues,
  periodLabel,
  pricingSummary,
  upcomingPeriods,
  usageCharge,
  type ContractFrequency,
  type ContractPeriod,
  type MeterPricing,
  type UsagePricing,
  type UsageTier,
} from '@talk2tax/accounting-engine';
import { ContractMeter, Prisma, SalesContract } from '@talk2tax/database';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { PrismaService, Tx } from '../common/prisma.service';
import { todayIst } from '../tasks/tasks.service';
import { SalesOrg, SalesOrdersService } from './sales-orders.service';

type Actor = { id: string };
type Db = Tx | PrismaService;
export type UsageSource = 'MANUAL' | 'IMPORT' | 'API';

export interface MeterInput {
  code: string;
  name: string;
  unit: string;
  accountId: string;
  taxRateId?: string | null;
  hsnCode?: string | null;
  pricing: UsagePricing;
  tiers: UsageTier[];
  includedQuantity?: string | null;
  minimumCharge?: string | null;
}

export interface UsageInput {
  meterId: string;
  date: string;
  quantity: string;
  reference?: string | null;
  note?: string | null;
}

const ref = (n: number) => `CT-${String(n).padStart(4, '0')}`;
const clean = (s: string | null | undefined) => (s?.trim() ? s.trim() : null);
const MAX_PERIODS = 1200;

/**
 * Usage-based billing (AR-012): meters on a customer contract, the usage recorded against them
 * (by hand, by CSV import or through the API), and the usage lines each period's invoice gets.
 * Usage is billed in arrears, so only contracts billed in arrears carry meters.
 */
@Injectable()
export class UsageBillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sales: SalesOrdersService,
    private readonly audit: AuditService,
  ) {}

  private pricing(m: ContractMeter): MeterPricing {
    return { pricing: m.pricing as UsagePricing, tiers: m.tiers as unknown as UsageTier[], included: m.includedQuantity.toFixed(), minimum: m.minimumCharge?.toFixed() ?? null };
  }

  private async contract(db: Db, orgId: string, id: string, lock = false): Promise<SalesContract> {
    if (lock) await (db as Tx).$queryRaw`SELECT id FROM sales_contracts WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid FOR UPDATE`;
    const c = await db.salesContract.findFirst({ where: { id, orgId } });
    if (!c) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Contract not found' });
    return c;
  }

  /** The period number a date falls in, or null before the start. */
  private periodOf(c: SalesContract, date: string): ContractPeriod | null {
    const start = fromDbDate(c.startDate);
    if (date < start) return null;
    for (let n = 1; n <= MAX_PERIODS; n++) {
      const p = contractPeriod(start, c.frequency as ContractFrequency, n, c.timing);
      if (date <= p.end) return p;
    }
    return null;
  }

  private checkMeter(input: MeterInput) {
    const issues = meterPricingIssues({ pricing: input.pricing, tiers: input.tiers, included: input.includedQuantity || '0', minimum: clean(input.minimumCharge) });
    if (issues.length) this.sales.invalid(issues[0]!, 'METER_INVALID', { issues });
  }

  private meterData(input: MeterInput) {
    return {
      name: input.name.trim(),
      unit: input.unit.trim(),
      accountId: input.accountId,
      taxRateId: input.taxRateId ?? null,
      hsnCode: clean(input.hsnCode),
      pricing: input.pricing,
      tiers: input.tiers.map((t) => ({ upTo: t.upTo === null || t.upTo === '' ? null : new D(t.upTo).toFixed(), unitPrice: new D(t.unitPrice).toFixed() })) as unknown as Prisma.InputJsonValue,
      includedQuantity: input.includedQuantity || '0',
      minimumCharge: clean(input.minimumCharge),
    };
  }

  private async checkAccounts(db: Db, orgId: string, input: MeterInput) {
    const a = await db.account.findFirst({ where: { id: input.accountId, orgId }, select: { type: true, isPostable: true, isActive: true } });
    if (!a || a.type !== 'REVENUE' || !a.isPostable || !a.isActive) this.sales.invalid('Choose an active income account for the usage charge', 'METER_INVALID');
    if (input.taxRateId && !(await db.taxRate.findFirst({ where: { id: input.taxRateId, orgId }, select: { id: true } }))) this.sales.invalid('Choose a tax rate of this organisation', 'METER_INVALID');
  }

  private canMeter(c: SalesContract) {
    if (c.status === 'ENDED' || c.status === 'CANCELLED') this.sales.invalid('An ended or cancelled contract takes no new usage charges', 'CONTRACT_CLOSED');
    if (c.timing !== 'ARREARS') this.sales.invalid('Usage is billed in arrears, after each period ends. Change the contract to bill in arrears first (possible while it is a draft).', 'METER_NEEDS_ARREARS');
  }

  // ------------------------------------------------------------------ meters

  /** The contract's meters, with the usage so far in the current (unbilled) period and its estimated charge. */
  async meters(org: SalesOrg, contractId: string) {
    const c = await this.contract(this.prisma, org.id, contractId);
    const meters = await this.prisma.contractMeter.findMany({ where: { orgId: org.id, contractId }, orderBy: { createdAt: 'asc' } });
    const start = fromDbDate(c.startDate);
    const live = c.status === 'ACTIVE' || c.status === 'PAUSED' || c.status === 'DRAFT';
    const current = live ? upcomingPeriods({ start, end: c.endDate ? fromDbDate(c.endDate) : null, frequency: c.frequency as ContractFrequency, timing: c.timing, nextNo: c.nextPeriodNo }, 1)[0] ?? null : null;
    const sums = current
      ? await this.prisma.usageRecord.groupBy({ by: ['meterId'], where: { orgId: org.id, contractId, voidedAt: null, periodNo: null, usageDate: { gte: toDbDate(current.start), lte: toDbDate(current.end) } }, _sum: { quantity: true }, _count: true })
      : [];
    const unbilled = await this.prisma.usageRecord.groupBy({ by: ['meterId'], where: { orgId: org.id, contractId, voidedAt: null, periodNo: null }, _count: true });
    const accounts = await this.prisma.account.findMany({ where: { orgId: org.id, id: { in: meters.map((m) => m.accountId) } }, select: { id: true, code: true, name: true } });
    const scale = 2;
    return {
      contract: { id: c.id, reference: ref(c.number), status: c.status, timing: c.timing, currency: c.currency },
      currentPeriod: current ? { periodNo: current.no, start: current.start, end: current.end, billDate: current.billDate } : null,
      meters: meters.map((m) => {
        const p = this.pricing(m);
        const used = sums.find((s) => s.meterId === m.id)?._sum.quantity?.toFixed() ?? '0';
        const est = current ? usageCharge(p, used, { name: m.name, unit: m.unit, period: periodLabel(current) }) : null;
        const acc = accounts.find((a) => a.id === m.accountId);
        return {
          id: m.id,
          code: m.code,
          name: m.name,
          unit: m.unit,
          account: acc ? { id: acc.id, code: acc.code, name: acc.name } : null,
          taxRateId: m.taxRateId,
          hsnCode: m.hsnCode,
          pricing: p.pricing,
          tiers: p.tiers,
          includedQuantity: p.included,
          minimumCharge: p.minimum,
          summary: pricingSummary(p, m.unit),
          active: m.active,
          usedThisPeriod: new D(used).toFixed(),
          readingsThisPeriod: sums.find((s) => s.meterId === m.id)?._count ?? 0,
          estimate: est && m.active ? new D(est.amount).toFixed(scale) : null,
          unbilledReadings: unbilled.find((s) => s.meterId === m.id)?._count ?? 0,
        };
      }),
      can: this.sales.can(org),
    };
  }

  async addMeter(org: SalesOrg, actor: Actor, contractId: string, input: MeterInput) {
    this.checkMeter(input);
    await this.prisma.$transaction(async (tx) => {
      const c = await this.contract(tx, org.id, contractId, true);
      this.canMeter(c);
      await this.checkAccounts(tx, org.id, input);
      if (await tx.contractMeter.findFirst({ where: { contractId, code: input.code } })) this.sales.invalid(`This contract already has a meter ${input.code}`, 'METER_INVALID');
      const m = await tx.contractMeter.create({ data: { orgId: org.id, contractId, code: input.code, createdById: actor.id, ...this.meterData(input) } });
      await tx.salesContractEvent.create({ data: { orgId: org.id, contractId, kind: 'UPDATED', body: `Usage charge ${m.name} (${m.code}) added: ${pricingSummary(this.pricing(m), m.unit)}`, actorId: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'contract_meter.created', entityType: 'sales_contract', entityId: contractId, data: { reference: ref(c.number), meter: m.code, pricing: m.pricing } });
    });
    return this.meters(org, contractId);
  }

  /** New pricing applies to periods billed from now on; periods already billed keep their invoices. */
  async updateMeter(org: SalesOrg, actor: Actor, contractId: string, meterId: string, input: MeterInput & { active?: boolean }) {
    this.checkMeter(input);
    await this.prisma.$transaction(async (tx) => {
      const c = await this.contract(tx, org.id, contractId, true);
      if (c.status === 'ENDED' || c.status === 'CANCELLED') this.sales.invalid('An ended or cancelled contract does not change', 'CONTRACT_CLOSED');
      const old = await tx.contractMeter.findFirst({ where: { id: meterId, contractId, orgId: org.id } });
      if (!old) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Meter not found' });
      if (input.code !== old.code) this.sales.invalid('A meter keeps its code; usage is sent against it', 'METER_INVALID');
      await this.checkAccounts(tx, org.id, input);
      const m = await tx.contractMeter.update({ where: { id: meterId }, data: { ...this.meterData(input), active: input.active ?? old.active } });
      const was = pricingSummary(this.pricing(old), old.unit);
      const now = pricingSummary(this.pricing(m), m.unit);
      const body = [was !== now ? `price ${was} → ${now}` : null, old.active !== m.active ? (m.active ? 'switched on' : 'switched off: not billed from now on') : null].filter(Boolean).join('; ') || 'details changed';
      await tx.salesContractEvent.create({ data: { orgId: org.id, contractId, kind: 'UPDATED', body: `Usage charge ${m.name} (${m.code}): ${body}`.slice(0, 1000), actorId: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'contract_meter.updated', entityType: 'sales_contract', entityId: contractId, data: { reference: ref(c.number), meter: m.code, from: was, to: now, active: m.active } });
    });
    return this.meters(org, contractId);
  }

  /** A meter with no usage recorded can be removed; otherwise switch it off. */
  async removeMeter(org: SalesOrg, actor: Actor, contractId: string, meterId: string) {
    await this.prisma.$transaction(async (tx) => {
      const c = await this.contract(tx, org.id, contractId, true);
      const m = await tx.contractMeter.findFirst({ where: { id: meterId, contractId, orgId: org.id } });
      if (!m) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Meter not found' });
      if (await tx.usageRecord.count({ where: { meterId } })) this.sales.invalid('This meter has usage recorded; switch it off instead', 'METER_HAS_USAGE');
      await tx.contractMeter.delete({ where: { id: meterId } });
      await tx.salesContractEvent.create({ data: { orgId: org.id, contractId, kind: 'UPDATED', body: `Usage charge ${m.name} (${m.code}) removed`, actorId: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'contract_meter.deleted', entityType: 'sales_contract', entityId: contractId, data: { reference: ref(c.number), meter: m.code } });
    });
    return this.meters(org, contractId);
  }

  // ------------------------------------------------------------------ usage

  private async checkUsage(tx: Tx, c: SalesContract, meter: ContractMeter | undefined, u: { date: string; quantity: string }, today: string, line = '') {
    if (!meter) return `${line}no such meter on this contract`;
    if (!meter.active) return `${line}meter ${meter.code} is switched off`;
    if (u.date > today) return `${line}usage cannot be dated in the future`;
    if (c.endDate && u.date > fromDbDate(c.endDate)) return `${line}${u.date} is after the contract ends`;
    const p = this.periodOf(c, u.date);
    if (!p) return `${line}${u.date} is before the contract starts on ${fromDbDate(c.startDate)}`;
    if (p.no < c.nextPeriodNo) {
      const done = await tx.salesContractPeriod.findFirst({ where: { contractId: c.id, periodNo: p.no }, select: { status: true } });
      return `${line}the period ${p.start} to ${p.end} is already ${done?.status === 'SKIPPED' ? 'skipped (the contract was paused)' : 'billed'}; record the usage as an adjustment in the current period`;
    }
    try {
      new D(u.quantity);
    } catch {
      return `${line}"${u.quantity}" is not a quantity`;
    }
    return null;
  }

  /** Record one reading. The same reference on the same meter is recorded once (`duplicate: true`). */
  async record(org: SalesOrg, actor: Actor, contractId: string, input: UsageInput, source: UsageSource = 'MANUAL') {
    const res = await this.prisma.$transaction(async (tx) => {
      const c = await this.contract(tx, org.id, contractId, true);
      if (c.status !== 'ACTIVE' && c.status !== 'PAUSED') this.sales.invalid('Usage is recorded on an active or paused contract', 'CONTRACT_NOT_ACTIVE');
      const meter = await tx.contractMeter.findFirst({ where: { id: input.meterId, contractId, orgId: org.id } });
      const problem = await this.checkUsage(tx, c, meter ?? undefined, input, todayIst());
      if (problem) this.sales.invalid(problem.charAt(0).toUpperCase() + problem.slice(1), 'USAGE_INVALID');
      const reference = clean(input.reference);
      if (reference) {
        const had = await tx.usageRecord.findFirst({ where: { meterId: meter!.id, reference, voidedAt: null } });
        if (had) return { id: had.id, duplicate: true };
      }
      const r = await tx.usageRecord.create({ data: { orgId: org.id, contractId, meterId: meter!.id, usageDate: toDbDate(input.date), quantity: new D(input.quantity).toFixed(), reference, note: clean(input.note), source, createdById: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'usage.recorded', entityType: 'sales_contract', entityId: contractId, data: { reference: ref(c.number), meter: meter!.code, date: input.date, quantity: r.quantity.toFixed(), source } });
      return { id: r.id, duplicate: false };
    });
    return { ...res, usage: await this.list(org, contractId, {}) };
  }

  /** Record many readings by meter code. Nothing is recorded when any row is wrong; repeated references are skipped. */
  async import(org: SalesOrg, actor: Actor, contractId: string, rows: { meter: string; date: string; quantity: string; reference?: string | null }[], source: UsageSource = 'IMPORT') {
    const res = await this.prisma.$transaction(
      async (tx) => {
        const c = await this.contract(tx, org.id, contractId, true);
        if (c.status !== 'ACTIVE' && c.status !== 'PAUSED') this.sales.invalid('Usage is recorded on an active or paused contract', 'CONTRACT_NOT_ACTIVE');
        const meters = await tx.contractMeter.findMany({ where: { contractId, orgId: org.id } });
        const today = todayIst();
        const issues: string[] = [];
        for (const [i, r] of rows.entries()) {
          const p = await this.checkUsage(tx, c, meters.find((m) => m.code === r.meter), r, today, `Row ${i + 1} (${r.meter}): `);
          if (p) issues.push(p);
          if (issues.length >= 20) break;
        }
        if (issues.length) this.sales.invalid(`${issues.length === 1 ? 'A row is' : 'Some rows are'} wrong; nothing was recorded`, 'USAGE_INVALID', { issues });
        const refs = rows.filter((r) => r.reference).map((r) => clean(r.reference)!);
        const had = refs.length ? await tx.usageRecord.findMany({ where: { contractId, voidedAt: null, reference: { in: refs } }, select: { meterId: true, reference: true } }) : [];
        const seen = new Set(had.map((h) => `${h.meterId}|${h.reference}`));
        let recorded = 0;
        let duplicates = 0;
        const data: Prisma.UsageRecordCreateManyInput[] = [];
        for (const r of rows) {
          const m = meters.find((x) => x.code === r.meter)!;
          const reference = clean(r.reference);
          if (reference) {
            const k = `${m.id}|${reference}`;
            if (seen.has(k)) {
              duplicates++;
              continue;
            }
            seen.add(k);
          }
          data.push({ orgId: org.id, contractId, meterId: m.id, usageDate: toDbDate(r.date), quantity: new D(r.quantity).toFixed(), reference, source, createdById: actor.id });
          recorded++;
        }
        if (data.length) await tx.usageRecord.createMany({ data });
        await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'usage.imported', entityType: 'sales_contract', entityId: contractId, data: { reference: ref(c.number), rows: rows.length, recorded, duplicates, source } });
        return { recorded, duplicates };
      },
      { timeout: 60_000 },
    );
    return { ...res, usage: await this.list(org, contractId, {}) };
  }

  /** Usage of the contract: unbilled by default, or one billed period. */
  async list(org: SalesOrg, contractId: string, f: { periodNo?: number; all?: boolean }) {
    await this.contract(this.prisma, org.id, contractId);
    const rows = await this.prisma.usageRecord.findMany({
      where: { orgId: org.id, contractId, ...(f.periodNo ? { periodNo: f.periodNo } : f.all ? {} : { periodNo: null }) },
      orderBy: [{ usageDate: 'desc' }, { createdAt: 'desc' }],
      take: 500,
      include: { meter: { select: { code: true, name: true, unit: true } } },
    });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.createdById, r.voidedById].filter((x): x is string => !!x)))] } }, select: { id: true, name: true, email: true } });
    const who = (id: string | null) => (id ? (users.find((u) => u.id === id)?.name || users.find((u) => u.id === id)?.email || 'A member') : null);
    return rows.map((r) => ({
      id: r.id,
      meter: r.meter,
      date: fromDbDate(r.usageDate),
      quantity: r.quantity.toFixed(),
      reference: r.reference,
      note: r.note,
      source: r.source,
      periodNo: r.periodNo,
      documentId: r.documentId,
      recordedBy: who(r.createdById),
      createdAt: r.createdAt.toISOString(),
      voided: r.voidedAt ? { at: r.voidedAt.toISOString(), by: who(r.voidedById), reason: r.voidReason } : null,
    }));
  }

  async void(org: SalesOrg, actor: Actor, contractId: string, recordId: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const c = await this.contract(tx, org.id, contractId, true);
      const r = await tx.usageRecord.findFirst({ where: { id: recordId, contractId, orgId: org.id } });
      if (!r) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Usage not found' });
      if (r.voidedAt) this.sales.invalid('This usage is already voided', 'USAGE_VOIDED');
      if (r.periodNo) this.sales.invalid('Billed usage cannot be voided; credit the invoice and record an adjustment', 'USAGE_BILLED');
      await tx.usageRecord.update({ where: { id: recordId }, data: { voidedAt: new Date(), voidedById: actor.id, voidReason: reason.trim() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'usage.voided', entityType: 'sales_contract', entityId: contractId, data: { reference: ref(c.number), usageId: recordId, quantity: r.quantity.toFixed(), reason: reason.trim() } });
    });
    return this.list(org, contractId, {});
  }

  // ------------------------------------------------------------------ billing (called by ContractsService)

  /**
   * The usage lines for one period of a contract: every active meter's usage dated in the period
   * that is not voided (and not billed to another period), priced by the meter. Returns the lines
   * and the readings they cover, to be stamped with the period and invoice once it is made.
   */
  async forPeriod(tx: Tx, orgId: string, contractId: string, p: { no: number; start: string; end: string }) {
    const meters = await tx.contractMeter.findMany({ where: { orgId, contractId, active: true }, orderBy: { createdAt: 'asc' } });
    if (!meters.length) return { lines: [], ids: [] as string[] };
    const rows = await tx.usageRecord.findMany({
      where: { orgId, contractId, voidedAt: null, meterId: { in: meters.map((m) => m.id) }, OR: [{ periodNo: p.no }, { periodNo: null, usageDate: { gte: toDbDate(p.start), lte: toDbDate(p.end) } }] },
      select: { id: true, meterId: true, quantity: true },
    });
    const lines: { accountId: string; description: string; quantity: string; unitPrice: string; taxRateId: string | null; hsnCode: string | null }[] = [];
    for (const m of meters) {
      const used = rows.filter((r) => r.meterId === m.id).reduce((s, r) => s.plus(r.quantity.toFixed()), new D(0));
      const charge = usageCharge(this.pricing(m), used.toFixed(), { name: m.name, unit: m.unit, period: periodLabel(p) });
      for (const l of charge.lines) {
        if (new D(l.quantity).lte(0) || new D(l.unitPrice).lte(0)) continue;
        lines.push({ accountId: m.accountId, description: l.description.slice(0, 500), quantity: l.quantity, unitPrice: l.unitPrice, taxRateId: m.taxRateId, hsnCode: m.hsnCode });
      }
    }
    return { lines, ids: rows.map((r) => r.id) };
  }

  async stamp(tx: Tx, ids: string[], periodNo: number, documentId: string) {
    if (ids.length) await tx.usageRecord.updateMany({ where: { id: { in: ids } }, data: { periodNo, documentId } });
  }

  async hasMeters(db: Db, orgId: string, contractId: string) {
    return (await db.contractMeter.count({ where: { orgId, contractId } })) > 0;
  }
}

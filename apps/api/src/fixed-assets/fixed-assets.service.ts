import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  addMonth,
  checkAssetTerms,
  D,
  depreciationSchedule,
  disposalEntry,
  firstChargeMonth,
  fullyDepreciatedIn,
  minorUnits,
  monthEnd,
  type AssetTerms,
  type DepreciationMethod,
} from '@talk2tax/accounting-engine';
import { FixedAsset } from '@talk2tax/database';
import { hasPermission, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import { JournalsService } from '../journals/journals.service';
import { todayIst } from '../tasks/tasks.service';

export interface AssetOrg {
  id: string;
  role: RoleName;
  functionalCurrency: string;
  fiscalYearStartMonth: number;
}
type Actor = { id: string };

export interface AssetInput {
  name: string;
  category?: string | null;
  serialNumber?: string | null;
  location?: string | null;
  assetAccountId: string;
  accumulatedAccountId: string;
  expenseAccountId: string;
  acquisitionDate: string;
  inServiceDate: string;
  cost: string;
  residualValue: string;
  method: DepreciationMethod;
  usefulLifeMonths?: number | null;
  annualRate?: string | null;
  openingAccumulated?: string | null;
  depreciatedThrough?: string | null;
  /** Record the purchase here: debit the asset account, credit this account (bank, cash, a loan or a supplier clearing account). */
  fundingAccountId?: string | null;
}

export interface DisposalInput {
  date: string;
  proceeds: string;
  proceedsAccountId?: string | null;
  gainLossAccountId: string;
  note?: string | null;
}

const ACCOUNT_RULES = {
  assetAccountId: { subtype: 'FIXED_ASSET', label: 'The asset account must be a fixed asset account' },
  accumulatedAccountId: { subtype: 'ACCUMULATED_DEPRECIATION', label: 'The accumulated depreciation account must be an accumulated depreciation account' },
  expenseAccountId: { subtype: 'DEPRECIATION', label: 'The depreciation expense account must be a depreciation account' },
} as const;

const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

@Injectable()
export class FixedAssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly journals: JournalsService,
  ) {}

  // ------------------------------------------------------------------ helpers

  private terms(a: FixedAsset): AssetTerms {
    return {
      cost: new D(a.cost.toString()).toFixed(),
      residualValue: new D(a.residualValue.toString()).toFixed(),
      inServiceDate: fromDbDate(a.inServiceDate),
      method: a.method,
      usefulLifeMonths: a.usefulLifeMonths,
      annualRate: a.annualRate ? new D(a.annualRate.toString()).toFixed() : null,
      openingAccumulated: new D(a.openingAccumulated.toString()).toFixed(),
      depreciatedThrough: a.depreciatedThrough,
      disposedOn: a.disposedOn ? fromDbDate(a.disposedOn) : null,
    };
  }

  /** Amounts posted for each asset by month, from runs that stand. */
  private async posted(db: Tx | PrismaService, orgId: string, assetIds?: string[]) {
    const lines = await db.depreciationLine.findMany({ where: { orgId, run: { status: 'POSTED' }, ...(assetIds ? { assetId: { in: assetIds } } : {}) }, select: { assetId: true, month: true, amount: true } });
    const map = new Map<string, Record<string, string>>();
    for (const l of lines) {
      const m = map.get(l.assetId) ?? {};
      m[l.month] = new D(m[l.month] ?? 0).plus(l.amount.toString()).toFixed();
      map.set(l.assetId, m);
    }
    return map;
  }

  private accumulated(a: FixedAsset, posted: Record<string, string> = {}) {
    return Object.values(posted).reduce((s, v) => s.plus(v), new D(a.openingAccumulated.toString()));
  }

  private async checkAccounts(db: Tx, orgId: string, input: Pick<AssetInput, 'assetAccountId' | 'accumulatedAccountId' | 'expenseAccountId'>) {
    const ids = [input.assetAccountId, input.accumulatedAccountId, input.expenseAccountId];
    const accounts = await db.account.findMany({ where: { orgId, id: { in: ids } } });
    const errors: string[] = [];
    for (const [field, rule] of Object.entries(ACCOUNT_RULES) as [keyof typeof ACCOUNT_RULES, (typeof ACCOUNT_RULES)[keyof typeof ACCOUNT_RULES]][]) {
      const a = accounts.find((x) => x.id === input[field]);
      if (!a || a.subtype !== rule.subtype) errors.push(rule.label);
      else if (!a.isPostable || !a.isActive) errors.push(`${a.code} ${a.name} is not an active posting account`);
    }
    if (errors.length) throw new DomainError('ASSET_INVALID', errors[0], HttpStatus.UNPROCESSABLE_ENTITY, { errors });
  }

  private validateTerms(org: AssetOrg, input: AssetInput) {
    const errors = checkAssetTerms(
      {
        cost: input.cost,
        residualValue: input.residualValue,
        acquisitionDate: input.acquisitionDate,
        inServiceDate: input.inServiceDate,
        method: input.method,
        usefulLifeMonths: input.method === 'STRAIGHT_LINE' ? (input.usefulLifeMonths ?? null) : null,
        annualRate: input.method === 'WRITTEN_DOWN_VALUE' ? (input.annualRate ?? null) : null,
        openingAccumulated: input.openingAccumulated || '0',
        depreciatedThrough: input.depreciatedThrough || null,
      },
      minorUnits(org.functionalCurrency),
    );
    if (input.fundingAccountId && new D(input.openingAccumulated || '0').gt(0)) errors.push('An asset brought in with opening depreciation is already in the books: do not record its purchase again');
    if (input.depreciatedThrough && input.depreciatedThrough >= todayIst().slice(0, 7)) errors.push('The opening depreciation can only run to a month before this one');
    if (errors.length) throw new DomainError('ASSET_INVALID', errors[0], HttpStatus.UNPROCESSABLE_ENTITY, { errors });
  }

  private async nextNumber(tx: Tx, orgId: string) {
    const [{ value }] = await tx.$queryRaw<{ value: number }[]>`
      INSERT INTO org_counters (org_id, key, value) VALUES (${orgId}::uuid, 'fixed_asset', 1)
      ON CONFLICT (org_id, key) DO UPDATE SET value = org_counters.value + 1
      RETURNING value`;
    return value;
  }

  private async lockAsset(tx: Tx, orgId: string, id: string) {
    await tx.$queryRaw`SELECT id FROM fixed_assets WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid FOR UPDATE`;
    const a = await tx.fixedAsset.findFirst({ where: { id, orgId } });
    if (!a) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Asset not found' });
    return a;
  }

  private async names(ids: (string | null | undefined)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    const users = await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private lockOrg(tx: Tx, orgId: string) {
    return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'fixed-assets:' + orgId}))`;
  }

  // ------------------------------------------------------------------ register

  async list(org: AssetOrg) {
    const assets = await this.prisma.fixedAsset.findMany({ where: { orgId: org.id }, orderBy: { number: 'asc' } });
    const posted = await this.posted(this.prisma, org.id);
    const accounts = await this.prisma.account.findMany({ where: { orgId: org.id, id: { in: [...new Set(assets.flatMap((a) => [a.assetAccountId, a.accumulatedAccountId, a.expenseAccountId]))] } }, select: { id: true, code: true, name: true } });
    const acct = (id: string) => accounts.find((a) => a.id === id) ?? null;
    const scale = minorUnits(org.functionalCurrency);
    const rows = assets.map((a) => {
      const p = posted.get(a.id) ?? {};
      const acc = this.accumulated(a, p);
      const months = Object.keys(p).sort();
      const through = months.at(-1) ?? a.depreciatedThrough;
      return {
        id: a.id,
        number: a.number,
        reference: `FA-${String(a.number).padStart(4, '0')}`,
        name: a.name,
        category: a.category,
        location: a.location,
        status: a.status,
        method: a.method,
        assetAccount: acct(a.assetAccountId),
        acquisitionDate: fromDbDate(a.acquisitionDate),
        inServiceDate: fromDbDate(a.inServiceDate),
        cost: new D(a.cost.toString()).toFixed(scale),
        accumulated: acc.toFixed(scale),
        netBookValue: a.status === 'DISPOSED' ? (0).toFixed(scale) : new D(a.cost.toString()).minus(acc).toFixed(scale),
        depreciatedThrough: through,
        disposedOn: a.disposedOn ? fromDbDate(a.disposedOn) : null,
      };
    });
    const active = rows.filter((r) => r.status === 'ACTIVE');
    const total = (k: 'cost' | 'accumulated' | 'netBookValue') => active.reduce((s, r) => s.plus(r[k]), new D(0)).toFixed(scale);
    return { assets: rows, totals: { active: active.length, disposed: rows.length - active.length, cost: total('cost'), accumulated: total('accumulated'), netBookValue: total('netBookValue') }, can: { manage: hasPermission(org.role, 'assets.manage') } };
  }

  async get(org: AssetOrg, id: string) {
    const a = await this.prisma.fixedAsset.findFirst({ where: { id, orgId: org.id } });
    if (!a) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Asset not found' });
    const p = (await this.posted(this.prisma, org.id, [a.id])).get(a.id) ?? {};
    const scale = minorUnits(org.functionalCurrency);
    const t = this.terms(a);
    const now = todayIst().slice(0, 7);
    const lines = await this.prisma.depreciationLine.findMany({ where: { orgId: org.id, assetId: a.id }, include: { run: true }, orderBy: [{ month: 'asc' }] });
    const entryIds = [a.acquisitionEntryId, a.disposalEntryId, ...lines.map((l) => l.run.journalEntryId)].filter((x): x is string => !!x);
    const entries = await this.prisma.journalEntry.findMany({ where: { orgId: org.id, id: { in: entryIds } }, select: { id: true, entryNumber: true } });
    const entry = (eid: string | null) => (eid ? (entries.find((e) => e.id === eid) ?? null) : null);
    const accounts = await this.prisma.account.findMany({ where: { orgId: org.id, id: { in: [a.assetAccountId, a.accumulatedAccountId, a.expenseAccountId] } }, select: { id: true, code: true, name: true } });
    const acc = this.accumulated(a, p);
    // The schedule: what has happened, and the next 12 months (or to the end of the life).
    const horizon = addMonth(now > firstChargeMonth(t) ? now : firstChargeMonth(t), 12);
    const schedule = depreciationSchedule(t, horizon, p, org.fiscalYearStartMonth, scale).filter((r) => new D(r.charge).gt(0) || r.posted);
    const names = await this.names([a.createdById, a.disposedById, ...lines.map((l) => l.run.postedById)]);
    return {
      id: a.id,
      number: a.number,
      reference: `FA-${String(a.number).padStart(4, '0')}`,
      name: a.name,
      category: a.category,
      serialNumber: a.serialNumber,
      location: a.location,
      status: a.status,
      accounts: { asset: accounts.find((x) => x.id === a.assetAccountId) ?? null, accumulated: accounts.find((x) => x.id === a.accumulatedAccountId) ?? null, expense: accounts.find((x) => x.id === a.expenseAccountId) ?? null },
      acquisitionDate: fromDbDate(a.acquisitionDate),
      inServiceDate: fromDbDate(a.inServiceDate),
      cost: new D(a.cost.toString()).toFixed(scale),
      residualValue: new D(a.residualValue.toString()).toFixed(scale),
      method: a.method,
      usefulLifeMonths: a.usefulLifeMonths,
      annualRate: a.annualRate ? new D(a.annualRate.toString()).toFixed(2) : null,
      openingAccumulated: new D(a.openingAccumulated.toString()).toFixed(scale),
      depreciatedThrough: a.depreciatedThrough,
      accumulated: acc.toFixed(scale),
      netBookValue: a.status === 'DISPOSED' ? (0).toFixed(scale) : new D(a.cost.toString()).minus(acc).toFixed(scale),
      fullyDepreciatedIn: a.status === 'ACTIVE' ? fullyDepreciatedIn(t, p, org.fiscalYearStartMonth) : null,
      termsFixed: lines.length > 0 || a.status === 'DISPOSED',
      acquisitionEntry: entry(a.acquisitionEntryId),
      disposal: a.status === 'DISPOSED'
        ? { date: fromDbDate(a.disposedOn!), proceeds: new D(a.disposalProceeds!.toString()).toFixed(scale), note: a.disposalNote, by: names.get(a.disposedById!) ?? 'Former member', entry: entry(a.disposalEntryId) }
        : null,
      postings: lines.map((l) => ({ month: l.month, amount: new D(l.amount.toString()).toFixed(scale), runMonth: l.run.month, runStatus: l.run.status, entry: entry(l.run.journalEntryId), postedBy: names.get(l.run.postedById) ?? 'Former member' })),
      schedule,
      createdBy: names.get(a.createdById) ?? 'Former member',
      createdAt: a.createdAt.toISOString(),
      can: { manage: hasPermission(org.role, 'assets.manage') },
    };
  }

  async create(org: AssetOrg, actor: Actor, input: AssetInput) {
    this.validateTerms(org, input);
    const id = await this.prisma.$transaction(async (tx) => {
      await this.checkAccounts(tx, org.id, input);
      const number = await this.nextNumber(tx, org.id);
      const reference = `FA-${String(number).padStart(4, '0')}`;
      let acquisitionEntryId: string | null = null;
      if (input.fundingAccountId) {
        const je = await this.journals.postSystemEntry(tx, org, actor, {
          date: input.acquisitionDate,
          source: 'ASSET',
          memo: `Purchase of ${input.name} (${reference})`,
          reference,
          lines: [
            { accountId: input.assetAccountId, debit: input.cost, description: input.name },
            { accountId: input.fundingAccountId, credit: input.cost, description: input.name },
          ],
        });
        acquisitionEntryId = je.id;
      }
      const a = await tx.fixedAsset.create({
        data: {
          orgId: org.id,
          number,
          name: input.name.trim(),
          category: input.category?.trim() || null,
          serialNumber: input.serialNumber?.trim() || null,
          location: input.location?.trim() || null,
          assetAccountId: input.assetAccountId,
          accumulatedAccountId: input.accumulatedAccountId,
          expenseAccountId: input.expenseAccountId,
          acquisitionDate: toDbDate(input.acquisitionDate),
          inServiceDate: toDbDate(input.inServiceDate),
          cost: input.cost,
          residualValue: input.residualValue,
          method: input.method,
          usefulLifeMonths: input.method === 'STRAIGHT_LINE' ? input.usefulLifeMonths! : null,
          annualRate: input.method === 'WRITTEN_DOWN_VALUE' ? input.annualRate! : null,
          openingAccumulated: input.openingAccumulated || '0',
          depreciatedThrough: input.depreciatedThrough || null,
          acquisitionEntryId,
          createdById: actor.id,
        },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'fixed_asset.created', entityType: 'fixed_asset', entityId: a.id, data: { reference, name: a.name, cost: input.cost, method: input.method, acquisitionEntryId } });
      return a.id;
    });
    return this.get(org, id);
  }

  /** Change an asset. Its name, category, serial number and location can always change; its terms only until depreciation is posted for it. */
  async update(org: AssetOrg, actor: Actor, id: string, input: AssetInput) {
    await this.prisma.$transaction(async (tx) => {
      const a = await this.lockAsset(tx, org.id, id);
      if (a.status === 'DISPOSED') throw new DomainError('ASSET_DISPOSED', 'A disposed asset cannot be changed', HttpStatus.CONFLICT);
      const t = this.terms(a);
      const termsChanged =
        !new D(input.cost).eq(t.cost) || !new D(input.residualValue).eq(t.residualValue) || input.method !== t.method || input.inServiceDate !== t.inServiceDate || input.acquisitionDate !== fromDbDate(a.acquisitionDate) ||
        (input.method === 'STRAIGHT_LINE' ? (input.usefulLifeMonths ?? null) !== t.usefulLifeMonths : !new D(input.annualRate || '0').eq(t.annualRate || '0')) ||
        !new D(input.openingAccumulated || '0').eq(t.openingAccumulated) || (input.depreciatedThrough || null) !== t.depreciatedThrough ||
        input.assetAccountId !== a.assetAccountId || input.accumulatedAccountId !== a.accumulatedAccountId || input.expenseAccountId !== a.expenseAccountId;
      if (termsChanged) {
        if (await tx.depreciationLine.count({ where: { orgId: org.id, assetId: id } })) throw new DomainError('ASSET_TERMS_FIXED', 'Depreciation has been posted for this asset, so its cost, dates, accounts and depreciation terms are fixed. Reverse the depreciation runs first to change them.', HttpStatus.CONFLICT);
        if (a.acquisitionEntryId && (!new D(input.cost).eq(t.cost) || input.acquisitionDate !== fromDbDate(a.acquisitionDate) || input.assetAccountId !== a.assetAccountId)) {
          throw new DomainError('ASSET_TERMS_FIXED', 'The purchase of this asset was posted here, so its cost, acquisition date and asset account are fixed', HttpStatus.CONFLICT);
        }
        this.validateTerms(org, { ...input, fundingAccountId: null });
        await this.checkAccounts(tx, org.id, input);
      }
      if (!input.name.trim()) throw new DomainError('ASSET_INVALID', 'Give the asset a name');
      await tx.fixedAsset.update({
        where: { id },
        data: {
          name: input.name.trim(),
          category: input.category?.trim() || null,
          serialNumber: input.serialNumber?.trim() || null,
          location: input.location?.trim() || null,
          ...(termsChanged
            ? {
                assetAccountId: input.assetAccountId,
                accumulatedAccountId: input.accumulatedAccountId,
                expenseAccountId: input.expenseAccountId,
                acquisitionDate: toDbDate(input.acquisitionDate),
                inServiceDate: toDbDate(input.inServiceDate),
                cost: input.cost,
                residualValue: input.residualValue,
                method: input.method,
                usefulLifeMonths: input.method === 'STRAIGHT_LINE' ? input.usefulLifeMonths! : null,
                annualRate: input.method === 'WRITTEN_DOWN_VALUE' ? input.annualRate! : null,
                openingAccumulated: input.openingAccumulated || '0',
                depreciatedThrough: input.depreciatedThrough || null,
              }
            : {}),
        },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'fixed_asset.updated', entityType: 'fixed_asset', entityId: id, data: { termsChanged, name: input.name.trim() } });
    });
    return this.get(org, id);
  }

  // ------------------------------------------------------------------ depreciation

  /** What a run for `month` would post: each active asset's charges for that month and any earlier month not yet posted. */
  private async workOut(db: Tx | PrismaService, org: AssetOrg, month: string) {
    const assets = await db.fixedAsset.findMany({ where: { orgId: org.id, status: 'ACTIVE' }, orderBy: { number: 'asc' } });
    const posted = await this.posted(db, org.id, assets.map((a) => a.id));
    const scale = minorUnits(org.functionalCurrency);
    const lines: { asset: FixedAsset; month: string; amount: string }[] = [];
    for (const a of assets) {
      for (const r of depreciationSchedule(this.terms(a), month, posted.get(a.id) ?? {}, org.fiscalYearStartMonth, scale)) {
        if (!r.posted && new D(r.charge).gt(0)) lines.push({ asset: a, month: r.month, amount: r.charge });
      }
    }
    return lines;
  }

  async depreciation(org: AssetOrg, month?: string) {
    const runs = await this.prisma.depreciationRun.findMany({ where: { orgId: org.id }, orderBy: [{ month: 'desc' }, { postedAt: 'desc' }], take: 60, include: { _count: { select: { lines: true } } } });
    const current = todayIst().slice(0, 7);
    const lastPosted = runs.find((r) => r.status === 'POSTED')?.month ?? null;
    let next: string | null;
    if (lastPosted) next = addMonth(lastPosted, 1);
    else {
      const assets = await this.prisma.fixedAsset.findMany({ where: { orgId: org.id, status: 'ACTIVE' } });
      next = assets.length ? assets.map((a) => firstChargeMonth(this.terms(a))).sort()[0]! : null;
    }
    if (next && next > current) next = null;
    const target = month ?? next;
    const scale = minorUnits(org.functionalCurrency);
    const preview = target ? await this.workOut(this.prisma, org, target) : [];
    const entryIds = runs.flatMap((r) => [r.journalEntryId, r.reversalEntryId]).filter((x): x is string => !!x);
    const entries = await this.prisma.journalEntry.findMany({ where: { orgId: org.id, id: { in: entryIds } }, select: { id: true, entryNumber: true } });
    const names = await this.names(runs.flatMap((r) => [r.postedById, r.reversedById]));
    const period = target ? await this.prisma.fiscalPeriod.findFirst({ where: { orgId: org.id, startDate: { lte: toDbDate(monthEnd(target)) }, endDate: { gte: toDbDate(monthEnd(target)) } } }) : null;
    return {
      currentMonth: current,
      lastPosted,
      nextMonth: next,
      month: target,
      monthName: target ? monthLabel(target) : null,
      period: period ? { name: period.name, status: period.status } : null,
      alreadyPosted: target ? runs.some((r) => r.status === 'POSTED' && r.month === target) : false,
      preview: preview.map((l) => ({ assetId: l.asset.id, reference: `FA-${String(l.asset.number).padStart(4, '0')}`, name: l.asset.name, month: l.month, amount: l.amount, catchUp: l.month !== target })),
      previewTotal: preview.reduce((s, l) => s.plus(l.amount), new D(0)).toFixed(scale),
      runs: runs.map((r) => ({
        id: r.id,
        month: r.month,
        monthName: monthLabel(r.month),
        status: r.status,
        total: new D(r.total.toString()).toFixed(scale),
        lines: r._count.lines,
        entry: entries.find((e) => e.id === r.journalEntryId) ?? null,
        reversal: entries.find((e) => e.id === r.reversalEntryId) ?? null,
        postedBy: names.get(r.postedById) ?? 'Former member',
        postedAt: r.postedAt.toISOString(),
        reversedBy: r.reversedById ? (names.get(r.reversedById) ?? 'Former member') : null,
        reversedAt: r.reversedAt?.toISOString() ?? null,
        canReverse: r.status === 'POSTED' && r.month === lastPosted,
      })),
      can: { manage: hasPermission(org.role, 'assets.manage') },
    };
  }

  /** Post the month's depreciation as one journal on the last day of the month. */
  async run(org: AssetOrg, actor: Actor, month: string) {
    const current = todayIst().slice(0, 7);
    if (month > current) throw new DomainError('MONTH_NOT_OVER', 'Depreciation can be posted for this month or earlier, not for a month still to come', HttpStatus.CONFLICT);
    await this.prisma.$transaction(
      async (tx) => {
        await this.lockOrg(tx, org.id);
        const last = await tx.depreciationRun.findFirst({ where: { orgId: org.id, status: 'POSTED' }, orderBy: { month: 'desc' } });
        if (last && month <= last.month) throw new DomainError('MONTH_ALREADY_RUN', `Depreciation is posted through ${monthLabel(last.month)}. Post ${monthLabel(addMonth(last.month, 1))} next, or reverse ${monthLabel(last.month)} first.`, HttpStatus.CONFLICT);
        const lines = await this.workOut(tx, org, month);
        if (!lines.length) throw new DomainError('NOTHING_TO_DEPRECIATE', `No depreciation is due for ${monthLabel(month)}`, HttpStatus.CONFLICT);
        const byAccount = new Map<string, { debit: InstanceType<typeof D>; credit: InstanceType<typeof D> }>();
        const add = (id: string, side: 'debit' | 'credit', amt: string) => {
          const e = byAccount.get(id) ?? { debit: new D(0), credit: new D(0) };
          e[side] = e[side].plus(amt);
          byAccount.set(id, e);
        };
        for (const l of lines) {
          add(l.asset.expenseAccountId, 'debit', l.amount);
          add(l.asset.accumulatedAccountId, 'credit', l.amount);
        }
        const scale = minorUnits(org.functionalCurrency);
        const total = lines.reduce((s, l) => s.plus(l.amount), new D(0));
        const je = await this.journals.postSystemEntry(tx, org, actor, {
          date: monthEnd(month),
          source: 'ASSET',
          memo: `Depreciation for ${monthLabel(month)} (${new Set(lines.map((l) => l.asset.id)).size} assets)`,
          reference: `DEP-${month}`,
          lines: [...byAccount.entries()].flatMap(([accountId, v]) => [
            ...(v.debit.gt(0) ? [{ accountId, debit: v.debit.toFixed(scale), description: `Depreciation ${monthLabel(month)}` }] : []),
            ...(v.credit.gt(0) ? [{ accountId, credit: v.credit.toFixed(scale), description: `Depreciation ${monthLabel(month)}` }] : []),
          ]),
        });
        const run = await tx.depreciationRun.create({ data: { orgId: org.id, month, total: total.toFixed(scale), journalEntryId: je.id, postedById: actor.id } });
        await tx.depreciationLine.createMany({ data: lines.map((l) => ({ orgId: org.id, runId: run.id, assetId: l.asset.id, month: l.month, amount: l.amount })) });
        await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'depreciation.posted', entityType: 'depreciation_run', entityId: run.id, data: { month, total: total.toFixed(scale), assets: new Set(lines.map((l) => l.asset.id)).size, lines: lines.length, journalEntryId: je.id, entryNumber: je.entryNumber } });
      },
      { timeout: 60_000 },
    );
    return this.depreciation(org);
  }

  /** Reverse the latest run (its journal is reversed on the same date). */
  async reverse(org: AssetOrg, actor: Actor, runId: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockOrg(tx, org.id);
      const run = await tx.depreciationRun.findFirst({ where: { id: runId, orgId: org.id } });
      if (!run) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Depreciation run not found' });
      if (run.status !== 'POSTED') throw new DomainError('RUN_REVERSED', 'This run is already reversed', HttpStatus.CONFLICT);
      const last = await tx.depreciationRun.findFirst({ where: { orgId: org.id, status: 'POSTED' }, orderBy: { month: 'desc' } });
      if (last!.id !== run.id) throw new DomainError('NOT_LATEST_RUN', `Reverse ${monthLabel(last!.month)} first: runs are reversed latest first`, HttpStatus.CONFLICT);
      const disposed = await tx.fixedAsset.findMany({ where: { orgId: org.id, status: 'DISPOSED', lines: { some: { runId } } }, select: { number: true } });
      if (disposed.length) throw new DomainError('ASSET_DISPOSED', `FA-${String(disposed[0]!.number).padStart(4, '0')} in this run has been disposed of, so the run stands`, HttpStatus.CONFLICT);
      const original = await tx.journalEntry.findFirstOrThrow({ where: { id: run.journalEntryId, orgId: org.id } });
      const rev = await this.journals.reverseSystemEntry(tx, org, actor, run.journalEntryId, { date: fromDbDate(original.date), memo: `Reversal of depreciation for ${monthLabel(run.month)}` });
      await tx.depreciationRun.update({ where: { id: runId }, data: { status: 'REVERSED', reversalEntryId: rev.id, reversedById: actor.id, reversedAt: new Date() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'depreciation.reversed', entityType: 'depreciation_run', entityId: runId, data: { month: run.month, reversalEntryId: rev.id, entryNumber: rev.entryNumber } });
    });
    return this.depreciation(org);
  }

  // ------------------------------------------------------------------ disposal

  async dispose(org: AssetOrg, actor: Actor, id: string, input: DisposalInput) {
    const scale = minorUnits(org.functionalCurrency);
    const proceeds = new D(input.proceeds);
    if (proceeds.lt(0) || proceeds.decimalPlaces() > scale) throw new DomainError('DISPOSAL_INVALID', 'Proceeds must be zero or more, in the currency\'s units');
    if (proceeds.gt(0) && !input.proceedsAccountId) throw new DomainError('DISPOSAL_INVALID', 'Say which account received the proceeds');
    if (input.date > todayIst()) throw new DomainError('DISPOSAL_INVALID', 'A disposal cannot be dated in the future');
    await this.prisma.$transaction(
      async (tx) => {
        await this.lockOrg(tx, org.id);
        const a = await this.lockAsset(tx, org.id, id);
        if (a.status === 'DISPOSED') throw new DomainError('ASSET_DISPOSED', 'This asset has already been disposed of', HttpStatus.CONFLICT);
        if (input.date < fromDbDate(a.inServiceDate)) throw new DomainError('DISPOSAL_INVALID', 'An asset cannot be disposed of before it was put to use');
        const dm = input.date.slice(0, 7);
        const p = (await this.posted(tx, org.id, [a.id])).get(a.id) ?? {};
        const later = Object.keys(p).filter((m) => m > dm).sort();
        if (later.length) throw new DomainError('DEPRECIATION_AFTER_DISPOSAL', `Depreciation is posted for ${monthLabel(later[0]!)}, after the disposal. Reverse the depreciation run for ${monthLabel(later.at(-1)!)} first.`, HttpStatus.CONFLICT);
        const due = depreciationSchedule(this.terms(a), dm, p, org.fiscalYearStartMonth, scale).filter((r) => !r.posted && new D(r.charge).gt(0));
        if (due.length) throw new DomainError('DEPRECIATION_NOT_POSTED', `Post depreciation through ${monthLabel(due.at(-1)!.month)} first (an asset is depreciated through the month it is disposed of), so it leaves the books at its right value`, HttpStatus.CONFLICT);
        const gl = await tx.account.findFirst({ where: { orgId: org.id, id: input.gainLossAccountId } });
        if (!gl || (gl.type !== 'REVENUE' && gl.type !== 'EXPENSE')) throw new DomainError('DISPOSAL_INVALID', 'The gain or loss goes to an income or expense account');
        const accumulated = this.accumulated(a, p);
        const entry = disposalEntry(new D(a.cost.toString()).toFixed(scale), accumulated.toFixed(scale), proceeds.toFixed(scale), scale);
        const reference = `FA-${String(a.number).padStart(4, '0')}`;
        const accountFor = { PROCEEDS: input.proceedsAccountId!, ACCUMULATED: a.accumulatedAccountId, COST: a.assetAccountId, GAIN_LOSS: input.gainLossAccountId };
        const je = await this.journals.postSystemEntry(tx, org, actor, {
          date: input.date,
          source: 'ASSET',
          memo: `Disposal of ${a.name} (${reference})${input.note ? `: ${input.note}` : ''}`,
          reference,
          lines: entry.lines.map((l) => ({ accountId: accountFor[l.role], debit: l.debit, credit: l.credit, description: `Disposal of ${a.name}` })),
        });
        await tx.fixedAsset.update({ where: { id }, data: { status: 'DISPOSED', disposedOn: toDbDate(input.date), disposalProceeds: proceeds.toFixed(scale), disposalEntryId: je.id, disposalNote: input.note?.trim() || null, disposedById: actor.id } });
        await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'fixed_asset.disposed', entityType: 'fixed_asset', entityId: id, data: { reference, date: input.date, proceeds: proceeds.toFixed(scale), netBookValue: entry.netBookValue, gain: entry.gain, journalEntryId: je.id, entryNumber: je.entryNumber } });
      },
      { timeout: 30_000 },
    );
    return this.get(org, id);
  }

  /** Accounts the forms offer. */
  async accounts(org: AssetOrg) {
    const rows = await this.prisma.account.findMany({ where: { orgId: org.id, isPostable: true, isActive: true }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true, type: true, subtype: true } });
    const control = await this.prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { arAccountId: true, apAccountId: true, claimsAccountId: true } });
    const isControl = (id: string) => [control.arAccountId, control.apAccountId, control.claimsAccountId].includes(id);
    return {
      asset: rows.filter((a) => a.subtype === 'FIXED_ASSET'),
      accumulated: rows.filter((a) => a.subtype === 'ACCUMULATED_DEPRECIATION'),
      expense: rows.filter((a) => a.subtype === 'DEPRECIATION'),
      funding: rows.filter((a) => (a.type === 'ASSET' || a.type === 'LIABILITY' || a.type === 'EQUITY') && !isControl(a.id) && !['FIXED_ASSET', 'ACCUMULATED_DEPRECIATION'].includes(a.subtype ?? '')),
      gainLoss: rows.filter((a) => a.type === 'REVENUE' || a.type === 'EXPENSE'),
    };
  }
}


import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { D, DEMO_ORGS_PER_PERSON, DEMO_PROFILES, demoLabelIssues, demoPlan, demoProfile, fiscalYearForDate, spreadEvenly, type DemoProfile } from '@talk2tax/accounting-engine';
import { hasPermission } from '@talk2tax/security';
import { gstinCheckCharacter, vatJurisdiction } from '@talk2tax/tax-engine';
import { AlertsService } from '../alerts/alerts.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { BankingService } from '../banking/banking.service';
import { BudgetsService } from '../budgets/budgets.service';
import { CfoService } from '../cfo/cfo.service';
import { todayIso } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runAsSystem, runInOrg } from '../common/tenant-context';
import { ComplianceService } from '../compliance/compliance.service';
import { ContactsService } from '../contacts/contacts.service';
import { CountryModulesService } from '../country-modules/country-modules.service';
import { demoOrganisations } from '../db/collections/demo-organisations';
import { DimensionsService } from '../dimensions/dimensions.service';
import { GstService } from '../gst/gst.service';
import { JournalsService } from '../journals/journals.service';
import { KpisService } from '../kpis/kpis.service';
import { DocumentsService } from '../ledgers/documents.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { PayrollService } from '../payroll/payroll.service';
import { PeriodsService } from '../periods/periods.service';
import { TaxRatesService } from '../tax-rates/tax-rates.service';
import { VatReturnService } from '../vat-return/vat-return.service';

/** The profile as the picker shows it. */
function describe(p: DemoProfile) {
  return {
    key: p.key,
    title: p.title,
    summary: p.summary,
    orgName: p.orgName,
    countryCode: p.countryCode,
    currency: p.currency,
    fiscalYearStartMonth: p.fiscalYearStartMonth,
    customers: p.customers.length,
    vendors: p.vendors.length,
    projects: p.projects.length,
    staff: p.staff.length,
    payroll: p.payroll,
    salesTax: p.taxRate?.name ?? null,
  };
}

/** Made-up GSTIN from a made-up PAN, with a computed check character; it belongs to no one. */
const synthGstin = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;

/** Made-up registration numbers that pass each authority's format check and belong to no one. */
function synthVatNumber(country: string): string {
  if (country === 'GB') {
    // Seven digits weighted 8..2, then two check digits making the sum a multiple of 97.
    const base = [9, 9, 9, 0, 0, 0, 1];
    const sum = base.reduce((s, d, i) => s + d * (8 - i), 0); // not money: check digits
    const check = (97 - (sum % 97)) % 97; // not money: check digits
    return `GB${base.join('')}${String(check).padStart(2, '0')}`;
  }
  if (country === 'AE') return '100999000000003';
  if (country === 'DE') {
    const digits = [9, 9, 9, 0, 0, 0, 0, 1];
    let p = 10; // not money: check digit
    for (const d of digits) {
      let x = (d + p) % 10; // not money: check digit
      if (x === 0) x = 10;
      p = (2 * x) % 11; // not money: check digit
    }
    const check = 11 - p === 10 ? 0 : 11 - p; // not money: check digit
    return `DE${digits.join('')}${check}`;
  }
  throw new Error(`No synthetic VAT number for ${country}`);
}

/**
 * Demonstration organisations (DEMO-001 to DEMO-021): a person picks one of six made-up
 * companies and gets an organisation they own, flagged isDemo and named "(SYNTHETIC DATA)",
 * with six months of books posted through the ordinary services: customers and vendors,
 * invoices, bills and payments, journals, departments and projects, payroll (India) or salary
 * journals, a bank statement matched to the books, tax registrations and rates, filed returns
 * (India), a submitted budget, KPI targets and the checks' alerts. The CFO assessment then reads
 * these books like any others. Nothing here is a real business, person or registration.
 */
@Injectable()
export class DemoOrganisationsService {
  private readonly log = new Logger('DemoOrganisationsService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DocumentStoreService,
    private readonly audit: AuditService,
    private readonly orgs: OrganizationsService,
    private readonly periods: PeriodsService,
    private readonly contacts: ContactsService,
    private readonly docs: DocumentsService,
    private readonly journals: JournalsService,
    private readonly taxRates: TaxRatesService,
    private readonly gst: GstService,
    private readonly countryModules: CountryModulesService,
    private readonly vat: VatReturnService,
    private readonly dimensions: DimensionsService,
    private readonly payroll: PayrollService,
    private readonly banking: BankingService,
    private readonly budgets: BudgetsService,
    private readonly compliance: ComplianceService,
    private readonly kpis: KpisService,
    private readonly alerts: AlertsService,
    private readonly cfo: CfoService,
  ) {}

  profiles() {
    return { profiles: DEMO_PROFILES.map(describe), perPerson: DEMO_ORGS_PER_PERSON };
  }

  /** The demonstration organisations this person asked for (their own rows only). */
  private mine(userId: string) {
    return runAsSystem(() => this.store.collection(demoOrganisations).find({ createdById: userId }));
  }

  async create(user: AuthUser, profileKey: string) {
    const profile = demoProfile(profileKey);
    if (!profile) throw new DomainError('UNKNOWN_DEMO_PROFILE', 'Choose one of the demonstration companies', HttpStatus.UNPROCESSABLE_ENTITY);
    const issues = demoLabelIssues(profile);
    if (issues.length) throw new DomainError('DEMO_NOT_LABELLED', issues[0]!, HttpStatus.INTERNAL_SERVER_ERROR);
    const already = await this.mine(user.id);
    if (already.length >= DEMO_ORGS_PER_PERSON) throw new DomainError('DEMO_LIMIT', `You already have ${DEMO_ORGS_PER_PERSON} demonstration organisations`, HttpStatus.CONFLICT);
    const org = await this.orgs.create(user.id, {
      name: profile.orgName,
      legalName: profile.legalName,
      countryCode: profile.countryCode,
      functionalCurrency: profile.currency,
      fiscalYearStartMonth: profile.fiscalYearStartMonth,
      chartTemplate: 'GENERIC_SMB',
      isDemo: true,
    });
    return runInOrg(org.id, async () => {
      const record = await this.store
        .collection(demoOrganisations)
        .insertOne({ profile: profile.key, status: 'BUILDING', counts: {}, failure: null, createdById: user.id, createdAt: new Date(), finishedAt: null });
      try {
        const counts = await this.build(org.id, user, profile);
        await this.store.collection(demoOrganisations).updateOne({ id: record.id }, { $set: { status: 'READY', counts, finishedAt: new Date() } });
        await this.prisma.$transaction((tx) =>
          this.audit.append(tx, {
            orgId: org.id,
            actorId: user.id,
            action: 'demo_organisation.created',
            entityType: 'organization',
            entityId: org.id,
            data: { profile: profile.key, counts, synthetic: true },
          }),
        );
      } catch (e) {
        const message = (e as Error).message?.slice(0, 500) || 'The build stopped';
        this.log.error(`Demonstration organisation ${org.id} (${profile.key}) stopped: ${message}`);
        await this.store.collection(demoOrganisations).updateOne({ id: record.id }, { $set: { status: 'FAILED', failure: message, finishedAt: new Date() } });
      }
      return this.summaryFor(org.id, null);
    });
  }

  /** What was made in a demonstration organisation, and the CFO's recommendations from its books. */
  async summary(org: OrgContext) {
    return this.summaryFor(org.id, org);
  }

  private async summaryFor(orgId: string, org: OrgContext | null) {
    const row = await this.store.collection(demoOrganisations).findOne({});
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { id: true, name: true, isDemo: true, functionalCurrency: true, fiscalYearStartMonth: true } });
    if (!o.isDemo || !row) throw new DomainError('NOT_DEMO', 'This organisation is not a demonstration organisation', HttpStatus.NOT_FOUND);
    const profile = demoProfile(row.profile);
    let recommendations: { text: string; why: string; path: string | null; priority: string }[] | null = null;
    let headline: string | null = null;
    if (org && row.status === 'READY' && hasPermission(org.role, 'reports.read')) {
      try {
        const a = await this.cfo.assessment({ id: org.id, role: org.role, functionalCurrency: org.functionalCurrency, fiscalYearStartMonth: org.fiscalYearStartMonth });
        headline = a.headline;
        recommendations = a.recommendations.slice(0, 5).map((r) => ({ text: r.text, why: r.why, path: r.path, priority: r.priority }));
      } catch (e) {
        this.log.warn(`CFO assessment for demo ${orgId} not available: ${(e as Error).message}`);
      }
    }
    return {
      organisation: { id: o.id, name: o.name, isDemo: true },
      profile: profile ? describe(profile) : null,
      status: row.status,
      failure: row.failure,
      counts: row.counts,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      synthetic: 'Every figure, name and registration number here is made up for demonstration. It does not describe any real business, person or tax registration.',
      headline,
      recommendations,
    };
  }

  // ------------------------------------------------------------------ the build

  private async build(orgId: string, user: AuthUser, p: DemoProfile): Promise<Record<string, number>> {
    const actor = { id: user.id };
    await this.orgs.setTimeZone(orgId, user.id, p.timeZone);
    const today = todayIso();
    const plan = demoPlan(p, { today });
    const current = fiscalYearForDate(today, p.fiscalYearStartMonth);
    for (const fy of plan.fiscalYears) if (fy !== current) await this.periods.createFiscalYear(orgId, user.id, fy, p.fiscalYearStartMonth);
    const counts: Record<string, number> = {};
    const bump = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);
    const accounts = await this.prisma.account.findMany({ where: { orgId } });
    const a = Object.fromEntries(accounts.map((x) => [x.code, x.id])) as Record<string, string>;
    const ctx = { id: orgId, functionalCurrency: p.currency };
    const ledgerOrg = { id: orgId, role: 'OWNER' as const, functionalCurrency: p.currency, fiscalYearStartMonth: p.fiscalYearStartMonth };
    const orgCtx: OrgContext = { id: orgId, role: 'OWNER', functionalCurrency: p.currency, fiscalYearStartMonth: p.fiscalYearStartMonth };
    const india = p.countryCode === 'IN';

    // Tax: India registers for GST with a made-up GSTIN; VAT countries get their starter rates and a made-up registration.
    let standard: string | null = null;
    let zero: string | null = null;
    // Indian GST documents need a GST rate on every line: bills from suppliers who charge none carry the non-GST rate.
    let untaxed: string | null = null;
    if (india) {
      await this.gst.register(orgId, actor, { gstin: synthGstin(p.stateCode!, 'ZZZCD9001Z'), legalName: p.orgName.replace(' (SYNTHETIC DATA)', ' (synthetic)'), effectiveFrom: plan.openingDate });
      standard = (await this.taxRates.create(orgId, actor, { name: p.taxRate!.name, rate: p.taxRate!.rate, kind: 'GST', gstCategory: 'TAXABLE' })).id;
      untaxed = (await this.taxRates.create(orgId, actor, { name: 'Non-GST supply', rate: '0', kind: 'GST', gstCategory: 'NON_GST' })).id;
      await this.compliance.saveSettings(orgId, actor, { gstReturnFrequency: 'MONTHLY', advanceTaxFrom: plan.openingDate });
      bump('taxRegistrations');
    } else if (p.taxRate) {
      await this.countryModules.addStarterRates(orgId, actor);
      const rates = await this.prisma.taxRate.findMany({ where: { orgId }, select: { id: true, name: true, rate: true } });
      standard = rates.find((r) => r.name === p.taxRate!.name)?.id ?? null;
      zero = p.zeroRate ? (rates.find((r) => r.name === p.zeroRate!.name)?.id ?? null) : null;
      const j = vatJurisdiction(p.countryCode);
      if (j) {
        const region = j.region ? (j.region.options.find((x) => x.label === 'Dubai')?.key ?? j.region.options[0]!.key) : null;
        const treatments = rates.flatMap((r) => {
          const t = j.suggest(r.rate.toFixed(), r.name);
          return t ? [{ taxRateId: r.id, treatment: t }] : [];
        });
        await this.vat.saveSettings(orgCtx, user, { vrn: synthVatNumber(p.countryCode), registeredFrom: plan.openingDate, stagger: 'MONTHLY', region, untaxedTreatment: 'OUTSIDE_SCOPE', treatments });
        bump('taxRegistrations');
      }
    }
    if (!standard && p.taxRate) throw new Error(`The ${p.taxRate.name} rate was not set up`);
    counts.taxRates = await this.prisma.taxRate.count({ where: { orgId } });

    // Customers and vendors.
    const customerIds: string[] = [];
    for (const c of p.customers) {
      const made = await this.contacts.create(ctx, actor, {
        name: c.name,
        isCustomer: true,
        paymentTermsDays: c.terms,
        ...(india && c.pan && c.stateCode ? { gstin: synthGstin(c.stateCode, c.pan) } : {}),
        ...(india && !c.pan && c.stateCode ? { stateCode: c.stateCode } : {}),
        ...(c.countryCode ? { countryCode: c.countryCode } : {}),
      });
      customerIds.push(made.id);
      bump('customers');
    }
    const vendorIds: string[] = [];
    for (const v of p.vendors) {
      const made = await this.contacts.create(ctx, actor, {
        name: v.name,
        isVendor: true,
        paymentTermsDays: v.terms,
        ...(india && v.pan && v.stateCode ? { gstin: synthGstin(v.stateCode, v.pan) } : {}),
        ...(india && !v.pan && v.stateCode ? { stateCode: v.stateCode } : {}),
        ...(v.countryCode ? { countryCode: v.countryCode } : {}),
      });
      vendorIds.push(made.id);
      bump('vendors');
    }

    // Departments and projects.
    const dimOrg = { id: orgId, role: 'OWNER' as const, functionalCurrency: p.currency };
    const departmentIds = new Map<string, string>();
    for (const d of p.departments) {
      departmentIds.set(d.code, (await this.dimensions.create(dimOrg, actor, { type: 'DEPARTMENT', code: d.code, name: d.name })).id);
      bump('departments');
    }
    const projectIds = new Map<string, string>();
    for (const x of p.projects) {
      projectIds.set(x.code, (await this.dimensions.create(dimOrg, actor, { type: 'PROJECT', code: x.code, name: x.name, contactId: customerIds[x.customer], startDate: plan.openingDate })).id);
      bump('projects');
    }

    const post = (date: string, memo: string, lines: { account: string; department: string | null; debit?: string; credit?: string }[]) =>
      this.journals.create(
        ctx,
        actor,
        {
          date,
          type: 'STANDARD',
          memo,
          lines: lines.map((l) => ({ accountId: a[l.account]!, debit: l.debit, credit: l.credit, departmentId: l.department ? (departmentIds.get(l.department) ?? null) : null })),
        },
        { post: true },
      );

    // Journals that open the books come first; the rest go in date order with the documents.
    const [opening, ...journals] = plan.journals;
    await post(opening!.date, opening!.memo, opening!.lines);
    bump('journals');

    type Step = { date: string; order: number; run: () => Promise<void> };
    const steps: Step[] = [];
    for (const b of plan.bills) {
      const v = p.vendors[b.vendor]!;
      steps.push({
        date: b.date,
        order: 0,
        run: async () => {
          const bill = await this.docs.create(
            ledgerOrg,
            actor,
            'PURCHASES',
            {
              kind: 'BILL',
              contactId: vendorIds[b.vendor]!,
              issueDate: b.date,
              reference: b.reference,
              lines: [{ accountId: a[b.account]!, description: b.description, quantity: '1', unitPrice: b.amount, taxRateId: v.taxed ? standard : untaxed, hsnCode: india ? (v.hsn ?? null) : null }],
            },
            { post: true },
          );
          bump('bills');
          if (b.settle === 'FULL' && b.settleOn) {
            await this.docs.createPayment(ledgerOrg, actor, 'PURCHASES', {
              contactId: vendorIds[b.vendor]!,
              date: b.settleOn,
              bankAccountId: a['1120']!,
              amount: bill.total,
              reference: `${b.reference}-PAY`,
              allocations: [{ documentId: bill.id, amount: bill.total }],
            });
            bump('payments');
          }
        },
      });
    }
    for (const i of plan.invoices) {
      steps.push({
        date: i.date,
        order: 1,
        run: async () => {
          const taxRateId = i.abroad && !india ? zero : standard;
          const inv = await this.docs.create(
            ledgerOrg,
            actor,
            'SALES',
            {
              kind: 'INVOICE',
              contactId: customerIds[i.customer]!,
              issueDate: i.date,
              reference: i.reference,
              placeOfSupply: india && i.abroad ? '96' : undefined,
              lines: i.lines.map((l) => ({
                accountId: a[p.revenueAccount]!,
                description: l.description,
                quantity: l.quantity,
                unitPrice: l.unitPrice,
                taxRateId,
                hsnCode: india ? (p.revenueHsn ?? null) : null,
                projectId: i.project ? (projectIds.get(i.project) ?? null) : null,
              })),
            },
            { post: true },
          );
          bump('invoices');
          if (i.settle !== 'OPEN' && i.settleOn) {
            const amount = i.settle === 'PART' ? new D(inv.total).times('0.5').toDecimalPlaces(2).toFixed(2) : inv.total;
            await this.docs.createPayment(ledgerOrg, actor, 'SALES', {
              contactId: customerIds[i.customer]!,
              date: i.settleOn,
              bankAccountId: a['1120']!,
              amount,
              reference: `${i.reference}-RCPT`,
              allocations: [{ documentId: inv.id, amount }],
            });
            bump('receipts');
          }
        },
      });
    }
    for (const j of journals) {
      steps.push({
        date: j.date,
        order: 2,
        run: async () => {
          await post(j.date, j.memo, j.lines);
          bump('journals');
        },
      });
    }
    steps.sort((x, y) => x.date.localeCompare(y.date) || x.order - y.order);
    for (const s of steps) await s.run();

    // Payroll (India): employees with salary structures, a posted run each past month and its dues paid when due.
    if (p.payroll && india) {
      await this.payroll.saveSettings(orgId, actor, {});
      for (const [n, s] of p.staff.entries()) {
        const basic = new D(s.monthly).times('0.5').toFixed(2);
        const hra = new D(s.monthly).times('0.25').toFixed(2);
        const special = new D(s.monthly).minus(basic).minus(hra).toFixed(2);
        await this.payroll.createEmployee(orgId, actor, {
          code: `SYN${String(n + 1).padStart(3, '0')}`,
          name: s.name,
          pan: s.pan ?? null,
          dateOfJoining: plan.openingDate,
          workStateCode: p.stateCode!,
          ptCategory: s.woman ? 'WOMAN' : 'GENERAL',
          pfMember: false,
          epsMember: false,
          structure: {
            effectiveFrom: plan.openingDate,
            components: [
              { code: 'BASIC', name: 'Basic', kind: 'WAGES', monthlyAmount: basic },
              { code: 'HRA', name: 'House rent allowance', kind: 'EXCLUDED', monthlyAmount: hra },
              { code: 'SPECIAL', name: 'Special allowance', kind: 'WAGES', monthlyAmount: special },
            ],
          },
        });
        bump('employees');
      }
      for (const period of plan.payrollMonths) {
        const [y, m] = period.split('-').map(Number);
        const end = new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
        const run = await this.payroll.createRun(ledgerOrg, actor, { period, payDate: end });
        const posted = await this.payroll.postRun(ledgerOrg, actor, run.id);
        bump('payRuns');
        for (const l of posted.liabilities as { liability: Parameters<PayrollService['remit']>[3]['liability']; amount: string; dueDate: string }[]) {
          if (new D(l.amount).isZero()) continue;
          const paidOn = l.liability === 'NET_PAY' ? end : l.dueDate;
          if (paidOn > today) continue;
          await this.payroll.remit(ledgerOrg, actor, run.id, { liability: l.liability, date: paidOn, bankAccountId: a['1120']!, reference: `SYN-${l.liability}-${period}` });
        }
      }
    } else {
      counts.employees = p.staff.length;
    }

    // A made-up bank statement for the last 45 days, built from the bank lines in the books, with the latest
    // line not yet cleared and two lines the books do not have; then matched automatically.
    const from = new Date(Date.parse(`${today}T00:00:00Z`) - 45 * 86_400_000);
    const bankLines = await this.prisma.journalLine.findMany({
      where: { orgId, accountId: a['1120'], entry: { status: 'POSTED', date: { gte: from } } },
      include: { entry: true },
      orderBy: [{ entry: { date: 'asc' } }, { entry: { entryNumber: 'asc' } }],
    });
    const cleared = bankLines.slice(0, Math.max(0, bankLines.length - 1));
    const csv = [
      'Date,Narration,Ref,Amount',
      ...cleared.map(
        (l) =>
          `${l.entry.date.toISOString().slice(0, 10)},"${(l.entry.memo ?? 'Transfer').replace(/"/g, '')} (synthetic)",${l.entry.reference ?? ''},${new D(l.functionalDebit.toString()).minus(l.functionalCredit.toString()).toFixed(2)}`,
      ),
      `${today},Interest credited (synthetic),,${new D(p.capital).times('0.0002').toDecimalPlaces(2).toFixed(2)}`,
      `${today},Account fee (synthetic),,-${new D(p.capital).times('0.00004').toDecimalPlaces(2).toFixed(2)}`,
    ].join('\n');
    const imported = await this.banking.importStatement(ledgerOrg, actor, a['1120']!, {
      fileName: 'synthetic-statement.csv',
      csv,
      mapping: { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'YYYY-MM-DD', hasHeader: true },
      dryRun: false,
    });
    counts.bankLines = imported.newCount;
    counts.bankMatched = (await this.banking.autoMatch(ledgerOrg, actor, a['1120']!)).matched;

    // India: GST returns before the latest marked filed with made-up acknowledgements.
    if (india) {
      const past = await this.compliance.calendar(orgId, plan.openingDate, today);
      let filed = 0;
      for (const i of [...past.overdueBefore, ...past.items]) {
        if (i.nature !== 'RETURN' || i.status === 'DONE' || i.dueDate >= today) continue;
        const latest = i.dueDate >= new Date(Date.parse(`${today}T00:00:00Z`) - 20 * 86_400_000).toISOString().slice(0, 10);
        if (latest) continue;
        await this.compliance.markFiled(orgId, actor, { key: i.key, filedOn: i.dueDate, reference: `SYN-${i.kind}-${i.period.replace(/\W/g, '')}` });
        filed++;
      }
      counts.filings = filed;
    }

    // This fiscal year's budget, submitted for someone else to approve.
    const lines = plan.budget.lines.filter((l) => a[l.account]).map((l) => ({ accountId: a[l.account]!, amounts: spreadEvenly(l.annual) }));
    const budget = await this.budgets.create(orgId, actor, {
      basis: 'EMPTY',
      fiscalYear: plan.budget.fiscalYear,
      name: 'Plan (synthetic)',
      note: `Synthetic demonstration budget: the run rate, ${plan.budget.growth}% higher`,
    });
    await this.budgets.saveLines(orgId, actor, budget.budget.id, { lines });
    await this.budgets.submit(orgId, actor, budget.budget.id);
    counts.budgets = 1;

    // KPI targets and a draft management commentary for last month.
    for (const [kpi, comparator, target] of [
      ['grossMargin', 'AT_LEAST', '35'],
      ['dso', 'AT_MOST', '45'],
      ['currentRatio', 'AT_LEAST', '1.5'],
    ] as const)
      await this.kpis.setTarget(orgId, actor, kpi, { comparator, target, note: 'Synthetic demonstration target' });
    const last = plan.months[plan.months.length - 2]!;
    await this.kpis.saveCommentary(
      orgId,
      actor,
      last,
      `Synthetic commentary for a made-up company. ${p.customers[1]!.name} is paying about half of each invoice, so receivables are building up; costs are in line with the plan.`,
    );
    counts.kpiTargets = 3;

    // The checks run once, so the alerts have something to show.
    await this.alerts.runScan(orgId, actor);
    counts.alerts = (await this.alerts.list(orgId, { status: 'ACTIVE', fresh: false })).alerts.length;
    return counts;
  }
}

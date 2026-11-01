import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createHash, randomBytes } from 'node:crypto';
import { AppModule } from '../app.module';
import { SessionsService } from '../auth/sessions.service';
import { allowSystemAccessOutsideRequests } from '../common/tenant-context';
import { AuthService } from '../auth/auth.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { BankingService } from '../banking/banking.service';
import { todayIso } from '../common/dates';
import { PrismaService } from '../common/prisma.service';
import { loadConfig } from '../config';
import { addDays, D } from '@talk2tax/accounting-engine';
import { ContactsService } from '../contacts/contacts.service';
import { JournalsService } from '../journals/journals.service';
import { DocumentsService } from '../ledgers/documents.service';
import { ExpensesService } from '../expenses/expenses.service';
import { TaxRatesService } from '../tax-rates/tax-rates.service';
import { GstService } from '../gst/gst.service';
import { WithholdingService } from '../withholding/withholding.service';
import { depositDueDate, expectedValidUntil, gstinCheckCharacter } from '@talk2tax/tax-engine';
import { OrganizationsService } from '../organizations/organizations.service';
import { PayrollService } from '../payroll/payroll.service';
import { ComplianceService } from '../compliance/compliance.service';
import { EInvoicingService } from '../e-invoicing/e-invoicing.service';
import { EWayBillsService } from '../e-way-bills/e-way-bills.service';

/**
 * Creates a clearly-labelled SYNTHETIC demo organization with a few months of
 * journals, posted through the same validation and posting path as the API.
 * Nothing here represents real financial activity.
 */
const DEMO_EMAIL = 'demo@talk2tax.local';

// Deterministic pseudo-random amounts so every seed produces the same books.
function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
}

async function main() {
  const config = loadConfig();
  if (config.NODE_ENV === 'production') throw new Error('Refusing to seed demo data in production');
  // The seed is not an HTTP request; it writes several tenants' data as the system.
  allowSystemAccessOutsideRequests();
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(config), { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService);
  const existing = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (existing) {
    console.log(`Demo user ${DEMO_EMAIL} already exists; nothing to do.`);
    await app.close();
    return;
  }
  const password = process.env.DEMO_PASSWORD ?? randomBytes(12).toString('base64url');
  const { user } = await app.get(AuthService).register({ email: DEMO_EMAIL, name: 'Demo Owner', password }, { userAgent: 'demo seed' });
  // Registering signs in; the seed throws that session away, so end it.
  await app.get(SessionsService).revokeOthers(null, user.id, null, 'signed_out');
  const orgs = app.get(OrganizationsService);
  const org = await orgs.create(user.id, {
    name: 'Northwind Demo Traders (SYNTHETIC DATA)',
    legalName: 'Synthetic demonstration company — not a real business',
    countryCode: 'IN',
    functionalCurrency: 'INR',
    fiscalYearStartMonth: 4,
    chartTemplate: 'GENERIC_SMB',
    isDemo: true,
  });
  const accounts = await prisma.account.findMany({ where: { orgId: org.id } });
  const a = Object.fromEntries(accounts.map((x) => [x.code, x.id]));
  const periods = await prisma.fiscalPeriod.findMany({ where: { orgId: org.id }, orderBy: { startDate: 'asc' } });
  const today = todayIso();
  const journals = app.get(JournalsService);
  const ctx = { id: org.id, functionalCurrency: 'INR' };
  const actor = { id: user.id };
  const rand = rng(20261031);
  // Synthetic amounts: a pseudo-random integer number of paise, converted to a decimal string without floating-point money arithmetic.
  const amt = (min: number, max: number) => new D(Math.round((min + rand() * (max - min)) * 100)).dividedBy(100).toFixed(2);
  const post = (date: string, memo: string, lines: { accountId: string; debit?: string; credit?: string; currency?: string; exchangeRate?: string }[]) =>
    journals.create(ctx, actor, { date, type: 'STANDARD', memo, lines }, { post: true, idempotencyKey: `seed-${date}-${memo}`.replace(/[^A-Za-z0-9_\-:.]/g, '-').slice(0, 128) });

  let count = 0;
  const first = periods[0].startDate.toISOString().slice(0, 10);
  await post(first, 'Opening share capital', [
    { accountId: a['1120'], debit: '2500000.00' },
    { accountId: a['3100'], credit: '2500000.00' },
  ]);
  await post(first, 'Opening inventory purchase', [
    { accountId: a['1300'], debit: '600000.00' },
    { accountId: a['1120'], credit: '600000.00' },
  ]);
  count += 2;

  // Sales and purchases go through the same document services as the API, so the
  // receivables and payables ledgers tie to their control accounts.
  const contacts = app.get(ContactsService);
  const docs = app.get(DocumentsService);
  const ledgerOrg = { id: org.id, role: 'OWNER' as const, functionalCurrency: 'INR', fiscalYearStartMonth: 4 };
  // A simple (non-GST) rate is kept for expense claims, which cannot carry GST input credit.
  const taxRate = await app.get(TaxRatesService).create(org.id, actor, { name: 'Sample tax 18% (synthetic)', rate: '18', salesAccountId: a['2300'], purchaseAccountId: a['1450'] });
  // SYNTHETIC GST registration in Maharashtra from the first day of the books. GSTINs below are
  // built from made-up PANs (ZZZ...) with a computed check character; they belong to no one.
  const synthGstin = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
  await app.get(GstService).register(org.id, actor, { gstin: synthGstin('27', 'ZZZCN0001Z'), legalName: 'Northwind Demo Traders (synthetic)', effectiveFrom: first });
  const taxRates = app.get(TaxRatesService);
  const gst18 = await taxRates.create(org.id, actor, { name: 'GST 18%', rate: '18', kind: 'GST', gstCategory: 'TAXABLE' });
  const gst5 = await taxRates.create(org.id, actor, { name: 'GST 5%', rate: '5', kind: 'GST', gstCategory: 'TAXABLE' });
  await taxRates.create(org.id, actor, { name: 'GST 40%', rate: '40', kind: 'GST', gstCategory: 'TAXABLE' });
  const nilRated = await taxRates.create(org.id, actor, { name: 'Nil rated', rate: '0', kind: 'GST', gstCategory: 'NIL_RATED' });
  await taxRates.create(org.id, actor, { name: 'Exempt', rate: '0', kind: 'GST', gstCategory: 'EXEMPT' });
  await taxRates.create(org.id, actor, { name: 'Non-GST supply', rate: '0', kind: 'GST', gstCategory: 'NON_GST' });
  const customers = await Promise.all(
    [
      // The address details feed e-invoices; Brightline has no PIN code, so its invoices show what is missing.
      ['Asterix Retail Stores (synthetic)', 30, '1500000.00', synthGstin('27', 'ZZZCA0002Z'), null, '21 Synthetic Arcade, FC Road\nShivajinagar', 'Pune', '411005'],
      ['Brightline Distributors (synthetic)', 45, null, synthGstin('29', 'ZZZCB0003Z'), null, '7 Demo Industrial Estate', 'Bengaluru', null],
      ['Coastal Hospitality Group (synthetic)', 15, null, null, '30', null, null, null],
      ['Overseas Services Client (synthetic)', 30, null, null, null, null, null, null],
    ].map(([name, terms, limit, gstin, stateCode, address, city, pincode]) =>
      contacts.create(ctx, actor, { name: name as string, isCustomer: true, paymentTermsDays: terms as number, creditLimit: limit as string | null, gstin: gstin as string | null, stateCode: stateCode as string | null, address: address as string | null, city: city as string | null, pincode: pincode as string | null }),
    ),
  );
  // Where each customer's supplies are made: their own state, except the overseas client (export).
  const posFor = (i: number) => (i === 3 ? '96' : undefined);
  const vendors = await Promise.all(
    [
      ['Delta Wholesale Supplies (synthetic)', 30, synthGstin('27', 'ZZZCD0004Z')],
      ['Evergreen Logistics (synthetic)', 15, synthGstin('24', 'ZZZFE0005Z')],
    ].map(([name, terms, gstin]) => contacts.create(ctx, actor, { name: name as string, isVendor: true, paymentTermsDays: terms as number, gstin: gstin as string })),
  );
  const money = (min: number, max: number) => new D(amt(min, max));

  // SYNTHETIC TDS setup (made-up TAN): sections from the Income-tax Act 2025 templates, which apply from 1 April 2026.
  const withholding = app.get(WithholdingService);
  await withholding.saveSettings(org.id, actor, { tan: 'PNEZ00001Z' });
  const professional = await withholding.createSection(org.id, actor, { template: '393(1)-6(iii)(b)' });
  await withholding.createSection(org.id, actor, { template: '393(1)-6(i)' });
  await withholding.createSection(org.id, actor, { template: '393(1)-2(ii)(b)' });
  const consultant = await contacts.create(ctx, actor, { name: 'Sahyadri Advisory LLP (synthetic)', isVendor: true, paymentTermsDays: 15, gstin: synthGstin('27', 'ZZZFS0006Z'), withholdingSectionId: professional.id });
  const advocate = await contacts.create(ctx, actor, { name: 'Adv. Meera Joshi (synthetic)', isVendor: true, paymentTermsDays: 30, stateCode: '27', pan: 'ZZZPJ0007Z', withholdingSectionId: professional.id });
  const cloud = await contacts.create(ctx, actor, { name: 'CloudStack Inc., USA (synthetic)', isVendor: true, paymentTermsDays: 0, stateCode: '96' });
  const tdsFrom = '2026-04-01';

  for (const p of periods) {
    const start = p.startDate.toISOString().slice(0, 10);
    if (start > today) break;
    const ym = start.slice(0, 7);
    const day = (d: number) => {
      const iso = `${ym}-${String(d).padStart(2, '0')}`;
      return iso > today ? today : iso;
    };
    // Three tax invoices and one service invoice a month.
    const invoices = [];
    for (const [i, c] of customers.slice(0, 3).entries()) {
      const qty = String(40 + Math.floor(rand() * 60));
      const price = money(1500, 2500).toFixed(2);
      const inv = await docs.create(
        ledgerOrg,
        actor,
        'SALES',
        { kind: 'INVOICE', contactId: c.id, issueDate: day(5 + i), reference: `PO-${ym}-${i + 1}`, placeOfSupply: posFor(i), lines: [{ accountId: a['4100'], description: 'Trade goods', quantity: qty, unitPrice: price, taxRateId: gst18.id, hsnCode: '3926' }] },
        { post: true, overrideCreditLimit: true },
      );
      invoices.push(inv);
      count += 1;
    }
    const svc = await docs.create(
      ledgerOrg,
      actor,
      'SALES',
      { kind: 'INVOICE', contactId: customers[3].id, issueDate: day(12), placeOfSupply: posFor(3), lines: [{ accountId: a['4200'], description: 'Consulting services, export with IGST paid (billed in INR)', quantity: '1', unitPrice: money(160000, 480000).toFixed(2), taxRateId: gst18.id, hsnCode: '998311' }] },
      { post: true },
    );
    invoices.push(svc);
    count += 1;
    const sales = invoices.slice(0, 3).reduce((s, x) => s.plus(x.subtotal), new D(0));
    const cogs = sales.times(new D('0.52').plus(new D(rand().toFixed(4)).times('0.08'))).toDecimalPlaces(2);
    await post(day(6), `Cost of goods sold ${ym}`, [
      { accountId: a['5000'], debit: cogs.toFixed(2) },
      { accountId: a['1300'], credit: cogs.toFixed(2) },
    ]);
    count += 1;
    // Customers pay most invoices; the most recent months stay partly open so the ageing has something to show.
    const isRecent = start >= periods.filter((x) => x.startDate.toISOString().slice(0, 10) <= today).slice(-2)[0].startDate.toISOString().slice(0, 10);
    for (const inv of invoices) {
      if (isRecent && rand() < 0.6) continue;
      const share = rand() < 0.25 ? new D('0.5') : new D(1);
      const amount = new D(inv.total).times(share).toDecimalPlaces(2);
      await docs.createPayment(ledgerOrg, actor, 'SALES', { contactId: inv.contact.id, date: day(25), bankAccountId: a['1120'], amount: amount.toFixed(2), reference: `UTR${ym.replace('-', '')}${inv.number?.slice(-3)}`, allocations: [{ documentId: inv.id, amount: amount.toFixed(2) }] });
      count += 1;
    }
    // Stock purchases and freight bills, mostly paid.
    for (const [i, v] of vendors.entries()) {
      const bill = await docs.create(
        ledgerOrg,
        actor,
        'PURCHASES',
        {
          kind: 'BILL',
          contactId: v.id,
          issueDate: day(3 + i),
          reference: `${i === 0 ? 'DWS' : 'EVL'}/${ym}/${100 + i}`,
          lines: [{ accountId: i === 0 ? a['1300'] : a['5000'], description: i === 0 ? 'Stock purchase' : 'Freight inward', quantity: '1', unitPrice: (i === 0 ? money(220000, 340000) : money(15000, 30000)).toFixed(2), taxRateId: gst18.id, hsnCode: i === 0 ? '3926' : '996511' }],
        },
        { post: true },
      );
      count += 1;
      if (!isRecent || rand() < 0.4) {
        await docs.createPayment(ledgerOrg, actor, 'PURCHASES', { contactId: v.id, date: day(20), bankAccountId: a['1120'], amount: bill.total, allocations: [{ documentId: bill.id, amount: bill.total }] });
        count += 1;
      }
    }
    if (start >= tdsFrom) {
      // A monthly retainer with TDS on professional fees (the first month counts toward the threshold, the second catches it up),
      // and a software subscription from abroad: import of services, IGST under reverse charge.
      const fee = await docs.create(
        ledgerOrg,
        actor,
        'PURCHASES',
        { kind: 'BILL', contactId: consultant.id, issueDate: day(10), reference: `SA/${ym}`, withholdingSectionId: professional.id, lines: [{ accountId: a['6600'], description: 'Tax and accounting advisory retainer', quantity: '1', unitPrice: money(30000, 42000).toFixed(2), taxRateId: gst18.id, hsnCode: '998221' }] },
        { post: true },
      );
      await docs.create(
        ledgerOrg,
        actor,
        'PURCHASES',
        { kind: 'BILL', contactId: cloud.id, issueDate: day(2), reference: `CS-INV-${ym}`, reverseCharge: true, lines: [{ accountId: a['6400'], description: 'Cloud platform subscription', quantity: '1', unitPrice: '12000.00', taxRateId: gst18.id, hsnCode: '997331' }] },
        { post: true },
      );
      count += 2;
      if (!isRecent) {
        await docs.createPayment(ledgerOrg, actor, 'PURCHASES', { contactId: consultant.id, date: day(25), bankAccountId: a['1120'], amount: fee.total, allocations: [{ documentId: fee.id, amount: fee.total }] });
        count += 1;
      }
    }
    const lines = [
      [a['6100'], money(140000, 160000)],
      [a['6200'], new D('45000.00')],
      [a['6300'], money(6000, 11000)],
      [a['6400'], money(9000, 15000)],
      [a['6500'], money(15000, 40000)],
      [a['6900'], money(300, 900)],
    ] as const;
    const total = lines.reduce((s, [, x]) => s.plus(x), new D(0));
    await post(day(28), `Operating expenses ${ym}`, [...lines.map(([accountId, x]) => ({ accountId, debit: x.toFixed(2) })), { accountId: a['1120'], credit: total.toFixed(2) }]);
    count += 1;
  }

  // This month also has a walk-in sale to an unregistered buyer (B2C, with a nil-rated line) and a credit note.
  const walkIn = await contacts.create(ctx, actor, { name: 'Walk-in customer (synthetic)', isCustomer: true, paymentTermsDays: 0, stateCode: '27' });
  await docs.create(
    ledgerOrg,
    actor,
    'SALES',
    {
      kind: 'INVOICE',
      contactId: walkIn.id,
      issueDate: today,
      lines: [
        { accountId: a['4100'], description: 'Packaged goods', quantity: '12', unitPrice: '450.00', taxRateId: gst5.id, hsnCode: '1905' },
        { accountId: a['4100'], description: 'Fresh produce', quantity: '20', unitPrice: '60.00', taxRateId: nilRated.id, hsnCode: '0702' },
      ],
    },
    { post: true },
  );
  await docs.create(
    ledgerOrg,
    actor,
    'SALES',
    { kind: 'CREDIT_NOTE', contactId: customers[0].id, issueDate: today, reference: 'Damaged units returned', lines: [{ accountId: a['4100'], description: 'Trade goods returned', quantity: '2', unitPrice: '1800.00', taxRateId: gst18.id, hsnCode: '3926' }] },
    { post: true },
  );
  count += 3;

  // Legal services from an advocate this month: reverse charge, with TDS on professional fees.
  await docs.create(
    ledgerOrg,
    actor,
    'PURCHASES',
    { kind: 'BILL', contactId: advocate.id, issueDate: today, reference: 'MJ/LEGAL/31', reverseCharge: true, withholdingSectionId: professional.id, lines: [{ accountId: a['6600'], description: 'Legal opinion on vendor contracts', quantity: '1', unitPrice: '65000.00', taxRateId: gst18.id, hsnCode: '998211' }] },
    { post: true },
  );
  count += 1;
  // TDS deducted in each month is deposited the day before it is due (the 6th of the next month), where that date has passed.
  const tdsDocs = await prisma.document.findMany({ where: { orgId: org.id, withholdingKind: 'TDS', status: 'POSTED', withholdingAmount: { gt: 0 } }, orderBy: { issueDate: 'asc' } });
  const byMonth = new Map<string, string[]>();
  for (const d of tdsDocs) {
    const m = d.issueDate.toISOString().slice(0, 7);
    byMonth.set(m, [...(byMonth.get(m) ?? []), d.id]);
  }
  let challan = 1;
  for (const [m, ids] of byMonth) {
    const paid = addDays(depositDueDate(`${m}-01`), -1);
    if (paid > today) continue;
    await withholding.createDeposit(ledgerOrg, actor, { kind: 'TDS', depositDate: paid, bankAccountId: a['1120'], challanReference: `CIN 0510308${paid.replace(/-/g, '')}${String(challan++).padStart(5, '0')} (synthetic)`, documentIds: ids });
    count += 1;
  }

  // A SYNTHETIC bank statement for the current month, built from the bank lines in the books,
  // with the latest one left off (not yet cleared) and two lines the books do not have yet.
  const monthStart = `${today.slice(0, 7)}-01`;
  const bankLines = await prisma.journalLine.findMany({
    where: { orgId: org.id, accountId: a['1120'], entry: { status: 'POSTED', date: { gte: new Date(`${monthStart}T00:00:00Z`) } } },
    include: { entry: true },
    orderBy: [{ entry: { date: 'asc' } }, { entry: { entryNumber: 'asc' } }],
  });
  const onStatement = bankLines.slice(0, Math.max(0, bankLines.length - 1));
  const csvDate = (d: Date) => d.toISOString().slice(0, 10);
  const statement = [
    'Date,Narration,Ref,Amount',
    ...onStatement.map((l) => `${csvDate(l.entry.date)},"${(l.entry.memo ?? 'Transfer').replace(/"/g, '')} (synthetic)",${l.entry.reference ?? ''},${new D(l.functionalDebit.toString()).minus(l.functionalCredit.toString()).toFixed(2)}`),
    `${today},Savings interest credited (synthetic),,412.37`,
    `${today},SMS alert charges (synthetic),,-59.00`,
  ].join('\n');
  const banking = app.get(BankingService);
  const imported = await banking.importStatement(ledgerOrg, actor, a['1120'], {
    fileName: 'synthetic-statement.csv',
    csv: statement,
    mapping: { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'YYYY-MM-DD', hasHeader: true },
    dryRun: false,
  });
  const matched = await banking.autoMatch(ledgerOrg, actor, a['1120']);
  console.log(`  Synthetic bank statement: ${imported.newCount} lines, ${matched.matched} matched automatically`);

  // An approval rule for large bills, switched on after the history above was posted, and
  // one SYNTHETIC draft bill waiting for approval with a synthetic PDF attached.
  const approvals = app.get(ApprovalsService);
  await approvals.setPolicy({ ...ledgerOrg, fiscalYearStartMonth: 4 }, actor, 'BILL', { minAmount: '250000', requireDifferentApprover: true, isActive: true });
  const bigBill = await docs.create(
    ledgerOrg,
    actor,
    'PURCHASES',
    { kind: 'BILL', contactId: vendors[0].id, issueDate: today, reference: 'DWS/PENDING/900', lines: [{ accountId: a['1300'], description: 'Stock purchase (synthetic)', quantity: '1', unitPrice: '310000.00', taxRateId: gst18.id, hsnCode: '3926' }] },
    { post: false },
  );
  await app.get(AttachmentsService).upload(ledgerOrg, actor, {
    entityType: 'DOCUMENT',
    entityId: bigBill.id,
    fileName: 'synthetic-vendor-bill.pdf',
    content: Buffer.from('%PDF-1.4\n% SYNTHETIC DEMO FILE - not a real bill\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n'),
  });
  await approvals.submit({ ...ledgerOrg, fiscalYearStartMonth: 4 }, actor, { documentId: bigBill.id, note: 'Synthetic demo: large stock order' });
  console.log('  Approval rule: bills from 250000 need a second person; one synthetic draft bill is waiting');

  // A SYNTHETIC field employee with three expense claims: one paid back, one waiting for the
  // owner's approval (with a receipt), one still a draft. The employee never signs in; the
  // password is random and not shown.
  const employeeUser = (await app.get(AuthService).register({ email: 'field.employee@talk2tax.local', name: 'Field Employee (synthetic)', password: randomBytes(24).toString('base64url') }, { userAgent: 'demo seed' })).user;
  await app.get(SessionsService).revokeOthers(null, employeeUser.id, null, 'signed_out');
  await prisma.membership.create({ data: { orgId: org.id, userId: employeeUser.id, role: 'EMPLOYEE' } });
  const emp = { ...ledgerOrg, role: 'EMPLOYEE' as const };
  const empActor = { id: employeeUser.id };
  const expenses = app.get(ExpensesService);
  const ago = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
  const paid = await expenses.create(emp, empActor, {
    title: 'Customer visits, Nashik (synthetic)',
    lines: [
      { date: ago(12), accountId: a['6700'], merchant: 'Synthetic Rail', description: 'Return ticket', amount: '1840.00', taxRateId: null },
      { date: ago(12), accountId: a['6700'], merchant: 'Synthetic Cabs', amount: '1180.00', taxRateId: taxRate.id },
    ],
  });
  await expenses.submit(emp, empActor, paid.id);
  await expenses.approve(ledgerOrg, actor, paid.id, { note: 'Synthetic demo approval', date: ago(10) });
  await expenses.reimburse(ledgerOrg, actor, paid.id, { bankAccountId: a['1120'], date: ago(8), reference: 'NEFT SYN-EXP-1' });
  const waiting = await expenses.create(emp, empActor, {
    title: 'Trade fair, Mumbai (synthetic)',
    lines: [
      { date: ago(4), accountId: a['6700'], merchant: 'Synthetic Hotel', description: 'Two nights', amount: '9440.00', taxRateId: taxRate.id },
      { date: ago(3), accountId: a['6500'], merchant: 'Synthetic Print Shop', description: 'Stand banners', amount: '2360.00', taxRateId: taxRate.id },
    ],
  });
  await app.get(AttachmentsService).upload(emp, empActor, {
    entityType: 'EXPENSE_CLAIM',
    entityId: waiting.id,
    fileName: 'synthetic-hotel-invoice.pdf',
    content: Buffer.from('%PDF-1.4\n% SYNTHETIC DEMO FILE - not a real receipt\n%%EOF\n'),
  });
  await expenses.submit(emp, empActor, waiting.id);
  await expenses.create(emp, empActor, { title: 'Team lunch (synthetic)', lines: [{ date: ago(1), accountId: a['6700'], merchant: 'Synthetic Diner', amount: '1250.00', taxRateId: null }] });
  console.log('  Expense claims: one paid back, one waiting for approval, one draft (synthetic employee)');

  // SYNTHETIC payroll: five made-up employees (PANs start ZZZ and belong to no one), monthly
  // pay runs from April posted through the same service as the API, and statutory dues paid
  // on time except the latest month's, which are still to pay.
  const payroll = app.get(PayrollService);
  await payroll.saveSettings(org.id, actor, { pfEstablishmentCode: 'MHBAN0099999000', esiEmployerCode: '31000999990000999', ptRegistration: '27999999999P' });
  const salary = (from: string, basic: string, hra: string, special: string) => ({
    effectiveFrom: from,
    components: [
      { code: 'BASIC', name: 'Basic', kind: 'WAGES' as const, monthlyAmount: basic },
      { code: 'HRA', name: 'House rent allowance', kind: 'EXCLUDED' as const, monthlyAmount: hra },
      { code: 'SPECIAL', name: 'Special allowance', kind: 'WAGES' as const, monthlyAmount: special },
    ],
  });
  const fy = first.slice(0, 4);
  const month = (offset: number) => {
    const d = new Date(Date.UTC(Number(fy), 3 + offset, 1));
    return d.toISOString().slice(0, 7);
  };
  const people = [
    { code: 'NW001', name: 'Aarav Mehta (synthetic)', pan: 'ZZZPM1001Z', dateOfJoining: first, workStateCode: '27', uan: '100900000001', structure: salary(first, '60000', '30000', '20000') },
    { code: 'NW002', name: 'Priya Nair (synthetic)', pan: 'ZZZPN1002Z', dateOfJoining: first, workStateCode: '27', ptCategory: 'WOMAN' as const, uan: '100900000002', structure: salary(first, '35000', '17500', '7500') },
    { code: 'NW003', name: 'Rohan Patil (synthetic)', pan: 'ZZZPP1003Z', dateOfJoining: first, workStateCode: '27', uan: '100900000003', esiNumber: '3100999901', structure: salary(first, '10000', '5000', '3000') },
    { code: 'NW004', name: 'Sneha Joshi (synthetic)', pan: 'ZZZPJ1004Z', dateOfJoining: first, workStateCode: '27', ptCategory: 'WOMAN' as const, pfMember: false, epsMember: false, structure: salary(first, '90000', '45000', '40000') },
    { code: 'NW005', name: 'Kabir Shaikh (synthetic)', pan: null, dateOfJoining: `${month(4)}-11`, workStateCode: '27', uan: '100900000005', structure: salary(`${month(4)}-01`, '22000', '11000', '7000') },
  ];
  const staff = [];
  for (const p of people) staff.push(await payroll.createEmployee(org.id, actor, p));
  // A raise from July for the first employee.
  await payroll.addStructure(org.id, actor, staff[0].id, salary(`${month(3)}-01`, '66000', '33000', '22000'));
  const lastClosed = today.slice(0, 7);
  let runs = 0;
  for (let i = 0; month(i) < lastClosed; i++) {
    const period = month(i);
    const [y, m] = period.split('-').map(Number);
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const run = await payroll.createRun(ledgerOrg, actor, { period, payDate: end });
    if (i === 2) await payroll.updatePayslip(ledgerOrg, actor, run.id, staff[2].id, { lopDays: '2', oneOffs: [] });
    if (period.endsWith('-10')) await payroll.updatePayslip(ledgerOrg, actor, run.id, staff[1].id, { lopDays: '0', oneOffs: [{ name: 'Diwali bonus (synthetic)', kind: 'EXCLUDED', amount: '25000.00' }] });
    const posted = await payroll.postRun(ledgerOrg, actor, run.id);
    runs++;
    const latest = month(i + 1) >= lastClosed;
    const dues = posted.liabilities.filter((l: { liability: string; amount: string }) => !new D(l.amount).isZero() && (!latest || l.liability === 'NET_PAY'));
    for (const l of dues) {
      const paidOn = l.liability === 'NET_PAY' ? end : l.dueDate;
      if (paidOn > today) continue;
      await payroll.remit(ledgerOrg, actor, run.id, { liability: l.liability, date: paidOn, bankAccountId: a['1120'], reference: `SYN-${l.liability}-${period}` });
    }
  }
  console.log(`  Payroll: ${staff.length} synthetic employees, ${runs} posted pay runs`);

  // SYNTHETIC compliance records: monthly GST returns and the TDS statements marked filed with
  // made-up acknowledgements up to last month, advance tax tracked from the start of the year.
  const compliance = app.get(ComplianceService);
  await compliance.saveSettings(org.id, actor, { gstReturnFrequency: 'MONTHLY', advanceTaxFrom: first });
  const past = await compliance.calendar(org.id, first, today);
  let filed = 0;
  for (const i of [...past.overdueBefore, ...past.items]) {
    if (i.nature !== 'RETURN' || i.status === 'DONE') continue;
    // Leave the latest GSTR-3B open so the calendar shows something overdue.
    if (i.kind === 'GSTR3B' && i.dueDate >= addDays(today, -15)) continue;
    const filedOn = i.dueDate < today ? addDays(i.dueDate, i.kind === 'GSTR1' ? -1 : 0) : today;
    await compliance.markFiled(org.id, actor, { key: i.key, filedOn, reference: `SYN-${i.kind}-${i.period.replace(/\W/g, '')}` });
    filed++;
  }
  console.log(`  Compliance: ${filed} synthetic filing records`);

  // SYNTHETIC e-invoicing: settings from the start of last month with the 30-day limit on, and
  // made-up IRP responses for this month's Asterix invoice. The responses are NOT from the IRP:
  // their tokens are unsigned, so the app shows "signature not verified" for them.
  const einv = app.get(EInvoicingService);
  const lastMonth = new Date(Date.parse(`${today.slice(0, 7)}-01T00:00:00Z`));
  lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
  await einv.saveSettings(org.id, actor, { applicableFrom: lastMonth.toISOString().slice(0, 10), aatoTenCroreOrMore: true, tradeName: 'Northwind Demo', address1: '12 Synthetic Tower, MG Road', address2: 'Camp', city: 'Pune', pincode: '411001', goodsUnit: 'NOS', irpPublicKey: null });
  const reg = await einv.register(org.id, lastMonth.toISOString().slice(0, 10), today);
  const unsigned = (data: unknown) => `e30.${Buffer.from(JSON.stringify({ data: JSON.stringify(data), note: 'SYNTHETIC demo token, not issued by the IRP' })).toString('base64url')}.U1lOVEhFVElD`;
  const istStamp = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
  const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  let irns = 0;
  for (const r of reg.rows.filter((x) => x.state === 'READY' && x.contact.id === customers[0].id && x.kind === 'INVOICE' && x.issueDate.slice(0, 7) === today.slice(0, 7))) {
    const irn = createHash('sha256').update(`synthetic-irn-${r.documentId}`).digest('hex');
    const ack = new Date(Date.parse(`${r.issueDate}T06:30:00Z`));
    const qr = { SellerGstin: synthGstin('27', 'ZZZCN0001Z'), BuyerGstin: r.buyerGstin, DocNo: r.number, DocTyp: 'INV', DocDt: ddmmyyyy(r.issueDate), TotInvVal: Number(r.total), ItemCnt: 1, MainHsnCode: '3926', Irn: irn, IrnDt: istStamp(ack) };
    await einv.importResponse(org.id, actor, r.documentId, { Irn: irn, AckNo: `1126${String(100000000 + irns).padStart(11, '0')}`, AckDt: istStamp(ack), SignedInvoice: unsigned({ DocDtls: { Typ: 'INV', No: r.number, Dt: qr.DocDt } }), SignedQRCode: unsigned(qr), Status: 'ACT' });
    irns++;
  }
  console.log(`  E-invoicing: ${irns} synthetic IRNs (unsigned, not from the IRP)`);

  // SYNTHETIC e-way bills: settings with the Rule 138 threshold, and a made-up e-way bill
  // (number not from the portal) with a vehicle for this month's Asterix invoice.
  const ewb = app.get(EWayBillsService);
  await ewb.saveSettings(org.id, actor, { threshold: '50000', intraStateThreshold: null, address1: 'Plot 7, Synthetic Industrial Estate, Bhosari', address2: null, city: 'Pune', pincode: '411026', goodsUnit: 'NOS' });
  const ewbReg = await ewb.register(org.id, lastMonth.toISOString().slice(0, 10), today);
  let ewbs = 0;
  for (const r of ewbReg.rows.filter((x) => x.state === 'NEEDED' && x.contact.id === customers[0].id && x.issueDate.slice(0, 7) === today.slice(0, 7))) {
    const generatedAt = new Date(Math.min(Date.parse(`${r.issueDate}T05:00:00Z`), Date.now() - 60_000));
    await ewb.record(org.id, actor, r.documentId, {
      number: `27${String(1000000000 + ewbs).padStart(10, '0')}`,
      generatedAt: generatedAt.toISOString(),
      validUntil: expectedValidUntil(generatedAt.toISOString(), 18),
      transport: { mode: 'ROAD', distanceKm: 18, vehicleNo: 'MH14ZZ0001', vehicleType: 'R', transporterId: null, transporterName: 'Synthetic Roadways', transDocNo: null, transDocDate: null },
    });
    ewbs++;
  }
  console.log(`  E-way bills: ${ewbs} synthetic e-way bill (not from the portal)`);
  await app.close();
  console.log('Seeded SYNTHETIC demo organization (not real financial activity).');
  console.log(`  Organization: ${org.name} (${org.id})`);
  console.log(`  Journals, documents and payments posted: ${count}`);
  console.log(`  Login: ${DEMO_EMAIL}`);
  if (!process.env.DEMO_PASSWORD) console.log(`  Password (generated, shown once): ${password}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

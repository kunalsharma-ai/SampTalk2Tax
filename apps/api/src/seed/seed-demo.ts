import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { randomBytes } from 'node:crypto';
import { AppModule } from '../app.module';
import { AuthService } from '../auth/auth.service';
import { todayIso } from '../common/dates';
import { PrismaService } from '../common/prisma.service';
import { loadConfig } from '../config';
import { D } from '@talk2tax/accounting-engine';
import { ContactsService } from '../contacts/contacts.service';
import { JournalsService } from '../journals/journals.service';
import { DocumentsService } from '../ledgers/documents.service';
import { TaxRatesService } from '../tax-rates/tax-rates.service';
import { OrganizationsService } from '../organizations/organizations.service';

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
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(config), { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService);
  const existing = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (existing) {
    console.log(`Demo user ${DEMO_EMAIL} already exists; nothing to do.`);
    await app.close();
    return;
  }
  const password = process.env.DEMO_PASSWORD ?? randomBytes(12).toString('base64url');
  const { user } = await app.get(AuthService).register({ email: DEMO_EMAIL, name: 'Demo Owner', password });
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
  const ledgerOrg = { id: org.id, role: 'OWNER' as const, functionalCurrency: 'INR' };
  const taxRate = await app.get(TaxRatesService).create(org.id, actor, { name: 'Sample tax 18% (synthetic)', rate: '18', salesAccountId: a['2300'], purchaseAccountId: a['1450'] });
  const customers = await Promise.all(
    [
      ['Asterix Retail Stores (synthetic)', 30, '1500000.00'],
      ['Brightline Distributors (synthetic)', 45, null],
      ['Coastal Hospitality Group (synthetic)', 15, null],
      ['Overseas Services Client (synthetic)', 30, null],
    ].map(([name, terms, limit]) => contacts.create(ctx, actor, { name: name as string, isCustomer: true, paymentTermsDays: terms as number, creditLimit: limit as string | null })),
  );
  const vendors = await Promise.all(
    [
      ['Delta Wholesale Supplies (synthetic)', 30],
      ['Evergreen Logistics (synthetic)', 15],
    ].map(([name, terms]) => contacts.create(ctx, actor, { name: name as string, isVendor: true, paymentTermsDays: terms as number })),
  );
  const money = (min: number, max: number) => new D(amt(min, max));

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
        { kind: 'INVOICE', contactId: c.id, issueDate: day(5 + i), reference: `PO-${ym}-${i + 1}`, lines: [{ accountId: a['4100'], description: 'Trade goods', quantity: qty, unitPrice: price, taxRateId: taxRate.id }] },
        { post: true, overrideCreditLimit: true },
      );
      invoices.push(inv);
      count += 1;
    }
    const svc = await docs.create(
      ledgerOrg,
      actor,
      'SALES',
      { kind: 'INVOICE', contactId: customers[3].id, issueDate: day(12), lines: [{ accountId: a['4200'], description: 'Consulting services (billed in INR)', quantity: '1', unitPrice: money(160000, 480000).toFixed(2) }] },
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
          lines: [{ accountId: i === 0 ? a['1300'] : a['5000'], description: i === 0 ? 'Stock purchase' : 'Freight inward', quantity: '1', unitPrice: (i === 0 ? money(220000, 340000) : money(15000, 30000)).toFixed(2), taxRateId: taxRate.id }],
        },
        { post: true },
      );
      count += 1;
      if (!isRecent || rand() < 0.4) {
        await docs.createPayment(ledgerOrg, actor, 'PURCHASES', { contactId: v.id, date: day(20), bankAccountId: a['1120'], amount: bill.total, allocations: [{ documentId: bill.id, amount: bill.total }] });
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

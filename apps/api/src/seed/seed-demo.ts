import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { randomBytes } from 'node:crypto';
import { AppModule } from '../app.module';
import { AuthService } from '../auth/auth.service';
import { todayIso } from '../common/dates';
import { PrismaService } from '../common/prisma.service';
import { loadConfig } from '../config';
import { JournalsService } from '../journals/journals.service';
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
  const amt = (min: number, max: number) => (Math.round((min + rand() * (max - min)) * 100) / 100).toFixed(2);
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
  for (const p of periods) {
    const start = p.startDate.toISOString().slice(0, 10);
    if (start > today) break;
    const ym = start.slice(0, 7);
    const day = (d: number) => {
      const iso = `${ym}-${String(d).padStart(2, '0')}`;
      return iso > today ? today : iso;
    };
    const sales = amt(380000, 620000);
    const tax = (Number(sales) * 0.18).toFixed(2);
    const gross = (Number(sales) + Number(tax)).toFixed(2);
    await post(day(5), `Sales invoices ${ym}`, [
      { accountId: a['1200'], debit: gross },
      { accountId: a['4100'], credit: sales },
      { accountId: a['2300'], credit: tax },
    ]);
    const cogs = (Number(sales) * (0.52 + rand() * 0.08)).toFixed(2);
    await post(day(6), `Cost of goods sold ${ym}`, [
      { accountId: a['5000'], debit: cogs },
      { accountId: a['1300'], credit: cogs },
    ]);
    const purchases = amt(220000, 340000);
    await post(day(3), `Inventory purchases ${ym}`, [
      { accountId: a['1300'], debit: purchases },
      { accountId: a['2100'], credit: purchases },
    ]);
    const usd = amt(2000, 6000);
    const rate = (82.5 + rand() * 2).toFixed(4);
    const inr = (Number(usd) * Number(rate)).toFixed(2);
    await post(day(12), `Export service invoice ${ym}`, [
      { accountId: a['1200'], debit: usd, currency: 'USD', exchangeRate: rate },
      { accountId: a['4200'], credit: inr },
    ]);
    const collected = (Number(gross) * (0.7 + rand() * 0.25)).toFixed(2);
    await post(day(18), `Customer receipts ${ym}`, [
      { accountId: a['1120'], debit: collected },
      { accountId: a['1200'], credit: collected },
    ]);
    const paid = (Number(purchases) * (0.75 + rand() * 0.2)).toFixed(2);
    await post(day(20), `Supplier payments ${ym}`, [
      { accountId: a['2100'], debit: paid },
      { accountId: a['1120'], credit: paid },
    ]);
    const salaries = amt(140000, 160000);
    const rent = '45000.00';
    const utilities = amt(6000, 11000);
    const software = amt(9000, 15000);
    const marketing = amt(15000, 40000);
    const charges = amt(300, 900);
    const total = [salaries, rent, utilities, software, marketing, charges].reduce((s, x) => s + Math.round(Number(x) * 100), 0);
    await post(day(28), `Operating expenses ${ym}`, [
      { accountId: a['6100'], debit: salaries },
      { accountId: a['6200'], debit: rent },
      { accountId: a['6300'], debit: utilities },
      { accountId: a['6400'], debit: software },
      { accountId: a['6500'], debit: marketing },
      { accountId: a['6900'], debit: charges },
      { accountId: a['1120'], credit: (total / 100).toFixed(2) },
    ]);
    count += 7;
  }
  await app.close();
  console.log('Seeded SYNTHETIC demo organization (not real financial activity).');
  console.log(`  Organization: ${org.name} (${org.id})`);
  console.log(`  Journals posted: ${count}`);
  console.log(`  Login: ${DEMO_EMAIL}`);
  if (!process.env.DEMO_PASSWORD) console.log(`  Password (generated, shown once): ${password}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

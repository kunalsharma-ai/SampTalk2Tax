import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DocumentStoreService } from '../common/document-store.service';
import { PrismaService } from '../common/prisma.service';
import { allowSystemAccessOutsideRequests } from '../common/tenant-context';
import { loadConfig } from '../config';
import { accounts, fiscalPeriods } from './collections/chart';
import { Decimal128 } from '@talk2tax/document-db';
import { Prisma } from '@talk2tax/database';
import { copyMirroredTables } from './mirror-writes';
import './mirrored-models';
import { journalEntries } from './collections/ledger';
import { allocations, approvalPolicies, approvalRequests, attachments, contacts, documents, payments } from './collections/sales';
import { expenseClaims } from './collections/expenses';
import { bankMatches, bankReconciliations, bankStatementImports, bankStatementLines } from './collections/banking';
import { authSessions, loginThrottles, users } from './collections/identity';
import { invitations, memberships, organizations } from './collections/tenancy';
import { withSystemAccess } from '../common/prisma.service';
import { runAsSystem } from '../common/tenant-context';

/**
 * Copies records of the modules already moved to MongoDB out of an existing PostgreSQL
 * database, for installations that have data from before the move:
 *   pnpm --filter @talk2tax/api run db:copy-to-mongo
 * Records already in MongoDB are left alone, so it is safe to run again. Run it once after
 * deploying each step of the move (docs/MONGODB.md › Existing data).
 */
export async function copyFromPostgres(prisma: PrismaService, store: DocumentStoreService, log: (line: string) => void = console.log) {
  const copied: Record<string, number> = {};

  const missing = async (collection: { name: string }, ids: string[]) => {
    if (!ids.length) return new Set<string>();
    const have = new Set<unknown>(await store.systemDb().collection(collection.name).distinct('_id', { _id: { $in: ids as never[] } }));
    return new Set(ids.filter((id) => !have.has(id)));
  };

  const people = await prisma.user.findMany();
  const newPeople = await missing(users, people.map((u) => u.id));
  const userRows = people.filter((u) => newPeople.has(u.id)).map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    passwordHash: u.passwordHash,
    isActive: u.isActive,
    platformRole: (u.platformRole as 'SUPER_ADMIN' | 'SUPPORT' | null) ?? null,
    language: u.language as 'en' | 'hi',
    numberFormat: u.numberFormat as 'AUTO',
    dateFormat: u.dateFormat as 'D_MON_Y',
    timeZone: u.timeZone,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  }));
  await store.collection(users).insertMany(userRows);
  copied.users = userRows.length;

  const sessions = await prisma.authSession.findMany();
  const newSessions = await missing(authSessions, sessions.map((s) => s.id));
  const sessionRows = sessions.filter((s) => newSessions.has(s.id));
  // A session's guard checks its expiry is after its start, which PostgreSQL also required.
  await store.collection(authSessions).insertMany(sessionRows);
  copied.auth_sessions = sessionRows.length;

  const throttles = await prisma.loginThrottle.findMany();
  const newThrottles = await missing(loginThrottles, throttles.map((t) => t.email));
  const throttleRows = throttles.filter((t) => newThrottles.has(t.email)).map(({ email, ...t }) => ({ id: email, ...t }));
  await store.collection(loginThrottles).insertMany(throttleRows);
  copied.login_throttles = throttleRows.length;

  // Organisations, then who belongs to them, then invitations. Tenant rows are system work.
  const allOrgs = await prisma.$transaction((tx) => withSystemAccess(tx, () => tx.organization.findMany()));
  const newOrgs = await missing(organizations, allOrgs.map((o) => o.id));
  const orgRows = allOrgs.filter((o) => newOrgs.has(o.id)).map((o) => ({
    id: o.id,
    name: o.name,
    legalName: o.legalName,
    timeZone: o.timeZone,
    countryCode: o.countryCode,
    functionalCurrency: o.functionalCurrency,
    fiscalYearStartMonth: o.fiscalYearStartMonth,
    isDemo: o.isDemo,
    dataRegion: o.dataRegion,
    suspendedAt: o.suspendedAt,
    suspendedReason: o.suspendedReason,
    arAccountId: o.arAccountId,
    apAccountId: o.apAccountId,
    claimsAccountId: o.claimsAccountId,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  }));
  await store.collection(organizations).insertMany(orgRows);
  copied.organizations = orgRows.length;

  const allMembers = await prisma.$transaction((tx) => withSystemAccess(tx, () => tx.membership.findMany()));
  const newMembers = await missing(memberships, allMembers.map((m) => m.id));
  const memberRows = allMembers.filter((m) => newMembers.has(m.id));
  // Inserts run no owner check (that guard is on updates and deletes).
  await runAsSystem(() => store.collection(memberships).insertMany(memberRows));
  copied.memberships = memberRows.length;

  const allInvites = await prisma.$transaction((tx) => withSystemAccess(tx, () => tx.invitation.findMany()));
  const newInvites = await missing(invitations, allInvites.map((i) => i.id));
  const inviteRows = allInvites
    .filter((i) => newInvites.has(i.id))
    .map((i) => ({ ...i, ...(i.acceptedAt || i.revokedAt ? {} : { openFor: i.email }) }));
  await runAsSystem(() => store.collection(invitations).insertMany(inviteRows));
  copied.invitations = inviteRows.length;

  // The chart of accounts and fiscal periods are copied in bulk, straight into their
  // collections: PostgreSQL already enforced what their guards check (parents exist, periods do
  // not overlap), and the collection validators still check every document.
  const raw = async (name: string, rows: ({ id: string } & Record<string, unknown>)[]) => {
    for (const chunk of chunks(rows, 1000)) await store.systemDb().collection(name).insertMany(chunk.map(({ id, ...r }) => ({ _id: id as never, ...r })));
  };
  const allAccounts = await prisma.$transaction((tx) => withSystemAccess(tx, () => tx.account.findMany()));
  const newAccounts = await missing(accounts, allAccounts.map((a) => a.id));
  await raw(accounts.name, allAccounts.filter((a) => newAccounts.has(a.id)));
  copied.accounts = newAccounts.size;

  const allPeriods = await prisma.$transaction((tx) => withSystemAccess(tx, () => tx.fiscalPeriod.findMany()));
  const newPeriods = await missing(fiscalPeriods, allPeriods.map((p) => p.id));
  await raw(fiscalPeriods.name, allPeriods.filter((p) => newPeriods.has(p.id)));
  copied.fiscal_periods = newPeriods.size;

  // Journal entries, each with its lines inside it, in batches.
  const entryIds = await prisma.$transaction((tx) => withSystemAccess(tx, () => tx.journalEntry.findMany({ select: { id: true } })));
  const newEntries = [...(await missing(journalEntries, entryIds.map((e) => e.id)))];
  const dec = (v: { toFixed(): string }) => Decimal128.fromString(v.toFixed());
  for (const ids of chunks(newEntries, 500)) {
    const batch = await prisma.$transaction((tx) => withSystemAccess(tx, () => tx.journalEntry.findMany({ where: { id: { in: ids } }, include: { lines: true } })));
    await raw(
      journalEntries.name,
      batch.map(({ lines, totalDebit, totalCredit, ...e }) => ({
        ...e,
        totalDebit: dec(totalDebit),
        totalCredit: dec(totalCredit),
        lines: lines.map(({ entryId: _e, orgId: _o, exchangeRate, debit, credit, functionalDebit, functionalCredit, ...l }) => ({
          ...l,
          exchangeRate: dec(exchangeRate),
          debit: dec(debit),
          credit: dec(credit),
          functionalDebit: dec(functionalDebit),
          functionalCredit: dec(functionalCredit),
        })),
      })),
    );
  }
  copied.journal_entries = newEntries.length;

  const allContacts = await prisma.$transaction((tx) => withSystemAccess(tx, () => tx.contact.findMany()));
  const newContacts = await missing(contacts, allContacts.map((c) => c.id));
  await raw(contacts.name, allContacts.filter((c) => newContacts.has(c.id)).map((c) => ({ ...c, creditLimit: c.creditLimit === null ? null : dec(c.creditLimit) })));
  copied.contacts = newContacts.size;

  // Invoices, bills and credits, each with its lines inside it.
  const docIds = await prisma.$transaction((tx) => withSystemAccess(tx, () => tx.document.findMany({ select: { id: true } })));
  const newDocs = [...(await missing(documents, docIds.map((x) => x.id)))];
  const decs = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Prisma.Decimal ? dec(v) : v]));
  for (const ids of chunks(newDocs, 500)) {
    const batch = await prisma.$transaction((tx) => withSystemAccess(tx, () => tx.document.findMany({ where: { id: { in: ids } }, include: { lines: { orderBy: { lineNo: 'asc' } } } })));
    await raw(documents.name, batch.map(({ lines, ...x }) => ({ ...decs(x), id: x.id, lines: lines.map(({ documentId: _d, orgId: _o, ...l }) => decs(l)) })));
  }
  copied.documents = newDocs.length;

  for (const [def, model] of [
    [payments, 'payment'],
    [allocations, 'allocation'],
    [approvalPolicies, 'approvalPolicy'],
    [approvalRequests, 'approvalRequest'],
    [attachments, 'attachment'],
    [bankStatementImports, 'bankStatementImport'],
    [bankReconciliations, 'bankReconciliation'],
    [bankStatementLines, 'bankStatementLine'],
    [bankMatches, 'bankMatch'],
  ] as const) {
    const rows = (await prisma.$transaction((tx) => withSystemAccess(tx, () => (tx[model] as unknown as { findMany(): Promise<({ id: string } & Record<string, unknown>)[]> }).findMany()))) as ({ id: string } & Record<string, unknown>)[];
    const fresh = await missing(def, rows.map((r) => r.id));
    // Attachment bytes come back from Prisma as Uint8Array; they are stored as BSON binary.
    await raw(def.name, rows.filter((r) => fresh.has(r.id)).map((r) => ({ ...decs(r), id: r.id, ...(r.content instanceof Uint8Array ? { content: Buffer.from(r.content) } : {}) })));
    copied[def.name] = fresh.size;
  }

  // Expense claims, each with its lines inside it.
  const claimIds = await prisma.$transaction((tx) => withSystemAccess(tx, () => tx.expenseClaim.findMany({ select: { id: true } })));
  const newClaims = [...(await missing(expenseClaims, claimIds.map((x) => x.id)))];
  for (const ids of chunks(newClaims, 500)) {
    const batch = await prisma.$transaction((tx) => withSystemAccess(tx, () => tx.expenseClaim.findMany({ where: { id: { in: ids } }, include: { lines: { orderBy: { lineNo: 'asc' } } } })));
    await raw(expenseClaims.name, batch.map(({ lines, ...x }) => ({ ...decs(x), id: x.id, lines: lines.map(({ claimId: _c, orgId: _o, ...l }) => decs(l)) })));
  }
  copied.expense_claims = newClaims.length;

  // Every table whose writes are kept in step (step 7).
  Object.assign(
    copied,
    await copyMirroredTables(
      (model, page) => prisma.$transaction((tx) => withSystemAccess(tx, () => (tx as unknown as Record<string, { findMany(a: unknown): Promise<Record<string, unknown>[]> }>)[model].findMany(page))),
      store,
    ),
  );

  log(`Copied to MongoDB: ${Object.entries(copied).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  return copied;
}

function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

if (require.main === module) {
  (async () => {
    const config = loadConfig();
    allowSystemAccessOutsideRequests();
    const app = await NestFactory.createApplicationContext(AppModule.forRoot(config), { logger: ['error', 'warn'] });
    try {
      await copyFromPostgres(app.get(PrismaService), app.get(DocumentStoreService));
    } finally {
      await app.close();
    }
  })().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DocumentStoreService } from '../common/document-store.service';
import { PrismaService } from '../common/prisma.service';
import { allowSystemAccessOutsideRequests } from '../common/tenant-context';
import { loadConfig } from '../config';
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
    const have = await store.systemDb().collection(collection.name).distinct('_id', { _id: { $in: ids as never[] } });
    return new Set(ids.filter((id) => !have.includes(id as never)));
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

  log(`Copied to MongoDB: ${Object.entries(copied).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  return copied;
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

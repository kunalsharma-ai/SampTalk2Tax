import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DocumentStoreService } from '../common/document-store.service';
import { PrismaService } from '../common/prisma.service';
import { allowSystemAccessOutsideRequests } from '../common/tenant-context';
import { loadConfig } from '../config';
import { authSessions, loginThrottles, users } from './collections/identity';

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

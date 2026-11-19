import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Decimal128 } from '@talk2tax/document-db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../src/admin/admin.service';
import { main } from '../src/db/backup';
import { migrate } from '../src/db/migrate';
import { bootApp, Ctx, registerUser, TestUser } from './helpers';

/**
 * Backups and disaster recovery (SEC-021/022) against a real MongoDB: the backup command writes
 * an encrypted backup of a migrated database, keeps the newest N, checks a file end to end, runs
 * a restore drill into a scratch database and drops it, and restores into an empty database
 * that then matches the original. Each run is recorded, and platform admins see them under
 * Platform admin → Backups.
 */
const TEST_URL = process.env.TEST_MONGODB_URL ?? process.env.MONGODB_URL!;
const withDb = (url: string, db: string) => url.replace(/^(mongodb(?:\+srv)?:\/\/[^/]+)\/[^?]*/, `$1/${db}`);
const tag = randomUUID().slice(0, 8);
const SOURCE = withDb(TEST_URL, `t2t_bk_src_${tag}`);
const RESTORED = withDb(TEST_URL, `t2t_bk_dst_${tag}`);
const KEY = 'backup-key-for-the-test-suite-only';
let ctx: Ctx;
let admin: TestUser;
let dir: string;
let file: string;
const out: string[] = [];
const run = (args: string[], env: Record<string, string | undefined> = {}) => main(args, { MONGODB_URL: SOURCE, BACKUP_ENCRYPTION_KEY: KEY, ...env }, (l) => out.push(l));

beforeAll(async () => {
  ctx = await bootApp();
  admin = await registerUser(ctx, 'Backup Admin');
  await ctx.app.get(AdminService).grant(admin.email, 'SUPER_ADMIN');
  dir = await fs.mkdtemp(join(tmpdir(), 't2t-backups-'));
  await migrate(SOURCE, () => undefined);
}, 120_000);
afterAll(async () => {
  const client = ctx.store.systemDb().client;
  await client.db(`t2t_bk_src_${tag}`).dropDatabase();
  await client.db(`t2t_bk_dst_${tag}`).dropDatabase();
  await ctx?.app.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('backups', () => {
  it('refuses to write a backup nobody can keep secret, unless asked', async () => {
    await expect(run(['create', '--out', dir], { BACKUP_ENCRYPTION_KEY: '' })).rejects.toThrow(/Set BACKUP_ENCRYPTION_KEY/);
    await expect(run(['create', '--out', dir, '--keep', '0'])).rejects.toThrow(/--keep/);
    await expect(run(['nonsense'])).rejects.toThrow(/Usage/);
  });

  it('backs up a migrated database, keeps the newest, and records each run', async () => {
    const client = ctx.store.systemDb().client;
    const db = client.db(`t2t_bk_src_${tag}`);
    await db.collection('test_notes').insertOne({ _id: randomUUID() as never, name: 'Backed Up Traders', amount: Decimal128.fromString('1234.50'), createdAt: new Date() });
    for (let i = 0; i < 3; i++) await run(['create', '--out', dir, '--keep', '2']);
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.t2tbak')).sort();
    expect(files).toHaveLength(2);
    file = join(dir, files.at(-1)!);
    expect(out.at(-2)).toMatch(/^Backed up to .*\.t2tbak: .* documents in \d+ collections, .* encrypted, taken/);
    expect(out.at(-1)).toMatch(/^Removed 1 older backup: talk2tax-t2t_bk_src_/);
    const runs = await db.collection('backup_runs').find({ kind: 'BACKUP' }).toArray();
    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.status === 'OK' && r.encrypted === true && r.consistent === true && /^[0-9a-f]{64}$/.test(r.fileSha256))).toBe(true);
  });

  it('checks a backup, and records a damaged one as failed', async () => {
    await run(['verify', '--in', file]);
    expect(out.at(-1)).toMatch(/^The backup is whole: /);
    const bad = join(dir, 'damaged.t2tbak');
    const bytes = await fs.readFile(file);
    bytes[bytes.length - 40] ^= 0xff;
    await fs.writeFile(bad, bytes);
    await expect(run(['verify', '--in', bad])).rejects.toThrow(/backup key is wrong, or the file was changed or damaged/);
    await expect(run(['verify', '--in', file], { BACKUP_ENCRYPTION_KEY: 'a-different-key-altogether' })).rejects.toThrow(/backup key is wrong/);
    const db = ctx.store.systemDb().client.db(`t2t_bk_src_${tag}`);
    const failed = await db.collection('backup_runs').find({ kind: 'VERIFY', status: 'FAILED' }).toArray();
    expect(failed.map((r) => r.fileName).sort()).toEqual(['damaged.t2tbak', file.split('/').pop()].sort());
    await fs.rm(bad);
  });

  it('runs a restore drill into a scratch database and drops it', async () => {
    const client = ctx.store.systemDb().client;
    const before = (await client.db().admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);
    await run(['drill', '--in', file]);
    expect(out.at(-1)).toMatch(/^Restore drill passed in [\d.]+ s: .* \(restored into t2t_bk_src_\w+_drill_\d+, then dropped\)$/);
    const after = (await client.db().admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name);
    expect(after.filter((n) => n.includes('_drill_') && n.startsWith(`t2t_bk_src_${tag}`))).toEqual(before.filter((n) => n.includes('_drill_') && n.startsWith(`t2t_bk_src_${tag}`)));
    const drill = await client.db(`t2t_bk_src_${tag}`).collection('backup_runs').findOne({ kind: 'RESTORE_DRILL' });
    expect(drill).toMatchObject({ status: 'OK', fileName: file.split('/').pop() });
  });

  it('restores into an empty database that then matches the original', async () => {
    await run(['restore', '--in', file, '--to-url', RESTORED]);
    expect(out.at(-1)).toMatch(/Run the migrations against it before starting the API\.$/);
    const client = ctx.store.systemDb().client;
    const a = client.db(`t2t_bk_src_${tag}`);
    const b = client.db(`t2t_bk_dst_${tag}`);
    expect(await b.collection('test_notes').findOne({ name: 'Backed Up Traders' })).toEqual(await a.collection('test_notes').findOne({ name: 'Backed Up Traders' }));
    // The migrations it was taken with came along: nothing is left to apply.
    expect(await migrate(RESTORED, () => undefined)).toEqual([]);
    await expect(run(['restore', '--in', file, '--to-url', RESTORED])).rejects.toThrow(/already holds .* collections; restore into an empty database/);
  });

  it('shows platform admins the newest backup and drill, and keeps the record as it happened', async () => {
    // Recorded in the database the API uses, as the backup command would on that server.
    await main(['drill', '--in', file], { MONGODB_URL: TEST_URL, BACKUP_ENCRYPTION_KEY: KEY }, () => undefined);
    const r = (await ctx.http().get('/v1/admin/backups').set(admin.auth).expect(200)).body;
    expect(r.lastDrill).toMatchObject({ fileName: file.split('/').pop() });
    expect(r.drillOverdue).toBe(false);
    expect(r.limits).toEqual({ backupMaxAgeHours: 26, restoreDrillMaxAgeDays: 35 });
    expect(r.runs[0]).toMatchObject({ kind: 'RESTORE_DRILL', status: 'OK', encrypted: true, fileName: file.split('/').pop() });
    expect((await ctx.http().get('/v1/admin/backups?kind=RESTORE_DRILL').set(admin.auth).expect(200)).body.runs.every((x: { kind: string }) => x.kind === 'RESTORE_DRILL')).toBe(true);
    const owner = await registerUser(ctx, 'Not An Admin');
    await ctx.http().get('/v1/admin/backups').set(owner.auth).expect(403);
    await expect(ctx.prisma.backupRun.update({ where: { id: r.runs[0].id }, data: { status: 'FAILED', error: 'tampered' } })).rejects.toThrow(/cannot be changed or deleted/);
    await expect(ctx.prisma.backupRun.delete({ where: { id: r.runs[0].id } })).rejects.toThrow(/cannot be changed or deleted/);
  });
});

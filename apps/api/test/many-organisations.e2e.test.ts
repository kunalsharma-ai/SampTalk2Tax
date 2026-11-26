import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlertsRunnerService, ALERTS_RUNNER_LOOK } from '../src/alerts/alerts-runner.service';
import { COLLECTIONS } from '../src/db/collections';
import { OrgRotationService } from '../src/operations/org-rotation.service';
import { bootApp, createOrg, Ctx, registerUser, today, TestUser } from './helpers';

/**
 * Thousands of organisations (PERF-001). The alert checks visit every organisation in turn: a
 * pass reads only the organisations that are due, by index, so it costs the same with 1,500
 * organisations as with ten, and an organisation without books is not looked at again for an
 * hour. Run on a database of its own, so that the other suites' organisations are not touched.
 */
const ORGS = 1_500;
const url = new URL((process.env.TEST_MONGODB_URL ?? '').replace(/^mongodb(\+srv)?:/, 'http:'));
const DB_URL = (process.env.TEST_MONGODB_URL ?? '').replace(url.pathname, `/talk2tax_scale_test_${process.pid}`);
let ctx: Ctx;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const HOUR = 3_600_000;

async function commandsDuring<T>(fn: () => Promise<T>): Promise<{ result: T; commands: number }> {
  let commands = 0;
  const stop = ctx.store.onCommandStarted(() => commands++);
  try {
    return { result: await fn(), commands };
  } finally {
    stop();
  }
}

beforeAll(async () => {
  execSync('node dist/db/migrate.js', { cwd: resolve(__dirname, '..'), env: { ...process.env, MONGODB_URL: DB_URL }, stdio: 'pipe' });
  ctx = await bootApp({ MONGODB_URL: DB_URL });
  owner = await registerUser(ctx, 'Many Orgs Owner');
  org = await createOrg(ctx, owner, { name: 'The One With Books' });
  const [cash, sales] = [org.acc['1120'], org.acc['4100']];
  await ctx
    .http()
    .post(`${org.base}/journals`)
    .set(owner.auth)
    .send({
      date: today(),
      post: true,
      memo: 'Scale test',
      lines: [
        { accountId: cash, debit: '100.00' },
        { accountId: sales, credit: '100.00' },
      ],
    })
    .expect(201);
  // 1,499 more organisations, with no books yet, as most new sign-ups are.
  const one = await ctx.db.collection('organizations').findOne({ _id: org.orgId as never });
  const copies = Array.from({ length: ORGS - 1 }, (_, i) => ({ ...one, _id: `scale-org-${i}`, name: `Scale Org ${i}` }));
  await ctx.db.collection('organizations').insertMany(copies as never[]);
}, 120_000);
afterAll(async () => {
  await ctx?.db.dropDatabase().catch(() => undefined);
  await ctx?.app.close();
});

describe('Background checks with many organisations', () => {
  it('visits every organisation in turn, a bounded number per pass', async () => {
    const runner = ctx.app.get(AlertsRunnerService);
    const rotation = ctx.app.get(OrgRotationService);
    const now = new Date();
    let checked = 0;
    let passes = 0;
    for (; passes < 20 && (passes === 0 || (await rotation.counts('alerts', now)).due > 0); passes++) {
      const { result } = await commandsDuring(() => runner.tick({ now }));
      checked += result.checked;
    }
    // Every organisation joined the rotation; each pass looked at no more than its share.
    expect(await rotation.counts('alerts', now)).toEqual({ organisations: ORGS, due: 0 });
    expect(passes).toBe(Math.ceil(ORGS / ALERTS_RUNNER_LOOK));
    // Only the organisation with books was checked.
    expect(checked).toBe(1);
    expect(await ctx.prisma.alertScan.count({ where: { orgId: org.orgId } })).toBe(1);
  }, 120_000);

  it('costs a few queries when nothing is due, however many organisations there are', async () => {
    const { result, commands } = await commandsDuring(() => ctx.app.get(AlertsRunnerService).tick({ now: new Date(Date.now() + 60_000) }));
    expect(result).toEqual({ checked: 0, failed: 0 });
    expect(commands).toBeLessThanOrEqual(4);
  });

  it('comes back to each organisation an hour later, and takes in new ones at once', async () => {
    const runner = ctx.app.get(AlertsRunnerService);
    const fresh = await createOrg(ctx, owner, { name: 'Signed Up Just Now' });
    const rotation = ctx.app.get(OrgRotationService);
    // The new organisation is due straight away; the others not before their hour is up.
    await runner.tick({ now: new Date(Date.now() + 60_000) });
    expect(await rotation.counts('alerts', new Date(Date.now() + 60_000))).toEqual({ organisations: ORGS + 1, due: 0 });
    expect(fresh.orgId).toBeTruthy();
    const later = new Date(Date.now() + 2 * HOUR);
    expect((await rotation.counts('alerts', later)).due).toBe(ORGS + 1);
    let checked = 0;
    for (let i = 0; i < 20 && (await rotation.counts('alerts', later)).due > 0; i++) checked += (await runner.tick({ now: later })).checked;
    expect(checked).toBe(1);
    expect(await ctx.prisma.alertScan.count({ where: { orgId: org.orgId } })).toBe(2);
  }, 120_000);
});

describe('Indexes for many organisations', () => {
  it('gives every organisation collection an index that starts with the organisation', () => {
    const without = COLLECTIONS.filter((c) => c.scope === 'tenant' && !(c.indexes ?? []).some((i) => Object.keys(i.key)[0] === 'orgId')).map((c) => c.name);
    expect(without).toEqual([]);
  });
});

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocumentStoreService } from '../src/common/document-store.service';
import { tenantStorage } from '../src/common/tenant-context';
import { MIGRATIONS } from '../src/db/migrations';
import { bootApp, type Ctx } from './helpers';

const SRC = join(__dirname, '../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('MongoDB data layer in the API', () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await bootApp();
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('connects to a replica set and reports it in /health', async () => {
    expect((await ctx.http().get('/health').expect(200)).body.database).toBe('ok');
    const store = ctx.app.get(DocumentStoreService);
    const hello = await store.systemDb().admin().command({ hello: 1 });
    expect(hello.setName).toBeTruthy();
  });

  it('has applied every migration', async () => {
    const store = ctx.app.get(DocumentStoreService);
    const applied = (await store.systemDb().collection('_migrations').find().toArray()).map((m) => m._id);
    expect(applied).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it('a request with no organisation gets no tenant sequence', async () => {
    const store = ctx.app.get(DocumentStoreService);
    await expect(tenantStorage.run({}, () => store.nextTenantSequence('invoice'))).rejects.toThrow(/No organisation/);
    const first = await tenantStorage.run({ orgId: 'org-seq-test-' + Date.now() }, () => store.nextTenantSequence('invoice'));
    expect(first).toBe(1);
  });

  it('only the data layer imports the MongoDB driver or the raw database handle', () => {
    const offenders = sourceFiles(SRC)
      .map((path) => ({ path: relative(SRC, path), text: readFileSync(path, 'utf8') }))
      .filter(({ path }) => !path.startsWith('db/'))
      .filter(({ text }) => /from ['"]mongodb['"]|require\(['"]mongodb['"]\)|\.systemDb\(/.test(text))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});

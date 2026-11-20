import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { BackupError, type BackupManifest, type Db, DocumentStore, restoreBackup, verifyBackup, writeBackup } from '@talk2tax/document-db';
import { COLLECTIONS } from './collections';
import { resolveSecretFiles } from '../config';

/**
 * Backups and restore drills (SEC-021/022), run outside the API by the operator's scheduler:
 *
 *   node dist/db/backup.js create --out /backups [--keep 14] [--unencrypted]
 *   node dist/db/backup.js verify --in /backups/talk2tax-....t2tbak
 *   node dist/db/backup.js drill  --in /backups/talk2tax-....t2tbak [--scratch-url mongodb://...]
 *   node dist/db/backup.js restore --in /backups/talk2tax-....t2tbak --to-url mongodb://.../talk2tax_restored
 *
 * MONGODB_URL is the database backed up, and where each run is recorded (backup_runs, shown
 * under Platform admin → Backups). BACKUP_ENCRYPTION_KEY (at least 16 characters) encrypts and
 * decrypts the files; without it `create` refuses unless --unencrypted is given.
 */
export type BackupKind = 'BACKUP' | 'VERIFY' | 'RESTORE_DRILL';
const EXT = '.t2tbak';

interface RunRecord {
  kind: BackupKind;
  status: 'OK' | 'FAILED';
  fileName: string;
  manifest?: BackupManifest;
  durationMs: number;
  error?: string;
}

async function record(db: Db, r: RunRecord): Promise<void> {
  const m = r.manifest;
  await db.collection('backup_runs').insertOne({
    _id: randomUUID() as never,
    kind: r.kind,
    status: r.status,
    fileName: r.fileName.slice(0, 255),
    bytes: m?.bytes ?? null,
    fileSha256: m?.fileSha256 ?? null,
    encrypted: m?.encrypted ?? null,
    consistent: m?.consistent ?? null,
    collections: m ? m.collections.length : null,
    documents: m?.documents ?? null,
    backupTakenAt: m ? new Date(m.createdAt) : null,
    durationMs: r.durationMs,
    host: hostname().slice(0, 255),
    error: r.error ? r.error.slice(0, 1000) : null,
    createdAt: new Date(),
  });
}

/** The database a URL names (the path), or null. */
function dbName(url: string): string | null {
  const path = url.replace(/^mongodb(\+srv)?:\/\/[^/]*/, '').split('?')[0]!.replace(/^\//, '');
  return path ? decodeURIComponent(path) : null;
}

async function open(url: string): Promise<DocumentStore> {
  const store = new DocumentStore({ url, collections: COLLECTIONS, context: () => ({ bypass: true }) });
  await store.connect();
  return store;
}

/** Deletes all but the newest `keep` backup files in a directory. */
async function prune(dir: string, keep: number): Promise<string[]> {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(EXT)).sort();
  const old = files.slice(0, Math.max(0, files.length - keep));
  for (const f of old) await fs.rm(join(dir, f), { force: true });
  return old;
}

export async function createBackup(url: string, out: string, opts: { key?: string; keep?: number; now?: Date } = {}): Promise<{ file: string; manifest: BackupManifest; pruned: string[] }> {
  const store = await open(url);
  const db = store.systemDb();
  const started = Date.now();
  let file = out;
  try {
    const isDir = await fs.stat(out).then((s) => s.isDirectory(), () => false);
    if (isDir) file = join(out, `talk2tax-${db.databaseName}-${(opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-')}${EXT}`);
    const manifest = await writeBackup(db, file, { key: opts.key, now: opts.now });
    await record(db, { kind: 'BACKUP', status: 'OK', fileName: basename(file), manifest, durationMs: Date.now() - started });
    const pruned = isDir && opts.keep ? await prune(out, opts.keep) : [];
    return { file, manifest, pruned };
  } catch (e) {
    await record(db, { kind: 'BACKUP', status: 'FAILED', fileName: basename(file), durationMs: Date.now() - started, error: (e as Error).message }).catch(() => undefined);
    throw e;
  } finally {
    await store.close();
  }
}

export async function checkBackup(url: string, file: string, opts: { key?: string } = {}): Promise<BackupManifest> {
  const store = await open(url);
  const started = Date.now();
  try {
    const manifest = await verifyBackup(file, opts);
    await record(store.systemDb(), { kind: 'VERIFY', status: 'OK', fileName: basename(file), manifest, durationMs: Date.now() - started });
    return manifest;
  } catch (e) {
    await record(store.systemDb(), { kind: 'VERIFY', status: 'FAILED', fileName: basename(file), durationMs: Date.now() - started, error: (e as Error).message }).catch(() => undefined);
    throw e;
  } finally {
    await store.close();
  }
}

/**
 * A restore drill: restores the backup into a new scratch database, checks every collection
 * holds the documents the backup says it does, drops the scratch database, and records the
 * result. The scratch database is on the same server unless scratchUrl names another.
 */
export async function restoreDrill(url: string, file: string, opts: { key?: string; scratchUrl?: string; now?: Date } = {}): Promise<{ manifest: BackupManifest; scratch: string; durationMs: number }> {
  const store = await open(url);
  const started = Date.now();
  const scratchStore = opts.scratchUrl ? await open(opts.scratchUrl) : null;
  const scratchName = `${store.systemDb().databaseName}_drill_${(opts.now ?? new Date()).toISOString().slice(0, 19).replace(/[-:T]/g, '')}`.slice(0, 63);
  const scratch = (scratchStore ?? store).systemDb().client.db(scratchName);
  try {
    const manifest = await restoreBackup(file, scratch, opts);
    for (const c of manifest.collections) {
      // restoreBackup counted every collection before building its indexes. Collections with a
      // TTL index lose expired documents from then on, so they are not counted again here.
      if ((await scratch.collection(c.name).indexes()).some((i) => i.expireAfterSeconds !== undefined)) continue;
      const n = await scratch.collection(c.name).countDocuments();
      if (n !== c.documents) throw new BackupError('DAMAGED', `${c.name} has ${n} documents after the restore, not ${c.documents}`);
    }
    const durationMs = Date.now() - started;
    await scratch.dropDatabase();
    await record(store.systemDb(), { kind: 'RESTORE_DRILL', status: 'OK', fileName: basename(file), manifest, durationMs });
    return { manifest, scratch: scratchName, durationMs };
  } catch (e) {
    if ((e as BackupError).code !== 'TARGET_NOT_EMPTY') await scratch.dropDatabase().catch(() => undefined);
    await record(store.systemDb(), { kind: 'RESTORE_DRILL', status: 'FAILED', fileName: basename(file), durationMs: Date.now() - started, error: (e as Error).message }).catch(() => undefined);
    throw e;
  } finally {
    await scratchStore?.close();
    await store.close();
  }
}

/** Restores a backup into the empty database toUrl names (a disaster recovery). */
export async function restoreInto(toUrl: string, file: string, opts: { key?: string } = {}): Promise<BackupManifest> {
  if (!dbName(toUrl)) throw new Error('--to-url must name the database to restore into, as mongodb://host/<database>');
  const store = await open(toUrl);
  try {
    return await restoreBackup(file, store.systemDb(), opts);
  } finally {
    await store.close();
  }
}

function args(argv: string[]): { cmd: string | undefined; flags: Record<string, string | true> } {
  const flags: Record<string, string | true> = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[a.slice(2)] = next;
      i++;
    } else flags[a.slice(2)] = true;
  }
  return { cmd: argv[0], flags };
}

const describe = (m: BackupManifest) =>
  `${m.documents.toLocaleString('en-IN')} documents in ${m.collections.length} collections, ${(m.bytes / 1024 / 1024).toFixed(1)} MB, ${m.encrypted ? 'encrypted' : 'NOT encrypted'}, taken ${m.createdAt}, sha256 ${m.fileSha256}`;

export async function main(argv: string[], given: NodeJS.ProcessEnv, log: (s: string) => void = console.log): Promise<void> {
  const { cmd, flags } = args(argv);
  // BACKUP_ENCRYPTION_KEY_FILE and MONGODB_URL_FILE work as for the API (SEC-012).
  const files = resolveSecretFiles(given);
  if (files.errors.length) throw new Error(files.errors.join('; '));
  const env = files.env;
  const url = env.MONGODB_URL;
  if (!url) throw new Error('MONGODB_URL is required');
  const key = env.BACKUP_ENCRYPTION_KEY?.trim() || undefined;
  const need = (name: string) => {
    const v = flags[name];
    if (typeof v !== 'string') throw new Error(`--${name} is required`);
    return v;
  };
  switch (cmd) {
    case 'create': {
      if (!key && flags.unencrypted !== true) throw new Error('Set BACKUP_ENCRYPTION_KEY (at least 16 characters) to encrypt the backup, or pass --unencrypted');
      const keep = flags.keep === undefined ? undefined : Number(flags.keep);
      if (keep !== undefined && (!Number.isInteger(keep) || keep < 1)) throw new Error('--keep is the number of backups to keep, 1 or more');
      const r = await createBackup(url, need('out'), { key, keep });
      log(`Backed up to ${r.file}: ${describe(r.manifest)}`);
      if (r.pruned.length) log(`Removed ${r.pruned.length} older backup${r.pruned.length === 1 ? '' : 's'}: ${r.pruned.join(', ')}`);
      return;
    }
    case 'verify': {
      const m = await checkBackup(url, need('in'), { key });
      log(`The backup is whole: ${describe(m)}`);
      return;
    }
    case 'drill': {
      const r = await restoreDrill(url, need('in'), { key, scratchUrl: typeof flags['scratch-url'] === 'string' ? flags['scratch-url'] : undefined });
      log(`Restore drill passed in ${(r.durationMs / 1000).toFixed(1)} s: ${describe(r.manifest)} (restored into ${r.scratch}, then dropped)`);
      return;
    }
    case 'restore': {
      const m = await restoreInto(need('to-url'), need('in'), { key });
      log(`Restored ${describe(m)}. Run the migrations against it before starting the API.`);
      return;
    }
    default:
      throw new Error('Usage: backup.js create --out <dir|file> [--keep N] [--unencrypted] | verify --in <file> | drill --in <file> [--scratch-url <url>] | restore --in <file> --to-url <url>');
  }
}

if (require.main === module) {
  main(process.argv.slice(2), process.env).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

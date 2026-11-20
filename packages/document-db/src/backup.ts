import { type CipherGCM, createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { PassThrough, type Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { BSON, type ClientSession, type Db, type Document } from 'mongodb';

/**
 * Database backups (SEC-021): every collection of one database, with its validation rules and
 * indexes, written as one file that can be checked and restored. The file is gzip-compressed
 * lines of MongoDB Extended JSON (canonical, so decimals, dates and binary come back exactly),
 * ending with the document counts and a SHA-256 of everything before them. With a key it is
 * also encrypted with AES-256-GCM (key from the passphrase with scrypt), which makes any change
 * to the file detectable.
 *
 * Layout: 8-byte magic (T2TBAK1P plain, T2TBAK1E encrypted); encrypted files then carry a
 * 16-byte salt and 12-byte IV, the ciphertext, and the 16-byte GCM tag at the very end.
 */
const MAGIC_PLAIN = Buffer.from('T2TBAK1P');
const MAGIC_SEALED = Buffer.from('T2TBAK1E');
const FORMAT = 'talk2tax-backup';
const VERSION = 1;
const BATCH = 1000;

export interface BackupCollection {
  name: string;
  documents: number;
  indexes: number;
}
export interface BackupManifest {
  format: typeof FORMAT;
  version: number;
  createdAt: string;
  database: string;
  encrypted: boolean;
  /** Read from one point in time (a snapshot), not collection by collection. */
  consistent: boolean;
  collections: BackupCollection[];
  documents: number;
  /** SHA-256 of the backup's content lines, as recorded at its end. */
  contentSha256: string;
  /** Size of the file and SHA-256 of its bytes, for comparing copies. */
  bytes: number;
  fileSha256: string;
}

export class BackupError extends Error {
  constructor(
    readonly code: 'NOT_A_BACKUP' | 'KEY_REQUIRED' | 'WRONG_KEY_OR_DAMAGED' | 'DAMAGED' | 'TARGET_NOT_EMPTY' | 'SNAPSHOT_TOO_OLD',
    message: string,
  ) {
    super(message);
  }
}

type Line =
  | { t: 'header'; format: string; version: number; createdAt: string; database: string; consistent: boolean }
  | { t: 'collection'; name: string; options: Document; indexes: Document[] }
  | { t: 'doc'; c: string; d: Document }
  | { t: 'end'; counts: Record<string, number>; documents: number; sha256: string };

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  if (passphrase.length < 16) throw new BackupError('KEY_REQUIRED', 'The backup key must be at least 16 characters');
  return scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

const ejson = (v: unknown) => BSON.EJSON.stringify(v as Document, { relaxed: false });

async function fileSha256(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { bytes, sha256: hash.digest('hex') };
}

/**
 * Writes a backup of `db` to `path`. With `key`, the file is encrypted. Collections are read in
 * one snapshot so the backup is consistent across collections (MongoDB keeps snapshots for
 * minSnapshotHistoryWindowInSeconds, 300 s by default; a longer backup fails with
 * SNAPSHOT_TOO_OLD unless `consistent: false`).
 */
export async function writeBackup(db: Db, path: string, opts: { key?: string; consistent?: boolean; now?: Date } = {}): Promise<BackupManifest> {
  const consistent = opts.consistent !== false;
  const createdAt = (opts.now ?? new Date()).toISOString();
  const out = createWriteStream(path, { mode: 0o600 });
  const gzip = createGzip({ level: 6 });
  let sealed: { salt: Buffer; iv: Buffer; cipher: CipherGCM } | null = null;
  if (opts.key) {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    sealed = { salt, iv, cipher: createCipheriv('aes-256-gcm', deriveKey(opts.key, salt), iv) };
  }
  out.write(sealed ? Buffer.concat([MAGIC_SEALED, sealed.salt, sealed.iv]) : MAGIC_PLAIN);
  const lines = new PassThrough();
  const done = sealed ? pipeline(lines, gzip, sealed.cipher, out, { end: false }) : pipeline(lines, gzip, out, { end: false });

  const hash = createHash('sha256');
  const write = async (line: Line, hashed = true) => {
    const text = (line.t === 'doc' ? `{"t":"doc","c":${JSON.stringify(line.c)},"d":${ejson(line.d)}}` : ejson(line)) + '\n';
    if (hashed) hash.update(text);
    if (!lines.write(text)) await new Promise((r) => lines.once('drain', r));
  };

  const session: ClientSession | undefined = consistent ? db.client.startSession({ snapshot: true }) : undefined;
  const collections: BackupCollection[] = [];
  const counts: Record<string, number> = {};
  try {
    await write({ t: 'header', format: FORMAT, version: VERSION, createdAt, database: db.databaseName, consistent });
    const infos = (await db.listCollections().toArray()).filter((c) => c.type !== 'view' && !c.name.startsWith('system.')).sort((a, b) => a.name.localeCompare(b.name));
    for (const info of infos) {
      const coll = db.collection(info.name);
      const indexes = (await coll.listIndexes().toArray()).filter((i) => i.name !== '_id_').map(({ v: _v, ns: _ns, ...spec }) => spec);
      await write({ t: 'collection', name: info.name, options: (info as { options?: Document }).options ?? {}, indexes });
      let n = 0;
      for await (const d of coll.find({}, { session, sort: { _id: 1 } })) {
        await write({ t: 'doc', c: info.name, d });
        n++;
      }
      counts[info.name] = n;
      collections.push({ name: info.name, documents: n, indexes: indexes.length });
    }
  } catch (e) {
    done.catch(() => undefined);
    lines.destroy();
    out.destroy();
    await fs.rm(path, { force: true });
    if ((e as { code?: number }).code === 239) throw new BackupError('SNAPSHOT_TOO_OLD', 'The backup took longer than MongoDB keeps a snapshot. Raise minSnapshotHistoryWindowInSeconds or run with consistent reads off.');
    throw e;
  } finally {
    await session?.endSession();
  }
  const documents = Object.values(counts).reduce((a, b) => a + b, 0);
  const contentSha256 = hash.digest('hex');
  await write({ t: 'end', counts, documents, sha256: contentSha256 }, false);
  lines.end();
  await done;
  if (sealed) out.write(sealed.cipher.getAuthTag());
  await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  const file = await fileSha256(path);
  return { format: FORMAT, version: VERSION, createdAt, database: db.databaseName, encrypted: !!sealed, consistent, collections, documents, contentSha256, bytes: file.bytes, fileSha256: file.sha256 };
}

/** The lines of a text stream, without readline (which drops the stream's error listeners on close). */
async function* splitLines(stream: Readable): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let rest = '';
  for await (const chunk of stream) {
    const parts = (rest + decoder.write(chunk as Buffer)).split('\n');
    rest = parts.pop() ?? '';
    for (const p of parts) yield p;
  }
  rest += decoder.end();
  if (rest) yield rest;
}

/** Reads a backup file line by line, checking its key, its counts and its checksum. */
async function readLines(path: string, key: string | undefined, onLine: (line: Line) => Promise<void>): Promise<{ header: Extract<Line, { t: 'header' }>; end: Extract<Line, { t: 'end' }>; encrypted: boolean; file: { bytes: number; sha256: string } }> {
  // One open file for every read, so the checks and the restore see the same bytes.
  const handle = await fs.open(path, 'r');
  let source: Readable;
  let encrypted = false;
  const fileHash = createHash('sha256');
  let fileBytes = 0;
  try {
    const size = (await handle.stat()).size;
    const prefix = Buffer.alloc(Math.min(36, size));
    await handle.read(prefix, 0, prefix.length, 0);
    const magic = prefix.subarray(0, 8);
    if (magic.equals(MAGIC_PLAIN)) {
      fileHash.update(magic);
      fileBytes = 8;
      source = handle.createReadStream({ start: 8, autoClose: true });
      source.on('data', (c: Buffer) => {
        fileHash.update(c);
        fileBytes += c.length;
      });
    } else if (magic.equals(MAGIC_SEALED)) {
      fileHash.update(prefix);
      fileBytes = prefix.length;
      encrypted = true;
      if (!key) throw new BackupError('KEY_REQUIRED', 'This backup is encrypted: give the backup key');
      if (size < 36 + 16) throw new BackupError('DAMAGED', 'The backup file is cut short');
      const tagBuf = Buffer.alloc(16);
      await handle.read(tagBuf, 0, 16, size - 16);
      const decipher = createDecipheriv('aes-256-gcm', deriveKey(key, prefix.subarray(8, 24)), prefix.subarray(24, 36));
      decipher.setAuthTag(tagBuf);
      const body = handle.createReadStream({ start: 36, end: size - 17, autoClose: true });
      body.on('data', (c: Buffer) => {
        fileHash.update(c);
        fileBytes += c.length;
      });
      body.on('end', () => {
        fileHash.update(tagBuf);
        fileBytes += tagBuf.length;
      });
      source = body.pipe(decipher);
      body.on('error', (e) => decipher.destroy(e));
    } else {
      throw new BackupError('NOT_A_BACKUP', 'This is not a Talk2Tax backup file');
    }
  } catch (e) {
    await handle.close();
    throw e;
  }

  const gunzip = createGunzip();
  const failed = new Promise<never>((_, reject) => {
    const fail = (e: Error) => reject(encrypted && /auth|decrypt|unable/i.test(e.message) ? new BackupError('WRONG_KEY_OR_DAMAGED', 'The backup key is wrong, or the file was changed or damaged') : e.message.includes('incorrect header') || (e as { code?: string }).code?.startsWith('Z_') ? new BackupError(encrypted ? 'WRONG_KEY_OR_DAMAGED' : 'DAMAGED', encrypted ? 'The backup key is wrong, or the file was changed or damaged' : 'The backup file is damaged') : e);
    source.on('error', fail);
    gunzip.on('error', fail);
  });
  failed.catch(() => undefined);
  const text = source.pipe(gunzip);
  const hash = createHash('sha256');
  let header: Extract<Line, { t: 'header' }> | null = null;
  let end: Extract<Line, { t: 'end' }> | null = null;
  const counts: Record<string, number> = {};
  const consume = (async () => {
    for await (const raw of splitLines(text)) {
      if (end) throw new BackupError('DAMAGED', 'The backup has data after its end');
      let line: Line;
      try {
        line = BSON.EJSON.parse(raw, { relaxed: false }) as Line;
      } catch {
        throw new BackupError('DAMAGED', 'The backup file is damaged');
      }
      if (line.t === 'end') {
        // Canonical Extended JSON reads numbers back as Int32/Double objects.
        end = { ...line, documents: Number(line.documents), counts: Object.fromEntries(Object.entries(line.counts).map(([k, v]) => [k, Number(v)])) };
        continue;
      }
      hash.update(raw + '\n');
      if (!header) {
        if (line.t !== 'header' || line.format !== FORMAT) throw new BackupError('NOT_A_BACKUP', 'This is not a Talk2Tax backup file');
        if (Number(line.version) > VERSION) throw new BackupError('NOT_A_BACKUP', `This backup was written by a newer Talk2Tax (format ${line.version})`);
        header = { ...line, version: Number(line.version) };
        continue;
      }
      if (line.t === 'doc') counts[line.c] = (counts[line.c] ?? 0) + 1;
      if (line.t === 'collection') counts[line.name] ??= 0;
      await onLine(line);
    }
  })();
  consume.catch(() => undefined);
  await Promise.race([consume, failed]);
  // An encrypted file is only known to be whole once the stream has ended and its tag checked.
  await Promise.race([new Promise<void>((r) => (text.readableEnded ? r() : text.once('end', () => r()))), failed]);
  const h = header as Extract<Line, { t: 'header' }> | null;
  const e = end as Extract<Line, { t: 'end' }> | null;
  if (!h || !e) throw new BackupError('DAMAGED', 'The backup file is cut short');
  if (hash.digest('hex') !== e.sha256) throw new BackupError('DAMAGED', 'The backup does not match its checksum');
  for (const [name, n] of Object.entries(e.counts)) if ((counts[name] ?? 0) !== n) throw new BackupError('DAMAGED', `The backup is missing documents of ${name}`);
  return { header: h, end: e, encrypted, file: { bytes: fileBytes, sha256: fileHash.digest('hex') } };
}

/** Checks a backup file end to end without restoring it, and describes what it holds. */
export async function verifyBackup(path: string, opts: { key?: string } = {}): Promise<BackupManifest> {
  const indexes: Record<string, number> = {};
  const { header, end, encrypted, file } = await readLines(path, opts.key, async (line) => {
    if (line.t === 'collection') indexes[line.name] = line.indexes.length;
  });
  return {
    format: FORMAT,
    version: header.version,
    createdAt: header.createdAt,
    database: header.database,
    encrypted,
    consistent: header.consistent,
    collections: Object.keys(indexes).map((name) => ({ name, documents: end.counts[name] ?? 0, indexes: indexes[name] ?? 0 })),
    documents: end.documents,
    contentSha256: end.sha256,
    bytes: file.bytes,
    fileSha256: file.sha256,
  };
}

/**
 * Restores a backup into `db`, which must hold no collections. The file is checked in full
 * first (key, checksum, counts), so a damaged or altered backup writes nothing. Each collection's
 * count is checked once its documents are in, before its indexes (TTL ones included) are built.
 */
export async function restoreBackup(path: string, db: Db, opts: { key?: string } = {}): Promise<BackupManifest> {
  const existing = (await db.listCollections({}, { nameOnly: true }).toArray()).filter((c) => !c.name.startsWith('system.'));
  if (existing.length) throw new BackupError('TARGET_NOT_EMPTY', `The target database ${db.databaseName} already holds ${existing.length} collection${existing.length === 1 ? '' : 's'}; restore into an empty database`);
  const manifest = await verifyBackup(path, opts);
  let batch: Document[] = [];
  let current: { name: string; indexes: Document[] } | null = null;
  const flush = async () => {
    if (current && batch.length) await db.collection(current.name).insertMany(batch, { ordered: true, bypassDocumentValidation: true });
    batch = [];
  };
  const finish = async () => {
    await flush();
    if (!current) return;
    // Counted before the indexes are built: a TTL index would start deleting expired documents
    // (sign-in challenges, for one) straight away, and the backup holds them as they were.
    const expected = manifest.collections.find((c) => c.name === current!.name)?.documents ?? 0;
    const n = await db.collection(current.name).countDocuments();
    if (n !== expected) throw new BackupError('DAMAGED', `${current.name} has ${n} documents after the restore, not ${expected}`);
    if (current.indexes.length) await db.collection(current.name).createIndexes(current.indexes as never);
  };
  await readLines(path, opts.key, async (line) => {
    if (line.t === 'collection') {
      await finish();
      await db.createCollection(line.name, line.options);
      current = { name: line.name, indexes: line.indexes };
    } else if (line.t === 'doc') {
      batch.push(line.d);
      if (batch.length >= BATCH) await flush();
    }
  });
  await finish();
  return manifest;
}


import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Binary, Decimal128, MongoClient } from 'mongodb';
import { BackupError, restoreBackup, verifyBackup, writeBackup } from '../src';

const URL = process.env.TEST_MONGODB_URL ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const SOURCE = `t2t_backup_src_${process.pid}`;
const TARGET = `t2t_backup_dst_${process.pid}`;
const KEY = 'a-long-backup-passphrase-for-tests';
let client: MongoClient;
let dir: string;

const journal = { _id: 'je-1', orgId: 'org-1', total: Decimal128.fromString('1234567.89'), postedAt: new Date('2026-11-19T10:00:00.000Z'), lines: [{ amount: Decimal128.fromString('0.10') }], attachment: new Binary(Buffer.from([0, 1, 2, 255])), note: null };

beforeAll(async () => {
  client = await MongoClient.connect(URL);
  dir = await fs.mkdtemp(join(tmpdir(), 't2t-backup-'));
  const db = client.db(SOURCE);
  await db.createCollection('journals', { validator: { $jsonSchema: { bsonType: 'object', required: ['orgId'] } } });
  await db.collection('journals').createIndex({ orgId: 1, postedAt: -1 }, { name: 'org_posted' });
  await db.collection('journals').insertMany([journal, ...Array.from({ length: 2500 }, (_, i) => ({ _id: `je-${i + 2}`, orgId: 'org-1', total: Decimal128.fromString(`${i}.01`) }))] as never);
  await db.collection('users').createIndex({ email: 1 }, { name: 'email_unique', unique: true });
  // Short-lived records kept under a TTL index, like sign-in challenges.
  await db.collection('challenges').createIndex({ expiresAt: 1 }, { name: 'expiry', expireAfterSeconds: 0 });
  await db.collection('challenges').insertMany([{ _id: 'c-1', expiresAt: new Date(Date.now() + 3_600_000) }, { _id: 'c-2', expiresAt: new Date(Date.now() + 3_600_000) }] as never);
  await db.collection('users').insertOne({ _id: 'u-1', email: 'a@example.test', name: 'Ānanya Śarmā ₹ 名前'.repeat(3000) } as never);
});
afterAll(async () => {
  await client.db(SOURCE).dropDatabase();
  await client.db(TARGET).dropDatabase();
  await client.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('backups', () => {
  it('writes an encrypted backup and restores every document, rule and index exactly', async () => {
    const file = join(dir, 'sealed.t2tbak');
    const m = await writeBackup(client.db(SOURCE), file, { key: KEY });
    expect(m).toMatchObject({ database: SOURCE, encrypted: true, consistent: true, documents: 2504, collections: [{ name: 'challenges', documents: 2, indexes: 1 }, { name: 'journals', documents: 2501, indexes: 1 }, { name: 'users', documents: 1, indexes: 1 }] });
    const handle = await fs.open(file, 'r');
    try {
      expect((await handle.stat()).mode & 0o777).toBe(0o600);
      // Nothing readable in the file: the account's email is not there in plain text.
      expect((await handle.readFile()).includes(Buffer.from('a@example.test'))).toBe(false);
    } finally {
      await handle.close();
    }
    expect(await verifyBackup(file, { key: KEY })).toEqual(m);

    const restored = await restoreBackup(file, client.db(TARGET), { key: KEY });
    expect(restored.documents).toBe(2504);
    // The TTL index comes back, built after the documents were counted.
    expect((await client.db(TARGET).collection('challenges').indexes()).find((i) => i.name === 'expiry')?.expireAfterSeconds).toBe(0);
    expect(await client.db(TARGET).collection('challenges').countDocuments()).toBe(2);
    const back = await client.db(TARGET).collection('journals').findOne({ _id: 'je-1' as never });
    expect(back).toEqual(journal);
    expect(back!.total).toBeInstanceOf(Decimal128);
    expect(await client.db(TARGET).collection('users').findOne({ _id: 'u-1' as never })).toEqual(await client.db(SOURCE).collection('users').findOne({ _id: 'u-1' as never }));
    expect(await client.db(TARGET).collection('journals').countDocuments()).toBe(2501);
    expect((await client.db(TARGET).collection('journals').indexes()).map((i) => i.name)).toContain('org_posted');
    const users = await client.db(TARGET).collection('users').indexes();
    expect(users.find((i) => i.name === 'email_unique')?.unique).toBe(true);
    const [info] = await client.db(TARGET).listCollections({ name: 'journals' }).toArray();
    expect((info as { options: { validator?: unknown } }).options.validator).toEqual({ $jsonSchema: { bsonType: 'object', required: ['orgId'] } });
    // A second restore into the same database is refused.
    await expect(restoreBackup(file, client.db(TARGET), { key: KEY })).rejects.toMatchObject({ code: 'TARGET_NOT_EMPTY' });
  });

  it('refuses a wrong key, a missing key, and a changed file, before writing anything', async () => {
    const file = join(dir, 'sealed2.t2tbak');
    await writeBackup(client.db(SOURCE), file, { key: KEY });
    await expect(verifyBackup(file)).rejects.toMatchObject({ code: 'KEY_REQUIRED' });
    await expect(verifyBackup(file, { key: 'another-long-passphrase-entirely' })).rejects.toMatchObject({ code: 'WRONG_KEY_OR_DAMAGED' });
    const bytes = await fs.readFile(file);
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    const changed = join(dir, 'changed.t2tbak');
    await fs.writeFile(changed, bytes);
    await expect(verifyBackup(changed, { key: KEY })).rejects.toBeInstanceOf(BackupError);
    const empty = client.db(`${TARGET}_x`);
    await expect(restoreBackup(changed, empty, { key: KEY })).rejects.toBeInstanceOf(BackupError);
    expect(await empty.listCollections().toArray()).toEqual([]);
    await expect(verifyBackup(join(dir, '..', 'nope'), { key: KEY })).rejects.toThrow();
    const notOne = join(dir, 'not-a-backup.txt');
    await fs.writeFile(notOne, 'hello there, this is not a backup');
    await expect(verifyBackup(notOne)).rejects.toMatchObject({ code: 'NOT_A_BACKUP' });
  });

  it('checks an unencrypted backup against its checksum', async () => {
    const file = join(dir, 'plain.t2tbak');
    const m = await writeBackup(client.db(SOURCE), file);
    expect(m.encrypted).toBe(false);
    expect((await verifyBackup(file)).contentSha256).toBe(m.contentSha256);
    const cut = join(dir, 'cut.t2tbak');
    const bytes = await fs.readFile(file);
    await fs.writeFile(cut, bytes.subarray(0, Math.floor(bytes.length * 0.6)));
    await expect(verifyBackup(cut)).rejects.toBeInstanceOf(Error);
  });
});

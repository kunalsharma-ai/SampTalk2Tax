import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Decimal128, MongoClient } from 'mongodb';
import {
  decimalToString,
  defineCollection,
  defineMigration,
  DocumentStore,
  ensureCollection,
  ImmutableDocumentError,
  runMigrations,
  TenantAccessError,
  toDecimal128,
  type AccessContext,
} from '../src';

const URL = process.env.TEST_MONGODB_URL ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = `t2t_docdb_test_${process.pid}`;

interface Account { id: string; orgId: string; code: string; name: string }
interface Line { id: string; orgId: string; accountId: string; debit: string; credit: string; memo?: string }
interface Journal { id: string; orgId: string; status: 'DRAFT' | 'POSTED'; total: string; lines: { accountId: string; amount: string }[] }
interface AuditEvent { id: string; orgId: string; action: string }
interface Plan { id: string; code: string; price: string }

const accounts = defineCollection<Account>({
  name: 'accounts',
  scope: 'tenant',
  schema: { bsonType: 'object', required: ['code', 'name'], properties: { code: { bsonType: 'string' }, name: { bsonType: 'string' } } },
  indexes: [{ key: { orgId: 1, code: 1 }, name: 'org_code', unique: true }],
});
const lines = defineCollection<Line>({ name: 'journal_lines', scope: 'tenant', decimals: ['debit', 'credit'] });
const journals = defineCollection<Journal>({
  name: 'journals',
  scope: 'tenant',
  decimals: ['total', 'lines[].amount'],
  guards: {
    afterUpdate(before, after) {
      if (before.status === 'POSTED') throw new Error('A posted journal cannot be changed');
      if (after.status === 'POSTED' && after.lines.length === 0) throw new Error('A journal needs lines');
    },
    beforeDelete(doc) {
      if (doc.status === 'POSTED') throw new Error('A posted journal cannot be deleted');
    },
  },
});
const audit = defineCollection<AuditEvent>({ name: 'audit_events', scope: 'tenant', appendOnly: true });
const plans = defineCollection<Plan>({ name: 'plans', scope: 'global', decimals: ['price'] });
const ALL = [accounts, lines, journals, audit, plans];

const ctxStore = new AsyncLocalStorage<AccessContext>();
const as = <R>(ctx: AccessContext, fn: () => Promise<R>) => ctxStore.run(ctx, fn);
const ORG_A = 'org-a';
const ORG_B = 'org-b';

let store: DocumentStore;
let raw: MongoClient;

beforeAll(async () => {
  store = new DocumentStore({ url: URL, dbName: DB, collections: ALL, context: () => ctxStore.getStore() ?? {} });
  await store.connect();
  for (const def of ALL) await ensureCollection(store.systemDb(), def);
  raw = new MongoClient(URL);
  await raw.connect();
});

afterAll(async () => {
  await raw.db(DB).dropDatabase();
  await raw.close();
  await store.close();
});

describe('decimals', () => {
  it('prints Decimal128 in positional notation, keeping the scale', () => {
    expect(decimalToString(Decimal128.fromString('1.2E+3'))).toBe('1200');
    expect(decimalToString(Decimal128.fromString('0E-10'))).toBe('0.0000000000');
    expect(decimalToString(Decimal128.fromString('-12345E-2'))).toBe('-123.45');
    expect(decimalToString(Decimal128.fromString('5E-3'))).toBe('0.005');
    expect(decimalToString(Decimal128.fromString('1250.50'))).toBe('1250.50');
    expect(decimalToString(Decimal128.fromString('-0E-2'))).toBe('0.00');
  });

  it('refuses numbers and malformed strings for money', () => {
    expect(() => toDecimal128(10.5)).toThrow(/numbers are refused/);
    expect(() => toDecimal128('1e3')).toThrow();
    expect(() => toDecimal128('12.')).toThrow();
    expect(() => toDecimal128(Decimal128.fromString('NaN'))).toThrow();
  });

  it('stores Decimal128, filters and sums exactly, and returns strings', async () => {
    await as({ orgId: ORG_A }, async () => {
      const c = store.collection(lines);
      await c.insertMany([
        { orgId: ORG_A, accountId: 'x', debit: '0.10', credit: '0' },
        { orgId: ORG_A, accountId: 'x', debit: '0.20', credit: '0' },
        { orgId: ORG_A, accountId: 'x', debit: '30.45', credit: '0' },
      ] as never);
      const stored = await raw.db(DB).collection('journal_lines').findOne({ orgId: ORG_A });
      expect(stored?.debit).toBeInstanceOf(Decimal128);
      expect((await c.find({ debit: { $gt: '0.15' } })).map((l) => l.debit).sort()).toEqual(['0.20', '30.45']);
      expect(await c.count({ debit: '0.10' })).toBe(1);
      const [sum] = await c.aggregate<{ total: string }>([{ $group: { _id: null, total: { $sum: '$debit' } } }]);
      expect(sum.total).toBe('30.75'); // not 30.750000000000004
      await expect(c.insertOne({ accountId: 'x', debit: 1.5 as never, credit: '0' })).rejects.toThrow(/numbers are refused/);
      await c.updateMany({ debit: '0.10' }, { $inc: { debit: '0.05' } });
      expect(await c.count({ debit: '0.15' })).toBe(1);
    });
  });

  it('encodes decimals inside arrays on insert and update', async () => {
    await as({ orgId: ORG_A }, async () => {
      const c = store.collection(journals);
      const j = await c.insertOne({ status: 'DRAFT', total: '100.00', lines: [{ accountId: 'a', amount: '60.00' }, { accountId: 'b', amount: '40.00' }] } as never);
      expect(j.lines[0].amount).toBe('60.00');
      await c.updateOne({ id: j.id }, { $set: { 'lines.1.amount': '45.50' } });
      await c.updateOne({ id: j.id }, { $push: { lines: { accountId: 'c', amount: '1.25' } } });
      const after = await c.findById(j.id);
      expect(after?.lines.map((l) => l.amount)).toEqual(['60.00', '45.50', '1.25']);
      const stored = await raw.db(DB).collection('journals').findOne({ _id: j.id as never });
      expect(stored?.lines[2].amount).toBeInstanceOf(Decimal128);
    });
  });

  it('the validator refuses a double in a decimal field even from raw writes', async () => {
    await expect(raw.db(DB).collection('plans').insertOne({ code: 'X', price: 9.99 })).rejects.toThrow(/validation/i);
  });
});

describe('tenant isolation', () => {
  it('keeps each organisation to its own documents', async () => {
    const a = await as({ orgId: ORG_A }, () => store.collection(accounts).insertOne({ code: '1000', name: 'Cash A' } as never));
    await as({ orgId: ORG_B }, () => store.collection(accounts).insertOne({ code: '1000', name: 'Cash B' } as never));
    expect(a.orgId).toBe(ORG_A);

    await as({ orgId: ORG_B }, async () => {
      const c = store.collection(accounts);
      expect((await c.find({ code: '1000' })).map((x) => x.name)).toEqual(['Cash B']);
      expect(await c.findById(a.id)).toBeNull();
      // Naming another org in the filter does not widen the scope.
      expect(await c.find({ orgId: ORG_A })).toEqual([]);
      expect(await c.find({ $or: [{ orgId: ORG_A }, { code: '1000' }] })).toHaveLength(1);
      expect((await c.updateOne({ id: a.id }, { $set: { name: 'hacked' } })).matched).toBe(0);
      expect(await c.deleteMany({})).toBe(1); // only its own
      expect(await c.distinct('name')).toEqual([]);
    });
    expect((await as({ orgId: ORG_A }, () => store.collection(accounts).findById(a.id)))?.name).toBe('Cash A');
  });

  it('refuses tenant work without an organisation, and writes for another organisation', async () => {
    await expect(as({}, () => store.collection(accounts).find())).rejects.toBeInstanceOf(TenantAccessError);
    await expect(store.collection(accounts).count()).rejects.toBeInstanceOf(TenantAccessError);
    await expect(as({}, () => store.collection(accounts).insertOne({ code: '2', name: 'n' } as never))).rejects.toBeInstanceOf(TenantAccessError);
    await expect(
      as({ orgId: ORG_A }, () => store.collection(accounts).insertOne({ orgId: ORG_B, code: '3', name: 'n' } as never)),
    ).rejects.toThrow(/another organisation/);
    await expect(
      as({ orgId: ORG_A }, () => store.collection(accounts).updateMany({}, { $set: { orgId: ORG_B } })),
    ).rejects.toThrow(/cannot be changed/);
    await expect(as({ orgId: ORG_A }, () => store.collection(accounts).updateMany({}, { $rename: { name: 'orgId' } }))).rejects.toThrow(/cannot be changed/);
    // Global collections need no organisation.
    await as({}, () => store.collection(plans).insertOne({ code: 'STARTER', price: '999.00' } as never));
    expect((await store.collection(plans).findOne({ code: 'STARTER' }))?.price).toBe('999.00');
  });

  it('system bypass sees every organisation but must name one when inserting', async () => {
    await as({ orgId: ORG_A }, () => store.collection(accounts).insertOne({ code: '1100', name: 'Bank A' } as never));
    await as({ orgId: ORG_B }, () => store.collection(accounts).insertOne({ code: '1100', name: 'Bank B' } as never));
    await as({ bypass: true }, async () => {
      expect(await store.collection(accounts).count({ code: '1100' })).toBe(2);
      await expect(store.collection(accounts).insertOne({ code: '9', name: 'n' } as never)).rejects.toThrow(/must name orgId/);
    });
  });

  it('a unique index is per organisation', async () => {
    await as({ orgId: ORG_A }, async () => {
      await store.collection(accounts).insertOne({ code: '4000', name: 'Sales' } as never);
      await expect(store.collection(accounts).insertOne({ code: '4000', name: 'Sales again' } as never)).rejects.toThrow(/duplicate key/);
    });
    await as({ orgId: ORG_B }, () => store.collection(accounts).insertOne({ code: '4000', name: 'Sales B' } as never));
  });

  it('scopes $lookup, $unionWith and $facet to the organisation', async () => {
    const accA = await as({ orgId: ORG_A }, () => store.collection(accounts).insertOne({ code: '5000', name: 'Rent A' } as never));
    // Org B line that points at org A's account id: the join must not reach across.
    await as({ orgId: ORG_B }, () => store.collection(lines).insertOne({ accountId: accA.id, debit: '7.00', credit: '0', memo: 'b-line' } as never));
    await as({ orgId: ORG_A }, () => store.collection(lines).insertOne({ accountId: accA.id, debit: '9.00', credit: '0', memo: 'a-line' } as never));

    const rows = await as({ orgId: ORG_B }, () =>
      store.collection(lines).aggregate<{ memo: string; account: unknown[] }>([
        { $match: { memo: 'b-line' } },
        { $lookup: { from: 'accounts', localField: 'accountId', foreignField: '_id', as: 'account' } },
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].account).toEqual([]);

    const own = await as({ orgId: ORG_A }, () =>
      store.collection(lines).aggregate<{ account: { name: string }[] }>([
        { $match: { memo: 'a-line' } },
        { $lookup: { from: 'accounts', localField: 'accountId', foreignField: '_id', as: 'account' } },
      ]),
    );
    expect(own[0].account.map((a) => a.name)).toEqual(['Rent A']);

    const union = await as({ orgId: ORG_B }, () =>
      store.collection(accounts).aggregate<{ name: string }>([{ $match: { code: '5000' } }, { $unionWith: 'accounts' }, { $project: { name: 1 } }]),
    );
    expect(union.map((u) => u.name)).not.toContain('Rent A');

    const facet = await as({ orgId: ORG_B }, () =>
      store.collection(lines).aggregate<{ joined: { account: unknown[] }[] }>([
        { $match: { memo: 'b-line' } },
        { $facet: { joined: [{ $lookup: { from: 'accounts', localField: 'accountId', foreignField: '_id', as: 'account' } }] } },
      ]),
    );
    expect(facet[0].joined[0].account).toEqual([]);

    await expect(as({ orgId: ORG_A }, () => store.collection(lines).aggregate([{ $out: 'stolen' }]))).rejects.toThrow(/not allowed/);
    await expect(as({ orgId: ORG_A }, () => store.collection(lines).aggregate([{ $lookup: { from: 'users', localField: 'a', foreignField: 'b', as: 'u' } }]))).rejects.toThrow(/unknown collection/);
  });
});

describe('transactions and guards', () => {
  it('undoes every write when the transaction fails', async () => {
    await as({ orgId: ORG_A }, async () => {
      await expect(
        store.transaction(async () => {
          await store.collection(accounts).insertOne({ code: '6000', name: 'Wages' } as never);
          await store.collection(lines).insertOne({ accountId: 'w', debit: '1.00', credit: '0', memo: 'tx' } as never);
          throw new Error('posting failed');
        }),
      ).rejects.toThrow('posting failed');
      expect(await store.collection(accounts).count({ code: '6000' })).toBe(0);
      expect(await store.collection(lines).count({ memo: 'tx' })).toBe(0);
    });
  });

  it('commits nested transactions as one', async () => {
    await as({ orgId: ORG_A }, async () => {
      await store.transaction(async () => {
        await store.collection(accounts).insertOne({ code: '6100', name: 'Outer' } as never);
        await store.transaction(async () => {
          expect(store.inTransaction()).toBe(true);
          await store.collection(accounts).insertOne({ code: '6101', name: 'Inner' } as never);
        });
      });
      expect(await store.collection(accounts).count({ code: { $in: ['6100', '6101'] } })).toBe(2);
    });
  });

  it('a guard that throws undoes the update and the rest of the transaction', async () => {
    await as({ orgId: ORG_A }, async () => {
      const c = store.collection(journals);
      const j = await c.insertOne({ status: 'DRAFT', total: '10.00', lines: [{ accountId: 'a', amount: '10.00' }] } as never);
      await c.updateOne({ id: j.id }, { $set: { status: 'POSTED' } });
      await expect(
        store.transaction(async () => {
          await store.collection(accounts).insertOne({ code: '7000', name: 'Should vanish' } as never);
          await c.updateOne({ id: j.id }, { $set: { total: '99.00' } });
        }),
      ).rejects.toThrow(/posted journal cannot be changed/);
      expect((await c.findById(j.id))?.total).toBe('10.00');
      expect(await store.collection(accounts).count({ code: '7000' })).toBe(0);
      await expect(c.deleteOne({ id: j.id })).rejects.toThrow(/cannot be deleted/);
      const empty = await c.insertOne({ status: 'DRAFT', total: '0', lines: [] } as never);
      await expect(c.findOneAndUpdate({ id: empty.id }, { $set: { status: 'POSTED' } })).rejects.toThrow(/needs lines/);
      expect((await c.findById(empty.id))?.status).toBe('DRAFT');
    });
  });

  it('append-only collections refuse updates and deletes', async () => {
    await as({ orgId: ORG_A }, async () => {
      const c = store.collection(audit);
      await c.insertOne({ action: 'journal.posted' } as never);
      await expect(c.updateMany({}, { $set: { action: 'x' } })).rejects.toBeInstanceOf(ImmutableDocumentError);
      await expect(c.deleteMany({})).rejects.toBeInstanceOf(ImmutableDocumentError);
    });
  });

  it('per-organisation sequences never hand out the same number twice', async () => {
    const values = await as({ orgId: ORG_A }, () => Promise.all(Array.from({ length: 25 }, () => store.nextTenantSequence('invoice'))));
    expect(new Set(values).size).toBe(25);
    expect(Math.max(...values)).toBe(25);
    expect(await as({ orgId: ORG_B }, () => store.nextTenantSequence('invoice'))).toBe(1);
  });
});

describe('migrations', () => {
  it('applies each migration once and refuses edited or unknown ones', async () => {
    const db = raw.db(`${DB}_m`);
    const calls: string[] = [];
    const first = defineMigration({ id: '20261109090000_first', up: async (d) => { calls.push('first'); await d.collection('things').insertOne({ n: 1 }); } });
    const second = defineMigration({ id: '20261109090100_second', up: async () => { calls.push('second'); } });
    expect((await runMigrations(db, [second, first])).applied).toEqual(['20261109090000_first', '20261109090100_second']);
    expect((await runMigrations(db, [first, second])).applied).toEqual([]);
    expect(calls).toEqual(['first', 'second']);

    const edited = defineMigration({ id: '20261109090000_first', up: async () => { calls.push('edited'); } });
    await expect(runMigrations(db, [edited, second])).rejects.toThrow(/changed after it was applied/);
    await expect(runMigrations(db, [first])).rejects.toThrow(/does not know about/);
    // The lock is released after a failure.
    expect((await runMigrations(db, [first, second])).applied).toEqual([]);
    await db.dropDatabase();
  });

  it('refuses to run while another process holds the lock', async () => {
    const db = raw.db(`${DB}_lock`);
    await db.collection('_locks').insertOne({ _id: 'migrations' as never, until: new Date(Date.now() + 60_000) });
    await expect(runMigrations(db, [])).rejects.toThrow(/Another process/);
    await db.dropDatabase();
  });
});

describe('validators', () => {
  it('refuse doubles in nested decimal paths and missing orgId', async () => {
    const db = raw.db(DB);
    await expect(db.collection('journals').insertOne({ orgId: 'o', status: 'DRAFT', total: Decimal128.fromString('1'), lines: [{ accountId: 'a', amount: 1 }] })).rejects.toThrow(/validation/i);
    await expect(db.collection('accounts').insertOne({ code: '1', name: 'no org' })).rejects.toThrow(/validation/i);
    await expect(
      as({ orgId: ORG_A }, async () => {
        const j = await store.collection(journals).insertOne({ status: 'DRAFT', total: '1.00', lines: [] } as never);
        await store.collection(journals).updateOne({ id: j.id }, { $push: { lines: { $each: [{ accountId: 'x', amount: '2.00' }] } } });
        return (await store.collection(journals).findById(j.id))?.lines[0].amount;
      }),
    ).resolves.toBe('2.00');
  });
});

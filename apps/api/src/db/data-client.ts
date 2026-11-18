import { isTransientTransactionError } from '@talk2tax/document-db';
import { currentTenantContext, tenantStorage } from '../common/tenant-context';
import type { DocumentStoreService } from '../common/document-store.service';
import { hasAutoincrement, useAutoincrement } from './mongo-writes';
import { mongoReadOps } from './mongo-reads';
import { mirrorByDelegate, mongoOnlyOps, nextSerial, oneAtATime, readableByDelegate, type MirrorInfo, type Ops } from './mirror-writes';

/**
 * The application's database client, on MongoDB alone (docs/MONGODB.md › The data client).
 * It answers the model API the services were written against (`client.invoice.findMany`,
 * `client.$transaction(fn)`): every model's reads and writes run on its MongoDB collection,
 * with the guards, checks, references and unique keys of db/mirror-writes.ts, and a
 * transaction is a MongoDB transaction.
 */

type Store = DocumentStoreService;
type Delegate = Record<string, (args?: Record<string, unknown>) => Promise<unknown>>;

const STORE = Symbol.for('talk2tax.documentStore');
/** Runs of a transaction callback before a MongoDB write conflict is given up on. */
const MAX_ATTEMPTS = 40;
const WRITES = new Set(['create', 'update', 'upsert', 'delete', 'createMany', 'createManyAndReturn', 'updateMany', 'updateManyAndReturn', 'deleteMany']);

const noSql = (prop: string) => () => Promise.reject(new Error(`${prop}: there is no SQL database; use the model API`));

function infoOf(name: string): MirrorInfo | undefined {
  return mirrorByDelegate().get(name) ?? readableByDelegate().get(name);
}

/** One model's operations: reads, and writes unless its records live inside a parent's. */
function modelOps(info: MirrorInfo, store: Store): Ops {
  const reads = mongoReadOps(info, store) as unknown as Ops;
  if (info.embedded) {
    const parent = info.embedded.parent.name;
    const writes = Object.fromEntries([...WRITES].map((op) => [op, () => Promise.reject(new Error(`${info.model} is written with its ${parent} record`))]));
    return { ...reads, ...writes };
  }
  return { ...reads, ...mongoOnlyOps(info, store, reads) };
}

/**
 * A client inside a transaction: MongoDB refuses two operations at once in one transaction,
 * so they run one after another, in the order they were issued.
 */
function txClient(store: Store): object {
  const serial = oneAtATime();
  const cache = new Map<string, Delegate>();
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === STORE) return store;
        if (prop === 'then') return undefined;
        if (typeof prop !== 'string') return undefined;
        if (prop.startsWith('$queryRaw') || prop.startsWith('$executeRaw')) return noSql(prop);
        if (prop === '$transaction') return () => Promise.reject(new Error('A transaction cannot start another'));
        const info = infoOf(prop);
        if (!info) return undefined;
        if (!cache.has(prop)) {
          const ops = modelOps(info, store);
          cache.set(prop, new Proxy({}, { get: (_x, op) => (typeof op === 'string' && op in ops ? (args?: Record<string, unknown>) => serial(() => ops[op](args ?? {})) : undefined) }) as Delegate);
        }
        return cache.get(prop);
      },
    },
  );
}

/** Creates the client. Writes outside a transaction run in one of their own. */
export function createDataClient(store: Store): object {
  if (!hasAutoincrement()) useAutoincrement((model, field) => nextSerial(store as never, model, field));

  const transaction = async (fn: unknown) => {
    if (typeof fn !== 'function') throw new Error('Batch transactions are not supported; use an interactive transaction');
    const ctx = currentTenantContext();
    for (let attempt = 1; ; attempt++) {
      const held = store.hold();
      let result: unknown;
      try {
        result = await held.run(() => tenantStorage.run({ ...ctx, inTx: true }, async () => await (fn as (tx: object) => Promise<unknown>)(txClient(store))));
        await held.commit();
        return result;
      } catch (e) {
        await held.abort().catch(() => undefined);
        // Concurrent postings meet on the same counter or lock document; each conflict waits a
        // little (growing, with jitter) and runs again, as MongoDB's own retry loop does.
        if (attempt < MAX_ATTEMPTS && isTransientTransactionError(e)) {
          await new Promise((r) => setTimeout(r, Math.random() * Math.min(5 * 2 ** attempt, 200)));
          continue;
        }
        throw e;
      }
    }
  };

  const cache = new Map<string, Delegate>();
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === STORE) return store;
        if (prop === 'then') return undefined;
        if (typeof prop !== 'string') return undefined;
        if (prop === '$transaction') return transaction;
        if (prop === '$connect' || prop === '$disconnect' || prop === 'onModuleInit' || prop === 'onModuleDestroy') return () => Promise.resolve();
        if (prop.startsWith('$queryRaw') || prop.startsWith('$executeRaw')) return noSql(prop);
        const info = infoOf(prop);
        if (!info) return undefined;
        if (!cache.has(prop)) {
          const ops = modelOps(info, store);
          cache.set(
            prop,
            new Proxy({}, {
              get: (_x, op) => {
                if (typeof op !== 'string' || !(op in ops)) return undefined;
                if (WRITES.has(op)) return (args?: Record<string, unknown>) => transaction((tx: object) => (tx as Record<string, Delegate>)[prop][op](args));
                return (args?: Record<string, unknown>) => ops[op](args ?? {});
              },
            }) as Delegate,
          );
        }
        return cache.get(prop);
      },
    },
  );
}

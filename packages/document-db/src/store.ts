import { AsyncLocalStorage } from 'node:async_hooks';
import { MongoClient, type ClientSession, type Collection, type Db, type Document, type TransactionOptions } from 'mongodb';
import type { AnyCollectionDef, CollectionDef } from './collection';
import { nextSequenceValue } from './migrations';
import { ScopedCollection, type AccessContext, type StoreRuntime } from './scoped-collection';

export interface DocumentStoreOptions {
  /** mongodb://… connection string. The deployment must be a replica set (transactions). */
  url: string;
  /** Database name; defaults to the one in the URL. */
  dbName?: string;
  /** Every collection the application uses. Unknown names are refused everywhere. */
  collections: readonly AnyCollectionDef[];
  /** Who is asking: the API passes its request tenant context. */
  context: () => AccessContext;
}

const TRANSACTION_OPTIONS: TransactionOptions = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
  readPreference: 'primary',
};

/**
 * The MongoDB connection plus the registry of collections. Application code gets a
 * ScopedCollection from `collection(def)`; there is no way to reach a raw collection
 * except `systemDb()`, which only migrations and the store's own tests use.
 */
export class DocumentStore {
  private readonly client: MongoClient;
  private readonly sessions = new AsyncLocalStorage<ClientSession>();
  private readonly defs = new Map<string, AnyCollectionDef>();
  private dbHandle?: Db;

  constructor(private readonly options: DocumentStoreOptions) {
    for (const def of options.collections) {
      if (this.defs.has(def.name)) throw new Error(`Collection ${def.name} is defined twice`);
      this.defs.set(def.name, def);
    }
    this.client = new MongoClient(options.url, { ignoreUndefined: true });
  }

  /** Connects and refuses to run on a server that cannot do multi-document transactions. */
  async connect(): Promise<void> {
    await this.client.connect();
    this.dbHandle = this.client.db(this.options.dbName);
    const hello = await this.dbHandle.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') {
      await this.client.close();
      throw new Error(
        'MongoDB is running as a standalone server. Talk2Tax needs a replica set (one node is enough) for transactions: start mongod with --replSet and run rs.initiate().',
      );
    }
  }

  /** Round trip to the server (health checks). */
  async ping(): Promise<void> {
    await this.db().command({ ping: 1 });
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  collection<T extends Document>(def: CollectionDef<T>): ScopedCollection<T> {
    if (this.defs.get(def.name) !== (def as AnyCollectionDef)) throw new Error(`Collection ${def.name} is not registered with this store`);
    return new ScopedCollection(def, this.runtime);
  }

  /**
   * Runs fn in one multi-document transaction. Every ScopedCollection call inside it, at any
   * depth, joins the transaction. Nested calls join the outer transaction. The driver retries
   * fn on transient errors, so fn must not have side effects outside the database (send
   * emails after the transaction returns).
   */
  async transaction<R>(fn: () => Promise<R>): Promise<R> {
    if (this.sessions.getStore()?.inTransaction()) return fn();
    const session = this.client.startSession();
    try {
      let result: R | undefined;
      await session.withTransaction(async () => {
        result = await this.sessions.run(session, fn);
      }, TRANSACTION_OPTIONS);
      return result as R;
    } finally {
      await session.endSession();
    }
  }

  /** Next value of a global counter, inside the current transaction if there is one. */
  async nextSequence(name: string): Promise<number> {
    return nextSequenceValue(this.db(), name, this.sessions.getStore());
  }

  /** Next value of a counter kept per organisation (document numbers and the like). */
  async nextTenantSequence(name: string): Promise<number> {
    const { orgId } = this.options.context();
    if (!orgId) throw new Error(`No organisation in context for sequence ${name}`);
    return nextSequenceValue(this.db(), `${orgId}:${name}`, this.sessions.getStore());
  }

  inTransaction(): boolean {
    return this.sessions.getStore()?.inTransaction() ?? false;
  }

  /** Raw database handle for migrations and maintenance. Not for request-driven work. */
  systemDb(): Db {
    return this.db();
  }

  definitions(): AnyCollectionDef[] {
    return [...this.defs.values()];
  }

  private db(): Db {
    if (!this.dbHandle) throw new Error('DocumentStore is not connected');
    return this.dbHandle;
  }

  private readonly runtime: StoreRuntime = {
    raw: (name: string): Collection<Document> => this.db().collection(name),
    definition: (name: string) => this.defs.get(name),
    context: () => this.options.context(),
    session: () => this.sessions.getStore(),
    transaction: (fn) => this.transaction(fn),
    scoped: (def) => this.collection(def),
  };
}

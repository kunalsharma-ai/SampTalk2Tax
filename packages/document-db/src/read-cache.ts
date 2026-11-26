import type { ChangeStream, CommandStartedEvent, CommandSucceededEvent, Db, Document, MongoClient } from 'mongodb';

/**
 * A cache for small reads every request makes (who is a member, the organisation's settings, its
 * plan), kept correct by MongoDB itself rather than by a timer (PERF-010):
 *
 *   - every write this process sends to a watched collection empties the entries that depend on
 *     it, once when the write succeeds and again when its transaction commits;
 *   - a change stream on the watched collections does the same for writes made by other
 *     processes, a few milliseconds after they commit;
 *   - while the change stream is not running (starting, or after an error), nothing is cached
 *     and every read goes to the database;
 *   - an entry read while a collection it depends on changed is not kept.
 *
 * Reads inside a transaction never use the cache: they must see the transaction's own writes.
 */
export interface ReadCacheOptions {
  /** Collections whose documents may be cached. */
  collections: readonly string[];
  /** The longest an entry is kept even without any change (a safety net). */
  maxAgeMs?: number;
  /** The most entries kept; the oldest go first. */
  maxEntries?: number;
}

interface Entry {
  value: unknown;
  deps: readonly string[];
  at: number;
}

const WRITES = new Set(['insert', 'update', 'delete', 'findAndModify']);

export class ReadCache {
  private readonly watched: Set<string>;
  private readonly entries = new Map<string, Entry>();
  /** Bumped on every change to a collection, so a read that overlapped a change is not kept. */
  private readonly generation = new Map<string, number>();
  /** The collection each write in flight touches, by request id. */
  private readonly inFlight = new Map<number, string>();
  /** Collections written in each open transaction, by session id. */
  private readonly inTransaction = new Map<string, Set<string>>();
  /** Commits and aborts in flight, by request id. */
  private readonly ending = new Map<number, { lsid: string; committed: boolean }>();
  private stream?: ChangeStream;
  private live = false;
  private stopped = false;
  private retry?: NodeJS.Timeout;
  private readonly maxAgeMs: number;
  private readonly maxEntries: number;
  /** Counts for tests and the operations page. */
  readonly stats = { hits: 0, misses: 0, invalidations: 0, restarts: 0 };

  constructor(
    private readonly client: MongoClient,
    private readonly db: () => Db,
    options: ReadCacheOptions,
  ) {
    this.watched = new Set(options.collections);
    this.maxAgeMs = options.maxAgeMs ?? 5 * 60_000;
    this.maxEntries = options.maxEntries ?? 10_000;
    client.on('commandStarted', (e: CommandStartedEvent) => this.started(e));
    client.on('commandSucceeded', (e: CommandSucceededEvent) => this.succeeded(e));
    client.on('commandFailed', (e: { requestId: number; commandName: string }) => {
      this.inFlight.delete(e.requestId);
      // A failed commit may still have committed (the driver retries it); empty to be safe.
      const end = this.ending.get(e.requestId);
      if (end) {
        this.ending.delete(e.requestId);
        this.transactionEnded(end.lsid, true);
      }
    });
  }

  /** True while the change stream runs, so entries are kept. */
  get isLive(): boolean {
    return this.live;
  }

  /** Starts watching other processes' writes; entries are kept once the stream is open. */
  start(): void {
    this.stopped = false;
    this.open();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.live = false;
    if (this.retry) clearTimeout(this.retry);
    this.entries.clear();
    await this.stream?.close().catch(() => undefined);
    this.stream = undefined;
  }

  /**
   * The value under `key`, read with `load` when it is not cached. `deps` names every collection
   * `load` reads, so a change to any of them empties the entry. `inTransaction` is whether the
   * caller is inside a transaction, where the cache is never used.
   */
  async get<T>(key: string, deps: readonly string[], load: () => Promise<T>, inTransaction = false): Promise<T> {
    if (!this.live || inTransaction || deps.some((d) => !this.watched.has(d))) return load();
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < this.maxAgeMs) {
      this.stats.hits++;
      return structuredClone(hit.value) as T;
    }
    this.stats.misses++;
    const before = deps.map((d) => this.generation.get(d) ?? 0);
    const value = await load();
    // Kept only when nothing it depends on changed while it was read, and the stream still runs.
    if (this.live && deps.every((d, i) => (this.generation.get(d) ?? 0) === before[i])) {
      this.entries.delete(key);
      this.entries.set(key, { value: structuredClone(value), deps, at: Date.now() });
      if (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    }
    return value;
  }

  /** Empties every entry that depends on `collection`. */
  invalidate(collection: string): void {
    if (!this.watched.has(collection)) return;
    this.stats.invalidations++;
    this.generation.set(collection, (this.generation.get(collection) ?? 0) + 1);
    for (const [k, e] of this.entries) if (e.deps.includes(collection)) this.entries.delete(k);
  }

  clear(): void {
    for (const c of this.watched) this.generation.set(c, (this.generation.get(c) ?? 0) + 1);
    this.entries.clear();
  }

  // ---------------------------------------------------------------- this process's writes

  private started(e: CommandStartedEvent): void {
    if (e.commandName === 'commitTransaction' || e.commandName === 'abortTransaction') {
      const lsid = sessionId(e.command as Document);
      if (lsid && this.inTransaction.has(lsid)) this.ending.set(e.requestId, { lsid, committed: e.commandName === 'commitTransaction' });
      return;
    }
    if (!WRITES.has(e.commandName)) return;
    const coll = (e.command as Document)[e.commandName];
    if (typeof coll !== 'string' || !this.watched.has(coll)) return;
    this.inFlight.set(e.requestId, coll);
    const lsid = sessionId(e.command as Document);
    if (lsid && (e.command as Document).autocommit === false) {
      // A session that never commits nor aborts (a crash mid-transaction) must not grow this for ever.
      if (this.inTransaction.size > 10_000) this.inTransaction.clear();
      const set = this.inTransaction.get(lsid) ?? new Set<string>();
      set.add(coll);
      this.inTransaction.set(lsid, set);
    }
  }

  private succeeded(e: CommandSucceededEvent): void {
    const coll = this.inFlight.get(e.requestId);
    if (coll !== undefined) {
      this.inFlight.delete(e.requestId);
      this.invalidate(coll);
      return;
    }
    const end = this.ending.get(e.requestId);
    if (end) {
      this.ending.delete(e.requestId);
      this.transactionEnded(end.lsid, end.committed);
    }
  }

  private transactionEnded(lsid: string, committed: boolean): void {
    const set = this.inTransaction.get(lsid);
    if (!set) return;
    this.inTransaction.delete(lsid);
    if (committed) for (const c of set) this.invalidate(c);
  }

  // ---------------------------------------------------------------- other processes' writes

  private open(): void {
    if (this.stopped) return;
    let stream: ChangeStream;
    try {
      stream = this.db().watch([{ $match: { 'ns.coll': { $in: [...this.watched] } } }], { maxAwaitTimeMS: 500 });
    } catch {
      this.again();
      return;
    }
    this.stream = stream;
    void this.follow(stream);
  }

  /** Reads the change stream until it fails or the cache stops. */
  private async follow(stream: ChangeStream): Promise<void> {
    try {
      while (!this.stopped && this.stream === stream) {
        // A server wait of up to maxAwaitTimeMS; a change comes back as soon as it is committed.
        const c = (await stream.tryNext()) as Document | null;
        if (!this.live) {
          // Open now; whatever happened before is not cached, so nothing can be stale.
          this.clear();
          this.live = true;
        }
        if (!c) continue;
        const coll = (c.ns as { coll?: string } | undefined)?.coll;
        if (coll) this.invalidate(coll);
        else this.clear(); // a drop or rename of the database: start again
      }
    } catch {
      if (this.stream !== stream) return;
      this.live = false;
      this.clear();
      this.stream = undefined;
      await stream.close().catch(() => undefined);
      this.stats.restarts++;
      this.again();
    }
  }

  private again(): void {
    this.live = false;
    if (this.stopped) return;
    this.retry = setTimeout(() => this.open(), 1_000);
    this.retry.unref?.();
  }
}

/** The session id of a command, as text. */
export function sessionId(command: Document): string | undefined {
  const id = (command.lsid as { id?: { toString(enc?: string): string } } | undefined)?.id;
  if (!id) return undefined;
  const raw = id as unknown as { buffer?: Uint8Array; toString(enc?: string): string };
  return raw.buffer ? Buffer.from(raw.buffer).toString('hex') : String(id.toString('hex'));
}

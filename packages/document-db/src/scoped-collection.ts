import { randomUUID } from 'node:crypto';
import type { AggregateOptions, ClientSession, Collection, Document, Filter } from 'mongodb';
import { encodeDocument, encodeFilter, encodeKeyed, TENANT_FIELD, type AnyCollectionDef, type CollectionDef, type GuardContext } from './collection';
import { decodeDecimals } from './decimal';

/**
 * Who is asking. Mirrors the API's tenant context: an organisation once membership is
 * checked, or `bypass` for system work that must cross tenants.
 */
export interface AccessContext {
  orgId?: string;
  bypass?: boolean;
}

export class TenantAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantAccessError';
  }
}

export class ImmutableDocumentError extends Error {
  constructor(collection: string, action: string) {
    super(`${collection} is append-only: ${action} is not allowed`);
    this.name = 'ImmutableDocumentError';
  }
}

/** What a ScopedCollection needs from its store. */
export interface StoreRuntime {
  raw(name: string): Collection<Document>;
  definition(name: string): AnyCollectionDef | undefined;
  context(): AccessContext;
  session(): ClientSession | undefined;
  transaction<R>(fn: () => Promise<R>): Promise<R>;
  scoped<U extends Document>(def: CollectionDef<U>): ScopedCollection<U>;
}

/** Documents as the application sees them: `id` instead of `_id`, decimals as strings. */
export type WithId<T> = T & { id: string };

/** What an insert takes: `id` and `orgId` are filled in when left out. */
export type InsertDoc<T> = Omit<T, 'id' | 'orgId'> & { id?: string; orgId?: string };

export interface FindOptions {
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
  projection?: Record<string, 0 | 1>;
}

export interface UpdateResult {
  matched: number;
  modified: number;
}

const FORBIDDEN_STAGES = new Set(['$out', '$merge', '$currentOp', '$listSessions', '$listLocalSessions']);
const PROTECTED_FIELDS = new Set(['_id', 'id', TENANT_FIELD]);
const UPDATE_OPERATORS_WITH_FIELDS = ['$set', '$setOnInsert', '$inc', '$mul', '$min', '$max', '$unset', '$rename', '$push', '$addToSet', '$pull', '$pullAll', '$pop', '$currentDate'];

/**
 * The only way application code touches a collection. For tenant collections every read,
 * write and aggregation is limited to the caller's organisation; outside an organisation
 * (and without bypass) every call is refused, so a missing context fails closed. Every call
 * joins the transaction started with DocumentStore.transaction, if there is one.
 */
export class ScopedCollection<T extends Document> {
  constructor(
    private readonly def: CollectionDef<T>,
    private readonly rt: StoreRuntime,
  ) {}

  get name(): string {
    return this.def.name;
  }

  // ---------------------------------------------------------------- reads

  async find(filter: Filter<Document> = {}, options: FindOptions = {}): Promise<WithId<T>[]> {
    const cursor = this.coll().find(this.filter(filter), {
      session: this.rt.session(),
      sort: options.sort ? mapIdKeys(options.sort) : undefined,
      limit: options.limit,
      skip: options.skip,
      projection: options.projection ? mapIdKeys(options.projection) : undefined,
    });
    return (await cursor.toArray()).map((d) => fromStored<T>(d));
  }

  async findOne(filter: Filter<Document> = {}, options: Omit<FindOptions, 'limit'> = {}): Promise<WithId<T> | null> {
    const [doc] = await this.find(filter, { ...options, limit: 1 });
    return doc ?? null;
  }

  async findById(id: string): Promise<WithId<T> | null> {
    return this.findOne({ id });
  }

  async count(filter: Filter<Document> = {}): Promise<number> {
    return this.coll().countDocuments(this.filter(filter), { session: this.rt.session() });
  }

  async exists(filter: Filter<Document>): Promise<boolean> {
    return (await this.coll().findOne(this.filter(filter), { session: this.rt.session(), projection: { _id: 1 } })) !== null;
  }

  async distinct<V = unknown>(field: string, filter: Filter<Document> = {}): Promise<V[]> {
    const values = await this.coll().distinct(field === 'id' ? '_id' : field, this.filter(filter), { session: this.rt.session() });
    return decodeDecimals(values) as V[];
  }

  /**
   * Runs an aggregation. A tenant scope $match is put first, and every $lookup, $unionWith
   * and $graphLookup into a tenant collection is limited to the same organisation.
   * Pipelines use MongoDB's own `_id`; decimals in the output come back as strings.
   */
  async aggregate<R = Document>(pipeline: Document[], options: Omit<AggregateOptions, 'session'> = {}): Promise<R[]> {
    const scoped = this.scopePipeline(pipeline);
    const first = this.def.scope === 'tenant' ? this.tenantMatch() : undefined;
    const full = first ? [{ $match: first }, ...scoped] : scoped;
    const rows = await this.coll().aggregate(full, { ...options, session: this.rt.session() }).toArray();
    return decodeDecimals(rows) as R[];
  }

  // ---------------------------------------------------------------- writes

  async insertOne(doc: InsertDoc<T>): Promise<WithId<T>> {
    const [inserted] = await this.insertMany([doc]);
    return inserted;
  }

  async insertMany(docs: InsertDoc<T>[]): Promise<WithId<T>[]> {
    if (!docs.length) return [];
    const prepared = docs.map((d) => this.prepareInsert(d as Document));
    const write = async () => {
      if (this.def.guards?.beforeInsert) {
        for (const d of prepared) await this.def.guards.beforeInsert(fromStored<T>(d), this.guardContext());
      }
      await this.coll().insertMany(prepared, { session: this.rt.session() });
    };
    await (this.def.guards?.beforeInsert ? this.rt.transaction(write) : write());
    return prepared.map((d) => fromStored<T>(d));
  }

  async updateOne(filter: Filter<Document>, update: Document): Promise<UpdateResult> {
    return this.update(filter, update, false);
  }

  async updateMany(filter: Filter<Document>, update: Document): Promise<UpdateResult> {
    return this.update(filter, update, true);
  }

  /** Updates one document and returns it as it is after the update (or null if none matched). */
  async findOneAndUpdate(filter: Filter<Document>, update: Document): Promise<WithId<T> | null> {
    return this.rt.transaction(async () => {
      const target = await this.coll().findOne(this.filter(filter), { session: this.rt.session(), projection: { _id: 1 } });
      if (!target) return null;
      await this.update({ id: target._id as unknown as string }, update, false);
      return this.findById(target._id as unknown as string);
    });
  }

  async deleteOne(filter: Filter<Document>): Promise<number> {
    return this.remove(filter, false);
  }

  async deleteMany(filter: Filter<Document>): Promise<number> {
    return this.remove(filter, true);
  }

  // ---------------------------------------------------------------- internals

  private coll(): Collection<Document> {
    return this.rt.raw(this.def.name);
  }

  private guardContext(): GuardContext {
    return { collection: (def) => this.rt.scoped(def) };
  }

  /** The organisation filter for a tenant collection, or null when bypass is on. */
  private tenantMatch(): Document | null {
    const ctx = this.rt.context();
    if (ctx.bypass) return null;
    if (!ctx.orgId) {
      throw new TenantAccessError(`No organisation in context: refusing to touch tenant collection ${this.def.name}`);
    }
    return { [TENANT_FIELD]: ctx.orgId };
  }

  private filter(filter: Filter<Document>): Filter<Document> {
    const encoded = encodeFilter(this.def, mapIdFilter(filter as Document));
    if (this.def.scope !== 'tenant') return encoded;
    const match = this.tenantMatch();
    if (!match) return encoded;
    return Object.keys(encoded).length ? { $and: [match, encoded] } : match;
  }

  private prepareInsert(input: Document): Document {
    const { id, _id, ...rest } = input;
    if (_id !== undefined) throw new Error('Pass `id`, not `_id`, when inserting');
    const doc: Document = { _id: id ?? randomUUID(), ...rest };
    if (this.def.scope === 'tenant') {
      const ctx = this.rt.context();
      const given = doc[TENANT_FIELD];
      if (ctx.bypass) {
        if (!given) throw new TenantAccessError(`System insert into ${this.def.name} must name ${TENANT_FIELD}`);
      } else {
        if (!ctx.orgId) throw new TenantAccessError(`No organisation in context: refusing to insert into ${this.def.name}`);
        if (given !== undefined && given !== ctx.orgId) {
          throw new TenantAccessError(`Refusing to insert a document for another organisation into ${this.def.name}`);
        }
        doc[TENANT_FIELD] = ctx.orgId;
      }
    }
    return encodeDocument(this.def, doc);
  }

  private prepareUpdate(update: Document): Document {
    if (Array.isArray(update)) throw new Error('Pipeline updates are not supported; use update operators');
    const keys = Object.keys(update);
    if (!keys.length || !keys.every((k) => k.startsWith('$'))) {
      throw new Error('Updates must use operators such as $set (whole-document replacement is not supported)');
    }
    const out: Document = {};
    for (const [op, body] of Object.entries(update)) {
      if (!UPDATE_OPERATORS_WITH_FIELDS.includes(op)) throw new Error(`Update operator ${op} is not supported`);
      const fields = body as Record<string, unknown>;
      for (const field of Object.keys(fields)) {
        const top = field.split('.')[0];
        if (PROTECTED_FIELDS.has(top) || (op === '$rename' && PROTECTED_FIELDS.has(String(fields[field])))) {
          throw new TenantAccessError(`${field} cannot be changed`);
        }
      }
      if (op === '$unset' || op === '$rename' || op === '$currentDate' || op === '$pop') out[op] = fields;
      else if (op === '$pull' || op === '$pullAll') out[op] = fields; // conditions; encode by hand with dec() if needed
      else out[op] = encodeKeyed(this.def, fields, op === '$push' || op === '$addToSet');
    }
    return out;
  }

  private async update(filter: Filter<Document>, update: Document, many: boolean): Promise<UpdateResult> {
    if (this.def.appendOnly) throw new ImmutableDocumentError(this.def.name, 'update');
    const prepared = this.prepareUpdate(update);
    const scoped = this.filter(filter);
    const after = this.def.guards?.afterUpdate;
    if (!after) {
      const session = this.rt.session();
      const r = many ? await this.coll().updateMany(scoped, prepared, { session }) : await this.coll().updateOne(scoped, prepared, { session });
      return { matched: r.matchedCount, modified: r.modifiedCount };
    }
    return this.rt.transaction(async () => {
      const session = this.rt.session();
      const cursor = this.coll().find(scoped, { session });
      const before = await (many ? cursor : cursor.limit(1)).toArray();
      if (!before.length) return { matched: 0, modified: 0 };
      const ids = before.map((d) => d._id);
      const r = await this.coll().updateMany({ ...this.scopeOnly(), _id: { $in: ids } }, prepared, { session });
      const now = await this.coll().find({ _id: { $in: ids } }, { session }).toArray();
      const byId = new Map(now.map((d) => [d._id, d]));
      for (const old of before) {
        const current = byId.get(old._id);
        if (current) await after(fromStored<T>(old), fromStored<T>(current), this.guardContext());
      }
      return { matched: r.matchedCount, modified: r.modifiedCount };
    });
  }

  private scopeOnly(): Document {
    if (this.def.scope !== 'tenant') return {};
    return this.tenantMatch() ?? {};
  }

  private async remove(filter: Filter<Document>, many: boolean): Promise<number> {
    if (this.def.appendOnly) throw new ImmutableDocumentError(this.def.name, 'delete');
    const scoped = this.filter(filter);
    const guard = this.def.guards?.beforeDelete;
    if (!guard) {
      const session = this.rt.session();
      const r = many ? await this.coll().deleteMany(scoped, { session }) : await this.coll().deleteOne(scoped, { session });
      return r.deletedCount;
    }
    return this.rt.transaction(async () => {
      const session = this.rt.session();
      const cursor = this.coll().find(scoped, { session });
      const docs = await (many ? cursor : cursor.limit(1)).toArray();
      for (const d of docs) await guard(fromStored<T>(d), this.guardContext());
      if (!docs.length) return 0;
      const r = await this.coll().deleteMany({ _id: { $in: docs.map((d) => d._id) } }, { session });
      return r.deletedCount;
    });
  }

  /** Adds the organisation to every stage that reads another tenant collection. */
  private scopePipeline(pipeline: Document[]): Document[] {
    return pipeline.map((stage) => {
      const [name] = Object.keys(stage);
      if (Object.keys(stage).length !== 1) throw new Error('Each pipeline stage must have exactly one operator');
      if (FORBIDDEN_STAGES.has(name)) throw new Error(`Pipeline stage ${name} is not allowed`);
      const body = stage[name];
      switch (name) {
        case '$lookup': {
          const match = this.matchFor(body.from);
          const inner = body.pipeline ? this.scopePipeline(body.pipeline) : undefined;
          const pipeline = match ? [{ $match: match }, ...(inner ?? [])] : inner;
          return { $lookup: { ...body, ...(pipeline ? { pipeline } : {}) } };
        }
        case '$unionWith': {
          const spec = typeof body === 'string' ? { coll: body } : body;
          const match = this.matchFor(spec.coll);
          const inner = spec.pipeline ? this.scopePipeline(spec.pipeline) : [];
          return { $unionWith: { coll: spec.coll, pipeline: match ? [{ $match: match }, ...inner] : inner } };
        }
        case '$graphLookup': {
          const match = this.matchFor(body.from);
          const restrict = body.restrictSearchWithMatch;
          const merged = match ? (restrict ? { $and: [match, restrict] } : match) : restrict;
          return { $graphLookup: { ...body, ...(merged ? { restrictSearchWithMatch: merged } : {}) } };
        }
        case '$facet': {
          const facets: Document = {};
          for (const [k, p] of Object.entries(body as Record<string, Document[]>)) facets[k] = this.scopePipeline(p);
          return { $facet: facets };
        }
        default:
          return stage;
      }
    });
  }

  private matchFor(collection: string): Document | null {
    const def = this.rt.definition(collection);
    if (!def) throw new Error(`Pipeline reads unknown collection "${collection}"`);
    if (def.scope !== 'tenant') return null;
    const ctx = this.rt.context();
    if (ctx.bypass) return null;
    if (!ctx.orgId) throw new TenantAccessError(`No organisation in context: refusing to read ${collection}`);
    return { [TENANT_FIELD]: ctx.orgId };
  }
}

// -------------------------------------------------------------------- id mapping

function fromStored<T>(doc: Document): WithId<T> {
  const { _id, ...rest } = doc;
  return decodeDecimals({ id: _id, ...rest }) as WithId<T>;
}

function mapIdKeys<V>(obj: Record<string, V>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [k, v] of Object.entries(obj)) out[k === 'id' ? '_id' : k] = v;
  return out;
}

function mapIdFilter(filter: Document): Document {
  const out: Document = {};
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$and' || k === '$or' || k === '$nor') out[k] = (v as Document[]).map(mapIdFilter);
    else if (k === '_id') throw new Error('Filter on `id`, not `_id`');
    else out[k === 'id' ? '_id' : k] = v;
  }
  return out;
}

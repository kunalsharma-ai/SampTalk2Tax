import { describe, expect, it } from 'vitest';
import { collectionShardReadiness, defineCollection, partitioningAdvice, shardReadiness } from '../src';

const tenant = (name: string, indexes: { key: Record<string, 1>; name?: string; unique?: boolean; partialFilterExpression?: object }[]) => defineCollection({ name, scope: 'tenant', indexes });

describe('Partitioning readiness (PERF-009)', () => {
  it('calls a tenant collection ready when every unique index starts with the organisation', () => {
    const r = collectionShardReadiness(
      tenant('accounts', [
        { key: { orgId: 1, code: 1 }, name: 'org_code', unique: true },
        { key: { name: 1 }, name: 'by_name' },
      ]),
    );
    expect(r).toEqual({ name: 'accounts', scope: 'tenant', state: 'READY', blockers: [] });
  });

  it('says a unique index on ids of the organisation’s own rows only needs orgId in front', () => {
    const r = collectionShardReadiness(
      tenant('payslips', [
        { key: { payRunId: 1, employeeId: 1 }, name: 'run_employee', unique: true },
        { key: { 'lines.id': 1 }, name: 'line_ids', unique: true, partialFilterExpression: { x: 1 } },
      ]),
    );
    expect(r.state).toBe('NEEDS_ORG_PREFIX');
    expect(r.blockers).toEqual([
      { index: 'run_employee', key: ['payRunId', 'employeeId'], partial: false, kind: 'NEEDS_ORG_PREFIX' },
      { index: 'line_ids', key: ['lines.id'], partial: true, kind: 'NEEDS_ORG_PREFIX' },
    ]);
  });

  it('says a token looked up without the organisation keeps the collection unsharded', () => {
    const r = collectionShardReadiness(
      tenant('portal_links', [
        { key: { tokenHash: 1 }, unique: true },
        { key: { orgId: 1, contactId: 1 }, unique: true },
      ]),
    );
    expect(r.state).toBe('GLOBAL_LOOKUP');
    expect(r.blockers).toEqual([{ index: 'tokenHash', key: ['tokenHash'], partial: false, kind: 'GLOBAL_LOOKUP' }]);
  });

  it('counts every state and leaves shared collections out of splitting', () => {
    const s = shardReadiness([
      tenant('b_ready', [{ key: { orgId: 1 } }]),
      defineCollection({ name: 'a_users', scope: 'global', indexes: [{ key: { email: 1 }, unique: true }] }),
      tenant('c_prefix', [{ key: { budgetId: 1, periodNo: 1 }, unique: true }]),
    ]);
    expect(s.collections.map((c) => [c.name, c.state])).toEqual([
      ['a_users', 'GLOBAL'],
      ['b_ready', 'READY'],
      ['c_prefix', 'NEEDS_ORG_PREFIX'],
    ]);
    expect(s.counts).toEqual({ READY: 1, NEEDS_ORG_PREFIX: 1, GLOBAL_LOOKUP: 0, GLOBAL: 1 });
  });

  it('finds partitioning justified only past the sizes set for one replica set', () => {
    const t = { databaseBytes: 100 * 1024 ** 3, collectionBytes: 40 * 1024 ** 3 };
    const small = partitioningAdvice(5 * 1024 ** 3, [{ name: 'journal_entries', documents: 1_000_000, bytes: 2 * 1024 ** 3 }], t);
    expect(small).toEqual({ justified: false, reasons: [], databaseShare: 0.05, largestShare: 0.05 });
    const big = partitioningAdvice(
      120 * 1024 ** 3,
      [
        { name: 'journal_entries', documents: 9e8, bytes: 50 * 1024 ** 3 },
        { name: 'documents', documents: 1, bytes: 1024 ** 2 },
      ],
      t,
    );
    expect(big.justified).toBe(true);
    expect(big.reasons).toEqual(['The database holds 120.0 GB, past the 100.0 GB set for one replica set', 'journal_entries holds 50.0 GB, past the 40.0 GB set for one collection']);
    expect(big.largestShare).toBe(1.25);
    expect(() => partitioningAdvice(1, [], { databaseBytes: 0, collectionBytes: 1 })).toThrow();
  });
});

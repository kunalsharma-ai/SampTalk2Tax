import { describe, expect, it } from 'vitest';
import { queueOrder, supportGrantEnd, supportTargets, ticketReference, ticketTransition, TicketStateError } from '../src';

const d = (s: string) => new Date(s);
const opened = d('2026-11-10T09:00:00Z');

describe('supportTargets', () => {
  it('times the first response and resolution by priority', () => {
    const t = supportTargets({ priority: 'HIGH', createdAt: opened, firstResponseAt: null, resolvedAt: null, closedAt: null }, d('2026-11-10T10:00:00Z'));
    expect(t.firstResponse).toMatchObject({ dueAt: d('2026-11-10T13:00:00Z'), state: 'RUNNING' });
    expect(t.resolution.dueAt).toEqual(d('2026-11-11T09:00:00Z'));
  });
  it('marks the last quarter as due soon and a late target as overdue', () => {
    const base = { priority: 'HIGH' as const, createdAt: opened, firstResponseAt: null, resolvedAt: null, closedAt: null };
    expect(supportTargets(base, d('2026-11-10T12:00:00Z')).firstResponse.state).toBe('DUE_SOON');
    expect(supportTargets(base, d('2026-11-10T13:00:01Z')).firstResponse.state).toBe('OVERDUE');
  });
  it('records a target as met or missed once done, and resolution counts from the first close', () => {
    const t = supportTargets({ priority: 'URGENT', createdAt: opened, firstResponseAt: d('2026-11-10T09:30:00Z'), resolvedAt: d('2026-11-10T20:00:00Z'), closedAt: d('2026-11-10T15:00:00Z') }, d('2026-11-12T00:00:00Z'));
    expect(t.firstResponse.state).toBe('MET');
    expect(t.resolution).toMatchObject({ state: 'MET', doneAt: d('2026-11-10T15:00:00Z') });
    expect(supportTargets({ priority: 'URGENT', createdAt: opened, firstResponseAt: d('2026-11-10T10:30:00Z'), resolvedAt: null, closedAt: null }, opened).firstResponse.state).toBe('MISSED');
  });
});

describe('ticketTransition', () => {
  it('hands the ticket back and forth', () => {
    expect(ticketTransition('OPEN', 'SUPPORT_REPLY')).toBe('PENDING');
    expect(ticketTransition('PENDING', 'CUSTOMER_REPLY')).toBe('OPEN');
    expect(ticketTransition('OPEN', 'SUPPORT_NOTE')).toBe('OPEN');
    expect(ticketTransition('RESOLVED', 'CUSTOMER_REPLY')).toBe('OPEN');
    expect(ticketTransition('RESOLVED', 'SUPPORT_REPLY')).toBe('RESOLVED');
    expect(ticketTransition('PENDING', 'RESOLVE')).toBe('RESOLVED');
    expect(ticketTransition('RESOLVED', 'REOPEN')).toBe('OPEN');
  });
  it('refuses moves that make no sense, and a closed ticket is final', () => {
    expect(() => ticketTransition('OPEN', 'REOPEN')).toThrow(TicketStateError);
    expect(() => ticketTransition('RESOLVED', 'RESOLVE')).toThrow(/already resolved/);
    for (const a of ['CUSTOMER_REPLY', 'SUPPORT_REPLY', 'CLOSE', 'REOPEN'] as const) expect(() => ticketTransition('CLOSED', a)).toThrow(/closed/);
  });
});

describe('support access and references', () => {
  it('limits a grant to between 1 and 72 whole hours', () => {
    expect(supportGrantEnd(72, opened)).toEqual(d('2026-11-13T09:00:00Z'));
    for (const h of [0, 73, 1.5, -1]) expect(() => supportGrantEnd(h, opened)).toThrow(RangeError);
  });
  it('formats ticket numbers', () => {
    expect(ticketReference(42)).toBe('T-000042');
    expect(ticketReference(1234567n)).toBe('T-1234567');
  });
  it('puts support’s overdue tickets first in the queue', () => {
    const t = (status: 'OPEN' | 'PENDING', state: 'OVERDUE' | 'RUNNING', due: string) => ({ status, createdAt: opened, next: { state, dueAt: d(due), doneAt: null } });
    const list = [t('PENDING', 'OVERDUE', '2026-11-10T10:00:00Z'), t('OPEN', 'RUNNING', '2026-11-10T11:00:00Z'), t('OPEN', 'OVERDUE', '2026-11-10T12:00:00Z')];
    expect(list.sort(queueOrder).map((x) => `${x.status}:${x.next.state}`)).toEqual(['OPEN:OVERDUE', 'OPEN:RUNNING', 'PENDING:OVERDUE']);
  });
});

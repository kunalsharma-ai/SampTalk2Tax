import { describe, expect, it } from 'vitest';
import { errorFingerprintParts, invocationSite, firstAppFrame, isWriteMethod, maintenanceState, percentile, routePattern } from '../src/operations';

describe('maintenance windows', () => {
  const now = new Date('2026-11-06T10:00:00Z');
  it('are scheduled, in progress until ended, or ended', () => {
    expect(maintenanceState({ startsAt: new Date('2026-11-06T11:00:00Z'), endedAt: null }, now)).toBe('SCHEDULED');
    expect(maintenanceState({ startsAt: new Date('2026-11-06T10:00:00Z'), endedAt: null }, now)).toBe('IN_PROGRESS');
    expect(maintenanceState({ startsAt: new Date('2026-11-06T09:00:00Z'), endedAt: new Date('2026-11-06T09:30:00Z') }, now)).toBe('ENDED');
  });
  it('pause every method that is not a read', () => {
    expect(['GET', 'head', 'OPTIONS'].map(isWriteMethod)).toEqual([false, false, false]);
    expect(['POST', 'PUT', 'PATCH', 'DELETE'].map(isWriteMethod)).toEqual([true, true, true, true]);
  });
});

describe('percentiles', () => {
  it('use the nearest rank', () => {
    const v = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
    expect(percentile(v, 50)).toBe(5);
    expect(percentile(v, 95)).toBe(10);
    expect(percentile(v, 0)).toBe(1);
    expect(percentile([], 50)).toBeNull();
    expect(() => percentile(v, 101)).toThrow(RangeError);
  });
});

describe('error grouping', () => {
  it('turns ids and numbers in a path into placeholders and drops the query', () => {
    expect(routePattern('/v1/orgs/0f8fad5b-d9cb-469f-a165-70867728950e/journals/7c9e6679-7425-40de-944b-e07fc1f90ae7?x=1')).toBe('/v1/orgs/:id/journals/:id');
    expect(routePattern('/v1/orgs/0f8fad5b-d9cb-469f-a165-70867728950e/support/42')).toBe('/v1/orgs/:id/support/:n');
  });
  it('takes the first frame from the application, without line numbers', () => {
    const stack = 'TypeError: x is undefined\n    at Object.f (/app/node_modules/lib/index.js:1:2)\n    at JournalsService.post (/app/dist/journals/journals.service.js:120:15)\n    at node:internal/process:1:1';
    expect(firstAppFrame(stack)).toBe('at JournalsService.post (/app/dist/journals/journals.service.js)');
    expect(firstAppFrame(undefined)).toBeNull();
  });
  it('gives the same key for the same problem from different organisations and lines', () => {
    const a = errorFingerprintParts({ name: 'TypeError', stack: 'TypeError: a\n    at S.m (/app/dist/s.js:10:1)' }, 'post', '/v1/orgs/0f8fad5b-d9cb-469f-a165-70867728950e/x');
    const b = errorFingerprintParts({ name: 'TypeError', stack: 'TypeError: b\n    at S.m (/app/dist/s.js:12:9)' }, 'POST', '/v1/orgs/7c9e6679-7425-40de-944b-e07fc1f90ae7/x');
    expect(a.key).toBe(b.key);
    expect(errorFingerprintParts({ name: 'RangeError', stack: 'RangeError: a\n    at S.m (/app/dist/s.js:10:1)' }, 'POST', '/v1/orgs/0f8fad5b-d9cb-469f-a165-70867728950e/x').key).not.toBe(a.key);
  });
  it('places a database client error at the call that made it, not inside the client', () => {
    const message = 'Invalid `this.prisma.budget.findMany()` invocation in\n/app/dist/budgets/budgets.service.js:119:54\n\nThe table does not exist';
    expect(invocationSite(message)).toBe('at this.prisma.budget.findMany() (/app/dist/budgets/budgets.service.js)');
    const p = errorFingerprintParts({ name: 'PrismaClientKnownRequestError', message, stack: 'PrismaClientKnownRequestError: x\n    at ei.handleRequestError (/app/node_modules/@prisma/client/runtime/library.js:121:7)' }, 'GET', '/v1/orgs/0f8fad5b-d9cb-469f-a165-70867728950e/budgets');
    expect(p.frame).toBe('at this.prisma.budget.findMany() (/app/dist/budgets/budgets.service.js)');
    expect(invocationSite('no site here')).toBeNull();
  });
});

/**
 * Operations (M9 slice 6): the rules behind maintenance windows, request timings and error
 * grouping. The API keeps the records; these functions decide what they mean.
 */

export type MaintenanceState = 'SCHEDULED' | 'IN_PROGRESS' | 'ENDED';

/** A window is in progress from its start until someone ends it (an expected end is only a promise). */
export function maintenanceState(w: { startsAt: Date; endedAt: Date | null }, now: Date): MaintenanceState {
  if (w.endedAt) return 'ENDED';
  return w.startsAt.getTime() <= now.getTime() ? 'IN_PROGRESS' : 'SCHEDULED';
}

/** Changes paused while maintenance is in progress: every method that is not a read. */
export function isWriteMethod(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

/** The p-th percentile (0 to 100) by nearest rank; null for no values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (p < 0 || p > 100) throw new RangeError('A percentile is from 0 to 100');
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

/**
 * The route an error is grouped under: the path with ids and numbers replaced, so that
 * /v1/orgs/<uuid>/journals/<uuid> from every organisation is one route. The query is dropped.
 */
export function routePattern(path: string): string {
  const bare = path.split('?')[0]!.split('#')[0]!;
  return bare
    .split('/')
    .map((s) => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ? ':id' : /^\d+$/.test(s) ? ':n' : s))
    .join('/')
    .slice(0, 300);
}

/** The first frame of a stack trace from the application's own code (not node_modules or node internals). */
export function firstAppFrame(stack: string | undefined): string | null {
  if (!stack) return null;
  const frames = stack.split('\n').slice(1).map((l) => l.trim()).filter((l) => l.startsWith('at '));
  const own = frames.find((l) => !l.includes('node_modules') && !l.includes('node:'));
  const f = own ?? frames[0];
  if (!f) return null;
  // Line and column numbers change with every build; the function and file stay put.
  return f.replace(/:\d+:\d+\)?$/, (m) => (m.endsWith(')') ? ')' : '')).slice(0, 500);
}

/**
 * Where a database client error came from: Prisma names the calling file in its message
 * ("Invalid `this.prisma.budget.findMany()` invocation in /app/dist/budgets/budgets.service.js:119:54")
 * while its stack holds only its own frames.
 */
export function invocationSite(message: string | undefined): string | null {
  const m = /`([^`]{1,200})` invocation in\s+(\S+?\.[cm]?[jt]s):\d+:\d+/.exec(message ?? '');
  return m ? `at ${m[1]} (${m[2]})`.slice(0, 500) : null;
}

/** What makes two errors the same problem: the kind of error, where in the code, and the route. */
export function errorFingerprintParts(e: { name: string; stack?: string; message?: string }, method: string, path: string): { name: string; frame: string | null; route: string; key: string } {
  const route = routePattern(path);
  const stackFrame = firstAppFrame(e.stack);
  const frame = (stackFrame && !stackFrame.includes('node_modules') ? stackFrame : invocationSite(e.message)) ?? stackFrame;
  const name = (e.name || 'Error').slice(0, 200);
  return { name, frame, route, key: `${name}|${frame ?? ''}|${method.toUpperCase()} ${route}` };
}

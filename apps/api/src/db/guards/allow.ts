import { AsyncLocalStorage } from 'node:async_hooks';

const allowed = new AsyncLocalStorage<Set<string>>();

/**
 * Runs `fn` with a named exception to a guard switched on (what a transaction-local
 * `set_config('t2t.<name>', 'on', true)` did for the PostgreSQL trigger).
 */
export function allowInTx<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return allowed.run(new Set([...(allowed.getStore() ?? []), name]), fn);
}

export const allowedInTx = (name: string): boolean => allowed.getStore()?.has(name) ?? false;

import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

/**
 * Who the current database work is for. PostgreSQL row-level security reads it from
 * transaction-local settings (t2t.org_id, t2t.user_id, t2t.bypass) that PrismaService
 * sets before every query. See docs/SECURITY.md › Row-level security.
 */
export interface TenantContext {
  /** The organisation named by the route's :orgId, once membership is checked. */
  orgId?: string;
  /** The signed-in user, once the access token and session are checked. */
  userId?: string;
  /** Set only for system work that must cross tenants (e.g. the global audit chain). */
  bypass?: boolean;
  /** Inside an interactive transaction whose settings are already applied. */
  inTx?: boolean;
}

export const tenantStorage = new AsyncLocalStorage<TenantContext>();

/**
 * Every HTTP request starts with an empty context: no organisation, no user, no bypass,
 * so tenant tables return nothing until the auth guard fills it in.
 */
export function tenantContextMiddleware(_req: Request, _res: Response, next: NextFunction): void {
  tenantStorage.run({}, next);
}

let outsideRequests: TenantContext = {};

/**
 * Lets code that runs outside any HTTP request (the demo seed, CLI scripts, test set-up)
 * act as the system, which bypasses tenant policies. The API server never calls this, so
 * in the server a query that somehow escapes its request context sees no tenant rows.
 */
export function allowSystemAccessOutsideRequests(): void {
  outsideRequests = { bypass: true };
}

/** The context for a query: the request's, or the process default outside requests. */
export function currentTenantContext(): TenantContext {
  return tenantStorage.getStore() ?? outsideRequests;
}

/** Narrows the current request to one organisation (used after the membership check, and for a new organisation). */
export function enterOrg(orgId: string): void {
  const store = tenantStorage.getStore();
  if (store) store.orgId = orgId;
}

export function enterUser(userId: string): void {
  const store = tenantStorage.getStore();
  if (store) store.userId = userId;
}

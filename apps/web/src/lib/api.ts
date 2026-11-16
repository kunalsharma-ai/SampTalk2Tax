'use client';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly issues: string[] = [],
  ) {
    super(message);
  }
}

type Json = Record<string, unknown> | unknown[];

/** Calls the Talk2Tax API through the same-origin proxy. Throws ApiError with server issues. */
export async function api<T>(path: string, init: { method?: string; body?: Json; idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-t2t-csrf': '1' };
  if (init.body) headers['content-type'] = 'application/json';
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
  const res = await fetch(`/api/t2t${path}`, { method: init.method ?? 'GET', headers, body: init.body ? JSON.stringify(init.body) : undefined });
  if (res.status === 401 && typeof window !== 'undefined') {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const rawIssues = Array.isArray(body.issues) ? body.issues : Array.isArray(body.details?.issues) ? body.details.issues : null;
    const issues: string[] = rawIssues ? rawIssues.map((i: unknown) => (typeof i === 'string' ? i : `${(i as { path: string }).path}: ${(i as { message: string }).message}`)) : [];
    throw new ApiError(res.status, body.error ?? 'ERROR', body.message ?? `Request failed (${res.status})`, issues);
  }
  return body as T;
}

export async function session(mode: 'login' | 'register', payload: { email: string; password: string; name?: string }) {
  const res = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: JSON.stringify({ mode, ...payload }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? 'ERROR', body.message ?? 'Sign-in failed', []);
  return body as { user: { id: string; email: string; name: string } };
}

export async function signOut() {
  await fetch('/api/session', { method: 'DELETE', headers: { 'x-t2t-csrf': '1' } });
  window.location.href = '/login';
}

export function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

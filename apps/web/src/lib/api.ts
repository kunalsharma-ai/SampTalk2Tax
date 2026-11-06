'use client';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly issues: string[] = [],
    /** The server's id for the request: quoted to support, it finds the exact failure. */
    public readonly requestId: string | null = null,
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
    const requestId = typeof body.requestId === 'string' ? body.requestId : res.headers.get('x-request-id');
    // An unexpected failure carries its reference, so that support can find it.
    const message = body.message ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, body.error ?? 'ERROR', res.status >= 500 && res.status !== 503 && requestId ? `${message}. Reference: ${requestId}` : message, issues, requestId);
  }
  return body as T;
}

/** Sends a file's bytes as the request body (attachments). The server decides the type from the bytes. */
export async function uploadFile<T>(path: string, file: File): Promise<T> {
  const res = await fetch(`/api/t2t${path}`, { method: 'POST', headers: { 'x-t2t-csrf': '1', 'content-type': 'application/octet-stream' }, body: file });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = res.status === 413 && !body.message ? 'Files can be at most 5 MB' : (body.message ?? `Upload failed (${res.status})`);
    throw new ApiError(res.status, body.error ?? 'ERROR', message, []);
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

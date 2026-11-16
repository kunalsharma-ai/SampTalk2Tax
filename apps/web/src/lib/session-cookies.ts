import 'server-only';
import type { NextRequest, NextResponse } from 'next/server';
import { apiBaseUrl, REFRESH_COOKIE, SESSION_COOKIE } from './server-config';

export interface IssuedSession {
  accessToken: string;
  expiresIn: number;
  refreshToken: string | null;
  sessionExpiresAt: string;
}

const secure = () => process.env.NODE_ENV === 'production';

export function setSessionCookies(res: NextResponse, s: IssuedSession): void {
  res.cookies.set(SESSION_COOKIE, s.accessToken, { httpOnly: true, sameSite: 'lax', secure: secure(), path: '/', maxAge: s.expiresIn });
  // A refresh inside the API's grace window returns no new refresh token: keep the cookie as it is.
  if (s.refreshToken) {
    const maxAge = Math.max(0, Math.floor((new Date(s.sessionExpiresAt).getTime() - Date.now()) / 1000));
    res.cookies.set(REFRESH_COOKIE, s.refreshToken, { httpOnly: true, sameSite: 'lax', secure: secure(), path: '/', maxAge });
  }
}

export function clearSessionCookies(res: NextResponse): void {
  for (const name of [SESSION_COOKIE, REFRESH_COOKIE]) res.cookies.set(name, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
}

/**
 * Headers the API uses to describe the client: its address (for rate limits and the
 * session list) and its browser. The API trusts X-Forwarded-For only across the number of
 * hops it is configured for (TRUST_PROXY_HOPS), so this proxy counts as one hop there.
 *
 * Here, the client address is read from X-Forwarded-For counting T2T_CLIENT_IP_HOPS
 * entries from the right (default 1: the address added by the reverse proxy in front of
 * this app). Next.js itself only fills the header when it is missing, so if this app is
 * exposed without a reverse proxy, a client can send a made-up address.
 */
export function clientIp(forwarded: string | null, hops = Number(process.env.T2T_CLIENT_IP_HOPS ?? 1)): string | null {
  const parts = (forwarded ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const n = Number.isInteger(hops) && hops > 0 ? hops : 1;
  return parts[Math.max(0, parts.length - n)];
}

export function clientHeaders(req: NextRequest): Record<string, string> {
  const h: Record<string, string> = {};
  const ip = clientIp(req.headers.get('x-forwarded-for')) ?? req.headers.get('x-real-ip');
  if (ip) h['x-forwarded-for'] = ip;
  const ua = req.headers.get('user-agent');
  if (ua) h['user-agent'] = ua.slice(0, 300);
  return h;
}

type RefreshResult = { ok: true; session: IssuedSession } | { ok: false; status: number; body: unknown };

/**
 * Several requests from one page can find the access token expired at once. They share one
 * refresh call per refresh token (in this process), so the token is rotated once and every
 * response sets the same new cookies. Across processes the API's grace window covers the race.
 */
const inflight = new Map<string, Promise<RefreshResult>>();

export function refreshSession(refreshToken: string, headers: Record<string, string>): Promise<RefreshResult> {
  const existing = inflight.get(refreshToken);
  if (existing) return existing;
  const p = (async (): Promise<RefreshResult> => {
    try {
      const r = await fetch(`${apiBaseUrl()}/v1/auth/refresh`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
        cache: 'no-store',
      });
      const body = await r.json().catch(() => ({}));
      return r.ok ? { ok: true, session: body as IssuedSession } : { ok: false, status: r.status, body };
    } catch {
      return { ok: false, status: 502, body: { error: 'UPSTREAM_UNAVAILABLE', message: 'Could not reach the API' } };
    }
  })();
  inflight.set(refreshToken, p);
  // Keep the settled result briefly for requests that were already on their way with the old cookie.
  void p.finally(() => setTimeout(() => inflight.delete(refreshToken), 10_000).unref?.());
  return p;
}

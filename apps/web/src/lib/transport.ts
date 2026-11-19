import type { NextRequest } from 'next/server';

/**
 * Encryption in transit (SEC-010). HTTPS_ONLY=true (the default for a production build; set
 * HTTPS_ONLY=false to turn it off) sends visitors on http:// to the https:// address and tells
 * browsers to use HTTPS only. TLS ends at the load balancer in front, which reports the
 * protocol in X-Forwarded-Proto. Requests to localhost (the container's own health check, a
 * developer's machine) are left alone.
 */
export function httpsOnly(): boolean {
  const v = process.env.HTTPS_ONLY;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

export const STRICT_TRANSPORT_SECURITY = 'max-age=31536000; includeSubDomains';

/** The protocol the visitor used: the first X-Forwarded-Proto value, else this server's own. */
export function requestProto(req: NextRequest): 'http' | 'https' {
  const forwarded = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (forwarded === 'https' || forwarded === 'http') return forwarded;
  return req.nextUrl.protocol === 'https:' ? 'https' : 'http';
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i;

/** Where an http:// request should go instead, or null to serve it. */
export function httpsRedirect(req: NextRequest): URL | null {
  if (!httpsOnly() || requestProto(req) === 'https') return null;
  const host = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || req.headers.get('host') || req.nextUrl.host;
  if (LOOPBACK.test(host)) return null;
  const url = new URL(req.nextUrl.pathname + req.nextUrl.search, `https://${host.replace(/:\d+$/, '')}`);
  return url;
}

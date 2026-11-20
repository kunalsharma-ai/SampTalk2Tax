import { NextRequest } from 'next/server';
import { securityTxt } from '@/lib/security-txt';

/**
 * security.txt (RFC 9116), for penetration testers and researchers (SEC-026): where to report a
 * vulnerability. Served only when SECURITY_CONTACT is set (mailto: or https: addresses, comma
 * separated), so a server never points researchers at nobody.
 */
export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || req.nextUrl.protocol.replace(':', '');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? req.nextUrl.host;
  const body = securityTxt(process.env, `${proto}://${host}`);
  if (!body) return new Response('Not found\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
}

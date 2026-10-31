import { NextRequest, NextResponse } from 'next/server';

const PUBLIC = ['/login', '/register'];

/** Redirects signed-out visitors to /login (the API still enforces auth on every call). */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const signedIn = Boolean(req.cookies.get('t2t_session')?.value);
  if (!signedIn && !PUBLIC.includes(pathname)) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }
  if (signedIn && PUBLIC.includes(pathname)) return NextResponse.redirect(new URL('/', req.url));
  return NextResponse.next();
}

export const config = { matcher: ['/((?!api/|_next/|favicon.ico|icon.svg).*)'] };

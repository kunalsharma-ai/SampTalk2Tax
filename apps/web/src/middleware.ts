import { NextRequest, NextResponse } from 'next/server';

const PUBLIC = ['/login', '/register'];
/** Open to anyone, signed in or not: where a customer lands after paying a payment link. */
const OPEN = ['/paid'];

/** Redirects signed-out visitors to /login (the API still enforces auth on every call). */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (OPEN.includes(pathname)) return NextResponse.next();
  // An expired access cookie is fine while the refresh cookie lives: the API proxy renews it.
  const signedIn = Boolean(req.cookies.get('t2t_session')?.value || req.cookies.get('t2t_refresh')?.value);
  if (!signedIn && !PUBLIC.includes(pathname)) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }
  if (signedIn && PUBLIC.includes(pathname)) return NextResponse.redirect(new URL('/', req.url));
  return NextResponse.next();
}

// Logos and app icons are public: the sign-in page shows them before anyone is signed in.
export const config = { matcher: ['/((?!api/|_next/|brand/|favicon.ico|icon.svg|apple-icon.png|manifest.webmanifest).*)'] };

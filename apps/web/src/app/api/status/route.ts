import { NextResponse } from 'next/server';
import { apiBaseUrl } from '@/lib/server-config';

/** Public service status (maintenance), for the banner on every page, signed in or not. */
export async function GET() {
  try {
    const r = await fetch(`${apiBaseUrl()}/v1/status`, { cache: 'no-store' });
    return NextResponse.json(await r.json(), { status: r.ok ? 200 : 502 });
  } catch {
    return NextResponse.json({ error: 'UNAVAILABLE', message: 'Talk2Tax is not answering at the moment' }, { status: 502 });
  }
}

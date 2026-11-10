import { NextRequest, NextResponse } from 'next/server';
import { apiBaseUrl } from '@/lib/server-config';
import { clientHeaders } from '@/lib/session-cookies';

/**
 * Same-origin proxy for the vendor portal (AP-013), to /v1/vendor-portal/* only and never with
 * anyone's session: the link's secret in the path is the only credential. GET reads the portal;
 * POST sends an invoice (JSON); PUT adds its file (PDF or image, at most 5 MB).
 */
const PASS_THROUGH = ['content-disposition', 'x-content-type-options', 'content-security-policy', 'cache-control', 'referrer-policy', 'retry-after'];
const MAX_FILE = 5 * 1024 * 1024;
const FILE_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'];
const notFound = () => NextResponse.json({ error: 'NOT_FOUND', message: 'Unknown portal path' }, { status: 404 });
const badPath = (path: string[]) => !path.length || path.some((p) => p === '..' || p === '.' || p === '' || p.length > 100);

async function forward(req: NextRequest, path: string[], init: { method: string; body?: ArrayBuffer | string; contentType?: string }) {
  const url = `${apiBaseUrl()}/v1/vendor-portal/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`;
  const headers = new Headers(clientHeaders(req));
  if (init.contentType) headers.set('content-type', init.contentType);
  const upstream = await fetch(url, { method: init.method, headers, body: init.body, cache: 'no-store' });
  const out = new NextResponse(await upstream.arrayBuffer(), { status: upstream.status });
  const ct = upstream.headers.get('content-type');
  if (ct) out.headers.set('content-type', ct);
  for (const h of PASS_THROUGH) {
    const v = upstream.headers.get(h);
    if (v) out.headers.set(h, v);
  }
  out.headers.set('referrer-policy', 'no-referrer');
  out.headers.set('cache-control', 'private, no-store');
  return out;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (badPath(path) || path.length > 2) return notFound();
  return forward(req, path, { method: 'GET' });
}

/** Sending an invoice: /<token>/invoices, JSON only. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (badPath(path) || path.length !== 2 || path[1] !== 'invoices') return notFound();
  if (!req.headers.get('content-type')?.startsWith('application/json')) return NextResponse.json({ error: 'BAD_REQUEST', message: 'Send JSON' }, { status: 415 });
  const body = await req.text();
  if (body.length > 10_000) return NextResponse.json({ error: 'BAD_REQUEST', message: 'Too much data' }, { status: 413 });
  return forward(req, path, { method: 'POST', body, contentType: 'application/json' });
}

/** Adding the invoice's file: /<token>/invoices/<id>/file?fileName=… */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (badPath(path) || path.length !== 4 || path[1] !== 'invoices' || path[3] !== 'file') return notFound();
  const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!FILE_TYPES.includes(type)) return NextResponse.json({ error: 'UNSUPPORTED_FILE', message: 'Send a PDF, PNG, JPEG or WebP file' }, { status: 415 });
  if (Number(req.headers.get('content-length') ?? 0) > MAX_FILE) return NextResponse.json({ error: 'FILE_TOO_LARGE', message: 'Files can be at most 5 MB' }, { status: 413 });
  const body = await req.arrayBuffer();
  if (body.byteLength > MAX_FILE) return NextResponse.json({ error: 'FILE_TOO_LARGE', message: 'Files can be at most 5 MB' }, { status: 413 });
  return forward(req, path, { method: 'PUT', body, contentType: type });
}

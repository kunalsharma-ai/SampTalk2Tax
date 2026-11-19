import { connect } from 'node:net';

/**
 * A client for ClamAV's daemon (clamd) over TCP (SEC-019): INSTREAM sends the file in chunks and
 * clamd answers OK, "<signature> FOUND" or an error. The file never touches the disk here.
 */
export type ClamResult = { status: 'CLEAN' } | { status: 'INFECTED'; signature: string } | { status: 'ERROR'; error: string };

export function parseClamdUrl(url: string): { host: string; port: number } {
  const u = new URL(url);
  if (u.protocol !== 'tcp:') throw new Error('CLAMAV_URL is written tcp://host:3310');
  return { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port || 3310) };
}

function talk(url: string, write: (send: (b: Buffer) => void) => void, timeoutMs: number): Promise<string> {
  const { host, port } = parseClamdUrl(url);
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => sock.destroy(new Error(`no answer within ${timeoutMs / 1000} seconds`)), timeoutMs);
    sock.on('connect', () => write((b) => sock.write(b)));
    sock.on('data', (d: Buffer) => {
      chunks.push(d);
      if (d.includes(0)) sock.end();
    });
    sock.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ECONNREFUSED' ? `the scanner at ${host}:${port} refused the connection` : e.message));
    });
    sock.on('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8').replace(/\0+$/, '').trim());
    });
  });
}

export async function clamdScan(url: string, content: Buffer, timeoutMs: number): Promise<ClamResult> {
  let answer: string;
  try {
    answer = await talk(
      url,
      (send) => {
        send(Buffer.from('zINSTREAM\0', 'latin1'));
        for (let o = 0; o < content.length; o += 64 * 1024) {
          const part = content.subarray(o, o + 64 * 1024);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length);
          send(Buffer.concat([len, part]));
        }
        send(Buffer.alloc(4));
      },
      timeoutMs,
    );
  } catch (e) {
    return { status: 'ERROR', error: (e as Error).message };
  }
  if (/^stream: OK$/.test(answer)) return { status: 'CLEAN' };
  const found = /^stream: (.+) FOUND$/.exec(answer);
  if (found) return { status: 'INFECTED', signature: found[1]!.slice(0, 200) };
  return { status: 'ERROR', error: answer ? answer.slice(0, 200) : 'the scanner closed the connection without an answer' };
}

/** The engine and signature database version, or an error. */
export async function clamdVersion(url: string, timeoutMs: number): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  try {
    const v = await talk(url, (send) => send(Buffer.from('zVERSION\0', 'latin1')), timeoutMs);
    return v ? { ok: true, version: v.slice(0, 200) } : { ok: false, error: 'no answer' };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

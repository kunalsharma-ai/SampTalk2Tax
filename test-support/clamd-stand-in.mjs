/**
 * A local stand-in for ClamAV's daemon (clamd) for tests only (SEC-019). It speaks clamd's TCP
 * protocol (zINSTREAM and zVERSION) and reports the EICAR test signature, the harmless test file
 * every antivirus detects. It never sees or keeps anything beyond the test's own bytes.
 *
 *   const clamd = await startClamdStandIn(4560);   // the API runs with CLAMAV_URL=tcp://127.0.0.1:4560
 *   clamd.mode = 'error';                          // answer every scan with an error
 *   clamd.scanned                                  // how many files were scanned
 */
import { createServer } from 'node:net';

export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export async function startClamdStandIn(port = 4560) {
  const state = { mode: 'ok', scanned: 0 };
  const server = createServer((sock) => {
    let buf = Buffer.alloc(0);
    let command = null;
    const file = [];
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (command === null) {
        const z = buf.indexOf(0);
        if (z < 0) return;
        command = buf.subarray(0, z).toString('latin1');
        buf = buf.subarray(z + 1);
        if (command === 'zVERSION') return sock.end('ClamAV 1.4.1/27300/Stand-in\0');
        if (command !== 'zINSTREAM') return sock.end('UNKNOWN COMMAND\0');
      }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          state.scanned++;
          const all = Buffer.concat(file).toString('latin1');
          if (state.mode === 'error') return sock.end('stream: Can\'t allocate memory ERROR\0');
          return sock.end(all.includes(EICAR) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
        }
        if (buf.length < 4 + len) return;
        file.push(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
      }
    });
    sock.on('error', () => undefined);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return Object.assign(state, {
    close: () => new Promise((resolve) => server.close(resolve)),
  });
}

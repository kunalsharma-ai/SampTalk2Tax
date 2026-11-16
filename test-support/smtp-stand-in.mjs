/**
 * A local SMTP server for tests only. The API's real email code (nodemailer over SMTP)
 * delivers to it when the API runs with SMTP_URL pointing here. It keeps every message
 * it accepts, decoded, so a test can read what was sent. It never relays anything.
 *
 *   const smtp = await startSmtpStandIn(4556);
 *   smtp.answers.set('gone@example.test', '550 5.1.1 No such mailbox');   // refuse one address for good
 *   smtp.answers.set('busy@example.test', '451 4.3.0 Try again later');   // or for now
 *   … smtp.messages[0].subject, .text, .to, .headers['auto-submitted']
 */
import { createServer } from 'node:net';

function decodeWords(s) {
  return s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=\s*(?==\?)?/g, (_m, _cs, enc, data) =>
    enc.toUpperCase() === 'B' ? Buffer.from(data, 'base64').toString('utf8') : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_x, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'),
  );
}

function parse(raw) {
  const split = raw.indexOf('\r\n\r\n');
  const head = split < 0 ? raw : raw.slice(0, split);
  let body = split < 0 ? '' : raw.slice(split + 4);
  const headers = {};
  for (const line of head.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = decodeWords(line.slice(i + 1).trim());
  }
  const cte = (headers['content-transfer-encoding'] ?? '').toLowerCase();
  if (cte === 'base64') body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  else if (cte === 'quoted-printable') body = Buffer.from(body.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (_x, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
  return { headers, subject: headers.subject ?? '', text: body.replace(/\r\n/g, '\n').replace(/\n$/, '') };
}

export async function startSmtpStandIn(port = 0) {
  const messages = [];
  const answers = new Map();
  /** Logins seen (AUTH PLAIN), and whether to refuse them. */
  const logins = [];
  const settings = { refuseLogins: false };
  let queued = 0;
  const server = createServer((socket) => {
    let buf = '';
    let mode = 'command';
    let tx = { from: null, to: [] };
    let data = [];
    const reply = (s) => socket.write(`${s}\r\n`);
    reply('220 smtp-stand-in ESMTP ready');
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (mode === 'data') {
          if (line === '.') {
            mode = 'command';
            const raw = Buffer.from(data.join('\r\n'), 'latin1').toString('utf8');
            messages.push({ from: tx.from, to: tx.to, raw, ...parse(raw) });
            data = [];
            tx = { from: null, to: [] };
            reply(`250 2.0.0 OK queued as stand-in-${++queued}`);
          } else data.push(line.startsWith('..') ? line.slice(1) : line);
          continue;
        }
        if (mode === 'auth-user') {
          mode = 'auth-pass';
          reply('334 UGFzc3dvcmQ6');
          continue;
        }
        if (mode === 'auth-pass') {
          mode = 'command';
          reply('235 2.7.0 Authentication successful');
          continue;
        }
        const [verb] = line.split(' ', 1);
        const arg = line.slice(verb.length + 1);
        switch (verb.toUpperCase()) {
          case 'EHLO':
            socket.write('250-smtp-stand-in\r\n250-8BITMIME\r\n250-SMTPUTF8\r\n250 AUTH PLAIN LOGIN\r\n');
            break;
          case 'HELO':
            reply('250 smtp-stand-in');
            break;
          case 'AUTH':
            if (/^LOGIN/i.test(arg)) {
              mode = 'auth-user';
              reply('334 VXNlcm5hbWU6');
            } else {
              // AUTH PLAIN with the initial response: base64("\0user\0password").
              const [, user, pass] = Buffer.from(arg.split(' ')[1] ?? '', 'base64').toString('utf8').split('\0');
              logins.push({ user, pass });
              reply(settings.refuseLogins ? '535 5.7.8 Authentication credentials invalid' : '235 2.7.0 Authentication successful');
            }
            break;
          case 'MAIL':
            tx = { from: /<([^>]*)>/.exec(arg)?.[1] ?? '', to: [] };
            reply('250 2.1.0 OK');
            break;
          case 'RCPT': {
            const to = (/<([^>]*)>/.exec(arg)?.[1] ?? '').toLowerCase();
            const answer = answers.get(to);
            if (answer) reply(answer);
            else {
              tx.to.push(to);
              reply('250 2.1.5 OK');
            }
            break;
          }
          case 'DATA':
            if (!tx.to.length) reply('554 5.5.1 No valid recipients');
            else {
              mode = 'data';
              reply('354 End data with <CR><LF>.<CR><LF>');
            }
            break;
          case 'RSET':
            tx = { from: null, to: [] };
            reply('250 2.0.0 OK');
            break;
          case 'NOOP':
            reply('250 2.0.0 OK');
            break;
          case 'QUIT':
            reply('221 2.0.0 Bye');
            socket.end();
            break;
          default:
            reply('502 5.5.2 Command not recognised');
        }
      }
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const p = server.address().port;
  return { url: `smtp://127.0.0.1:${p}`, port: p, messages, answers, logins, settings, close: () => new Promise((r) => server.close(() => r())) };
}

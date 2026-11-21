/** RULE-008: the shortcut check finds each insecure shortcut and lets ordinary code through. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findShortcuts, RULES, scanRepository } from './check-shortcuts.mjs';

const rule = (text) => findShortcuts(text).map((s) => s.rule);

test('finds each kind of shortcut', () => {
  const cases = {
    'code-from-text': ['const f = eval(body);', "const g = new Function('a', src);"],
    'tls-off': ['https.request({ host, rejectUnauthorized: false });', "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';"],
    'raw-html': ['<div dangerouslySetInnerHTML={{ __html: note }} />', 'el.innerHTML = message;', "el.insertAdjacentHTML('beforeend', row);"],
    'weak-hash': ["createHash('md5').update(password)", 'createHash("SHA1")'],
    'old-cipher': ["crypto.createCipher('aes-256-cbc', key)"],
    shell: ['execSync(`git ${args}`)', "import { exec } from 'node:child_process';"],
    'jwt-none': ["jwtVerify(t, k, { algorithms: ['none'] })", 'jwt.verify(t, k, { ignoreExpiration: true })'],
    'cors-any': ["app.enableCors({ origin: '*', credentials: true })", 'cors({ origin: true })'],
    'random-secret': ['const resetToken = Math.random().toString(36).slice(2);', 'otp: Math.floor(Math.random() * 1e6)'],
    'secret-in-code': ["const API_KEY = 'sk_live_abcdefghijklmnop1234';", "password: 'SuperSecretPassw0rdXYZ'"],
    'private-key': ['const pem = `-----BEGIN PRIVATE KEY-----`;'],
  };
  assert.deepEqual(Object.keys(cases).sort(), RULES.map((r) => r.id).sort());
  for (const [id, lines] of Object.entries(cases)) for (const l of lines) assert.ok(rule(l).includes(id), `${id}: ${l}`);
});

test('lets ordinary code, comments and safe forms through', () => {
  for (const ok of [
    'const m = /^(\\d{4})$/.exec(label);',
    'if (el.innerHTML === expected) return;',
    "createHash('sha256').update(body)",
    'const token = randomBytes(32).toString("base64url");',
    'await new Promise((r) => setTimeout(r, Math.random() * 200));',
    "jwtVerify(t, k, { algorithms: ['HS256'] })",
    "app.enableCors({ origin: config.WEB_ORIGIN, credentials: true })",
    '// Never call eval(): it runs text as code.',
    ' * rejectUnauthorized: false would turn off the check.',
    "const password = form.get('password');",
  ]) {
    assert.deepEqual(rule(ok), [], ok);
  }
});

test('the application code has no insecure shortcuts today', () => {
  assert.deepEqual(scanRepository(), []);
});

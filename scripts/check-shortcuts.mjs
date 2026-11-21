#!/usr/bin/env node
/**
 * No insecure shortcuts (RULE-008): the application code (apps/*\/src, packages/*\/src, tests
 * excluded) must not turn off a protection to make something work. Each rule below is a pattern
 * that is almost never right in this product; one that is right in a particular place goes in
 * ALLOWED with the reason, so the exception is reviewed like any other change.
 *
 *   node scripts/check-shortcuts.mjs       exits 1 and lists each shortcut found
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RULES = [
  { id: 'code-from-text', why: 'runs text as code', re: /\beval\s*\(|\bnew\s+Function\s*\(/ },
  { id: 'tls-off', why: 'turns off TLS certificate checks', re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/ },
  { id: 'raw-html', why: 'puts unescaped HTML in the page', re: /dangerouslySetInnerHTML|\.(?:inner|outer)HTML\s*=(?!=)|\.insertAdjacentHTML\s*\(|document\.write\s*\(/ },
  { id: 'weak-hash', why: 'MD5 and SHA-1 are broken for security use', re: /createHash\(\s*['"](?:md5|sha1)['"]/i },
  { id: 'old-cipher', why: 'createCipher has no IV and a weak key derivation', re: /\bcreate(?:De)?[cC]ipher\s*\(/ },
  { id: 'shell', why: 'runs a command through a shell', re: /\b(?:exec|execSync)\s*\(\s*[`'"]|from\s+['"](?:node:)?child_process['"]/ },
  { id: 'jwt-none', why: 'accepts unsigned or expired tokens', re: /algorithms\s*:\s*\[[^\]]*['"]none['"]|ignoreExpiration\s*:\s*true/i },
  { id: 'cors-any', why: 'lets any site call the API', re: /origin\s*:\s*(?:['"]\*['"]|true\b)/ },
  { id: 'random-secret', why: 'Math.random is predictable; secrets need crypto.randomBytes or randomUUID', re: /(?:token|secret|password|nonce|otp|salt|key)\w*\s*[:=][^;\n]*Math\.random\(/i },
  { id: 'secret-in-code', why: 'a secret written into the code', re: /\b(?:secret|password|passwd|api[_-]?key|access[_-]?token|private[_-]?key)\w*\s*[:=]\s*['"][A-Za-z0-9+/_\-]{16,}['"]/i },
  { id: 'private-key', why: 'a private key written into the code', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

/** Justified exceptions: `path` and rule id, with the reason. */
export const ALLOWED = [];

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCES = ['apps/api/src', 'apps/web/src', ...readdirSync(join(ROOT, 'packages')).map((p) => `packages/${p}/src`)];
const TEST_FILE = /\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/;

/** Each shortcut in one file's text: line, rule and the line itself. Comments are not code, so a line that is only a comment is skipped. */
export function findShortcuts(text, path = '') {
  const found = [];
  text.split('\n').forEach((line, i) => {
    const code = line.trim();
    if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
    for (const r of RULES) {
      if (!r.re.test(line)) continue;
      if (ALLOWED.some((a) => a.path === path && a.rule === r.id)) continue;
      found.push({ line: i + 1, rule: r.id, why: r.why, text: code.slice(0, 160) });
    }
  });
  return found;
}

function* files(path) {
  const st = statSync(join(ROOT, path), { throwIfNoEntry: false });
  if (!st) return;
  if (st.isFile()) {
    if (/\.(?:[cm]?[jt]sx?)$/.test(path) && !TEST_FILE.test(path)) yield path;
    return;
  }
  for (const name of readdirSync(join(ROOT, path))) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.next')) continue;
    yield* files(join(path, name));
  }
}

export function scanRepository() {
  const out = [];
  for (const src of SOURCES) for (const f of files(src)) for (const s of findShortcuts(readFileSync(join(ROOT, f), 'utf8'), relative(ROOT, join(ROOT, f)))) out.push({ file: f, ...s });
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = scanRepository();
  if (found.length) {
    console.error('Insecure shortcuts found (RULE-008). Fix them, or add a reviewed exception to ALLOWED in scripts/check-shortcuts.mjs:');
    for (const s of found) console.error(`  ${s.file}:${s.line}  [${s.rule}: ${s.why}] ${s.text}`);
    process.exit(1);
  }
  console.log('No insecure shortcuts.');
}

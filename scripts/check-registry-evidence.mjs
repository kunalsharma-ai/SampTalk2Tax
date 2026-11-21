/**
 * RULE-020 and RULE-016: the feature registry reports working, tested
 * functionality, not screens. A feature marked Tested must point at a test that
 * exists, and every file or folder named as evidence for a Tested or
 * Implemented feature must still be in the repository. Evidence can also be a
 * route or a sentence; only entries that start with a repository folder are
 * checked as paths.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = /^(apps|packages|scripts|docs|features|infra|\.github|deploy|e2e)\//;
const CHECKED = new Set(['Tested', 'Implemented']);
const TEST = /(^|\/)(test|e2e)\/|\.test\.(ts|tsx|mjs|js)$|^scripts\/check-[\w-]+\.mjs$/;

/** The repository path an evidence entry names, or null when it names none. */
export function evidencePath(entry) {
  const first = String(entry).trim().split(/\s+/)[0].replace(/[;,:]+$/, '');
  return ROOTS.test(first) || first === '.env.example' || first === '.gitignore' ? first : null;
}

function globExists(root, path) {
  if (!path.includes('*')) return existsSync(join(root, path));
  const parts = path.split('/');
  const walk = (dir, i) => {
    if (i === parts.length) return true;
    const p = parts[i];
    if (!p.includes('*')) return existsSync(join(dir, p)) && walk(join(dir, p), i + 1);
    const re = new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      return false;
    }
    return names.some((n) => re.test(n) && walk(join(dir, n), i + 1));
  };
  return walk(root, 0);
}

/** Problems with one feature's status entry. `exists` decides whether a path is there. */
export function evidenceProblems(id, entry, exists) {
  if (!CHECKED.has(entry.status)) return [];
  const out = [];
  const paths = (entry.evidence ?? []).map(evidencePath).filter(Boolean);
  for (const p of paths) if (!exists(p)) out.push(`${id}: evidence ${p} is not in the repository`);
  if (entry.status === 'Tested' && !paths.some((p) => exists(p) && (TEST.test(p) || p.endsWith('/test')))) out.push(`${id}: marked Tested but names no test`);
  return out;
}

export function scanRegistry(statusFile = join(ROOT, 'features/status.json')) {
  const { features } = JSON.parse(readFileSync(statusFile, 'utf8'));
  const exists = (p) => globExists(ROOT, p);
  return Object.entries(features).flatMap(([id, entry]) => evidenceProblems(id, entry, exists));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = scanRegistry();
  if (problems.length) {
    console.error(`The feature registry claims more than the code shows (RULE-020):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log('Every Tested feature names a test, and all evidence exists.');
}

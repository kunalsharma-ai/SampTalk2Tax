#!/usr/bin/env node
/**
 * Builds the feature registry (features/registry.json) and the human-readable
 * docs/FEATURE_INVENTORY.md and docs/FEATURE_STATUS.md from the master directive.
 *
 * Every bullet / numbered item and every "must / never / do not" rule in the
 * product parts of docs/MASTER_DIRECTIVE.md becomes one registry entry, so no
 * requirement is silently dropped. Implementation status and verification
 * evidence live in features/status.json and are merged in by ID.
 *
 *   node scripts/generate-feature-registry.mjs          # write files
 *   node scripts/generate-feature-registry.mjs --check  # fail if files are stale (CI)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directive = readFileSync(resolve(root, 'docs/MASTER_DIRECTIVE.md'), 'utf8');
const statusFile = JSON.parse(readFileSync(resolve(root, 'features/status.json'), 'utf8'));
const meta = JSON.parse(readFileSync(resolve(root, 'features/modules.json'), 'utf8'));

const ALLOWED = ['Not started', 'Designed', 'Implementing', 'Implemented', 'Tested', 'Integration pending', 'External approval required', 'Blocked', 'Production ready'];

const lines = directive.split('\n');
const features = [];
let part = null;
let section = null;
const counters = {};

for (const raw of lines) {
  const line = raw.trim();
  const partMatch = /^PART (\d+) — (.+)$/.exec(line);
  if (partMatch) {
    part = { no: Number(partMatch[1]), title: partMatch[2].trim() };
    section = null;
    continue;
  }
  if (!part || !meta.modules[part.no]) continue;
  if (!line) continue;

  const bullet = /^\*\s+(.+)$/.exec(line) ?? /^\d+\.\s+(.+)$/.exec(line);
  const text = bullet ? bullet[1].trim() : line;
  // Non-bullet sentences ("Use fixed-precision decimal arithmetic.") are requirements too.
  const isStatement = !bullet && /\.$/.test(line) && line.length > 15;
  const isRule = isStatement || (bullet && /^(do not|never|must)\b/i.test(text));
  if (!bullet && !isRule) {
    // A short non-sentence line is a sub-heading (e.g. "Advanced AR AI", "India Module").
    if (line.length < 70 && !/[.:?"]$/.test(line)) section = line;
    continue;
  }
  const mod = meta.modules[part.no];
  counters[mod.code] = (counters[mod.code] ?? 0) + 1;
  const id = `${mod.code}-${String(counters[mod.code]).padStart(3, '0')}`;
  const description = text.replace(/\.$/, '');
  const st = statusFile.features[id] ?? {};
  if (st.status && !ALLOWED.includes(st.status)) throw new Error(`${id}: invalid status "${st.status}"`);
  const isAi = /\bAI\b|agent|predict|intelligen|anomaly|copilot|forecast|classif|recommend|detection/i.test(`${section ?? ''} ${description}`);
  features.push({
    id,
    module: mod.name,
    part: part.no,
    section: section ?? null,
    kind: isRule ? 'rule' : 'capability',
    description,
    priority: mod.priority,
    milestone: mod.milestone,
    dependencies: mod.dependencies,
    requirements: {
      database: mod.database,
      api: mod.api,
      ui: mod.ui,
      ai: isAi ? 'Deterministic logic computes all figures; AI explains, suggests or drafts behind the AI gateway with permission checks, prompt versioning and human approval for financial actions.' : 'None required',
      security: mod.security,
      tests: isRule ? 'Automated test proving the rule is enforced (positive and negative case).' : mod.tests,
    },
    status: st.status ?? 'Not started',
    evidence: st.evidence ?? [],
    notes: st.notes ?? null,
  });
}

for (const id of Object.keys(statusFile.features)) {
  if (!features.some((f) => f.id === id)) throw new Error(`features/status.json references unknown feature ${id}`);
}

const registry = {
  source: 'docs/MASTER_DIRECTIVE.md',
  generatedBy: 'scripts/generate-feature-registry.mjs',
  statusDefinitions: meta.statusDefinitions,
  total: features.length,
  features,
};

// ---------- Markdown renderings ----------
const byModule = new Map();
for (const f of features) {
  if (!byModule.has(f.module)) byModule.set(f.module, []);
  byModule.get(f.module).push(f);
}
const esc = (s) => String(s).replace(/\|/g, '\\|');

let inventory = `# Feature inventory\n\n_Generated from \`docs/MASTER_DIRECTIVE.md\` by \`scripts/generate-feature-registry.mjs\`. Do not edit by hand; edit \`features/status.json\` or \`features/modules.json\` and re-run \`pnpm features:generate\`._\n\n`;
inventory += `Total entries: **${features.length}** (${features.filter((f) => f.kind === 'capability').length} capabilities, ${features.filter((f) => f.kind === 'rule').length} rules) across ${byModule.size} modules.\n\n`;
inventory += `The machine-readable registry with per-feature database, API, UI, AI, security and test requirements is \`features/registry.json\`.\n\n`;
for (const [mod, fs] of byModule) {
  const m = Object.values(meta.modules).find((x) => x.name === mod);
  inventory += `## ${mod}\n\nPart ${fs[0].part} · ${m.milestone} · priority ${m.priority} · depends on: ${m.dependencies.join(', ') || 'none'}\n\n| ID | Section | Kind | Requirement | Status |\n|---|---|---|---|---|\n`;
  for (const f of fs) inventory += `| ${f.id} | ${esc(f.section ?? '')} | ${f.kind} | ${esc(f.description)} | ${f.status} |\n`;
  inventory += '\n';
}

const counts = Object.fromEntries(ALLOWED.map((s) => [s, features.filter((f) => f.status === s).length]));
let status = `# Feature status\n\n_Generated. Source of truth: \`features/status.json\` (status + evidence) merged into \`features/registry.json\`._\n\n`;
status += `A feature counts as **Implemented** only when its business logic, persistence, API **and UI** work. Backend-complete features without UI are reported as **Implementing** with evidence, never as Implemented.\n\n`;
status += `## Summary\n\n| Status | Count |\n|---|---|\n${ALLOWED.map((s) => `| ${s} | ${counts[s]} |`).join('\n')}\n| **Total** | **${features.length}** |\n\n`;
status += `## By module\n\n| Module | Milestone | Entries | Not started | In progress or later |\n|---|---|---|---|---|\n`;
for (const [mod, fs] of byModule) {
  const n = fs.filter((f) => f.status === 'Not started').length;
  status += `| ${mod} | ${fs[0].milestone} | ${fs.length} | ${n} | ${fs.length - n} |\n`;
}
const active = features.filter((f) => f.status !== 'Not started');
status += `\n## Features with progress and evidence\n\n`;
for (const f of active) {
  status += `### ${f.id} — ${f.description}\n\n- Module: ${f.module}\n- Status: **${f.status}**\n`;
  if (f.notes) status += `- Notes: ${f.notes}\n`;
  if (f.evidence.length) status += `- Evidence:\n${f.evidence.map((e) => `  - ${e}`).join('\n')}\n`;
  status += '\n';
}

const outputs = {
  'features/registry.json': JSON.stringify(registry, null, 2) + '\n',
  'docs/FEATURE_INVENTORY.md': inventory,
  'docs/FEATURE_STATUS.md': status,
};

if (process.argv.includes('--check')) {
  const stale = Object.entries(outputs).filter(([p, c]) => {
    try {
      return readFileSync(resolve(root, p), 'utf8') !== c;
    } catch {
      return true;
    }
  });
  if (stale.length) {
    console.error(`Stale generated files: ${stale.map(([p]) => p).join(', ')}. Run: pnpm features:generate`);
    process.exit(1);
  }
  console.log(`Feature registry up to date (${features.length} entries).`);
} else {
  for (const [p, c] of Object.entries(outputs)) writeFileSync(resolve(root, p), c);
  console.log(`Wrote ${features.length} entries: ${Object.keys(outputs).join(', ')}`);
  console.log(counts);
}

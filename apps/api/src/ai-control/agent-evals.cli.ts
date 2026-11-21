/**
 * Runs the AI agent evaluation (QA-014) against the configured Claude model and prints a report.
 *
 *   pnpm --filter @talk2tax/api agent-evals [--agents BANKING,CLOSE] [--model claude-…] [--min 0.8] [--out report.json]
 *
 * Needs ANTHROPIC_API_KEY (and ANTHROPIC_BASE_URL only for a stand-in). Each case is one request,
 * so a full run costs a few cents of tokens. Exits 1 when an answer passed an agent's checks but
 * was wrong, or an agent is below the minimum accuracy; 2 when it cannot run.
 */
import { writeFileSync } from 'node:fs';
import { AnthropicCopilotModel } from '../copilot/copilot.model';
import { runAgentEvals } from './agent-evals.runner';

const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args.set(argv[i].slice(2), argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');

async function main(): Promise<number> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error('ANTHROPIC_API_KEY is not set, so there is no model to evaluate.');
    return 2;
  }
  const model = args.get('model') ?? process.env.COPILOT_MODEL ?? 'claude-opus-5-5';
  const minAccuracy = Number(args.get('min') ?? 0.8);
  if (!(minAccuracy >= 0 && minAccuracy <= 1)) {
    console.error('--min is a share between 0 and 1, such as 0.8.');
    return 2;
  }
  const agents = args.get('agents')?.split(',').map((a) => a.trim().toUpperCase()).filter(Boolean);
  const report = await runAgentEvals(new AnthropicCopilotModel(key, process.env.ANTHROPIC_BASE_URL || undefined), { model, minAccuracy, agents });
  for (const g of report.grades) console.log(`${g.correct ? 'ok  ' : g.unsafe ? 'UNSAFE' : 'miss'}  ${g.caseId}: ${g.about}${g.notes.length || g.error ? `\n        ${[g.error, ...g.notes].filter(Boolean).join('\n        ')}` : ''}`);
  console.log(JSON.stringify({ model: report.model, score: report.score, inputTokens: report.inputTokens, outputTokens: report.outputTokens }, null, 2));
  const out = args.get('out');
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
  return report.score.passed ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(2);
  },
);

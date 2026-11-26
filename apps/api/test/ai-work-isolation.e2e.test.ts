import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../src/admin/admin.service';
import { AiWorkPoolService } from '../src/ai-work/ai-work-pool.service';
import type { CopilotModel, CopilotRequest, CopilotResponse } from '../src/copilot/copilot.model';
import { UsageService } from '../src/usage/usage.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * AI workload isolation (PERF-005) against the real API and database: every AI call goes through
 * the server's AI work lanes. Background work (bank line runs, reminders) never takes the last
 * places, people's calls go first, one organisation never runs more than its share, a call that
 * waits too long is turned away with AI_BUSY and its decision record says so, and System health
 * shows the lanes. Limits here: 3 at once, 1 background, 2 per organisation, 1 second to wait.
 */
let ctx: Ctx;
let owner: TestUser;
let support: TestUser;
let a: Awaited<ReturnType<typeof createOrg>>;
let b: Awaited<ReturnType<typeof createOrg>>;

/** A model whose answers wait until the test releases them, so that calls stay running. */
const held: (() => void)[] = [];
const model: CopilotModel = {
  provider: 'Test',
  send: (req: CopilotRequest) =>
    new Promise<CopilotResponse>((resolve) =>
      held.push(() =>
        resolve({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: String(req.model),
          content: [{ type: 'text', text: 'Done.', citations: null }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 2 },
        } as unknown as CopilotResponse),
      ),
    ),
};
const request = (tool?: string) =>
  ({
    model: 'claude-opus-5-5',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'Hello' }],
    ...(tool ? { tools: [{ name: tool, input_schema: { type: 'object' } }], tool_choice: { type: 'tool', name: tool } } : {}),
  }) as unknown as CopilotRequest;
const BANK = 'submit_suggestion';
const tick = () => new Promise((r) => setTimeout(r, 30));
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await tick();
  expect(check()).toBe(true);
}
const releaseAll = async () => {
  while (held.length) held.shift()!();
  await tick();
};

beforeAll(async () => {
  ctx = await bootApp({ AI_MAX_CONCURRENT: '3', AI_MAX_BACKGROUND: '1', AI_MAX_PER_ORG: '2', AI_WAIT_SECONDS: '1', AI_BACKGROUND_WAIT_SECONDS: '1' }, { copilotModel: model });
  owner = await registerUser(ctx, 'Isolation Owner');
  support = await registerUser(ctx, 'Isolation Support');
  await ctx.app.get(AdminService).grant(support.email, 'SUPPORT');
  a = await createOrg(ctx, owner, { name: 'AI Lanes A' });
  b = await createOrg(ctx, owner, { name: 'AI Lanes B' });
}, 60_000);
afterAll(async () => {
  await releaseAll();
  await ctx?.app.close();
});

describe('AI workload isolation', () => {
  const usage = () => ctx.app.get(UsageService);
  const pool = () => ctx.app.get(AiWorkPoolService);
  const send = (orgId: string, tool?: string) => usage().metered(orgId, model, 'SERVER').send(request(tool), { signal: new AbortController().signal });

  it('keeps background work to its lane and lets people go first', async () => {
    const run1 = send(a.orgId, BANK);
    await until(() => held.length === 1);
    // A second background call waits: background may take one place only.
    const run2 = send(b.orgId, BANK);
    await tick();
    expect(held).toHaveLength(1);
    expect(pool().status()).toMatchObject({ background: { running: 1, waiting: 1 }, interactive: { running: 0 } });
    // A person's call from another organisation starts at once.
    const ask = send(b.orgId);
    await until(() => held.length === 2);
    expect(pool().status().interactive.running).toBe(1);
    held.shift()!(); // the first bank call answers; the waiting one starts
    await until(() => held.length === 2 && pool().status().background.waiting === 0);
    await releaseAll();
    expect((await run1).stop_reason).toBe('end_turn');
    await Promise.all([run2, ask]);
    expect(pool().status().background).toMatchObject({ running: 0, waited: 1 });
  });

  it('keeps one organisation to its share and turns away a call that waits too long', async () => {
    const first = send(a.orgId);
    const second = send(a.orgId);
    await until(() => held.length === 2);
    const third = send(a.orgId).catch((e: Error & { code?: string; status?: number }) => e);
    // Another organisation is not held back by A's waiting call.
    const other = send(b.orgId);
    await until(() => held.length === 3);
    const busy = (await third) as Error & { code?: string; status?: number };
    expect(busy).toMatchObject({ code: 'AI_BUSY', status: 503 });
    expect(busy.constructor.name).toBe('AiBusyError');
    await releaseAll();
    await Promise.all([first, second, other]);
    expect(pool().status()).toMatchObject({ interactive: { running: 0, waiting: 0, turnedAway: 1 }, turnedAwayLast15Minutes: 1 });

    // The turned-away call is in the decision records, and AI performance names the reason.
    const perf = (await ctx.http().get(`${a.base}/ai-decisions/performance?days=7`).set(owner.auth).expect(200)).body;
    expect(perf.failures).toEqual([expect.objectContaining({ error: 'AiBusyError', count: 1 })]);
    // Only answered calls count against the plan.
    const answered = await ctx.prisma.usageEvent.count({ where: { orgId: a.orgId, kind: 'AI_CALL' } });
    expect(answered).toBe(3);
  });

  it('tells a person in the copilot that the AI is busy', async () => {
    await ctx.http().put(`${a.base}/copilot/settings`).set(owner.auth).send({ enabled: true }).expect(200);
    const hold1 = send(a.orgId);
    const hold2 = send(a.orgId);
    await until(() => held.length === 2);
    const c = (await ctx.http().post(`${a.base}/copilot/conversations`).set(owner.auth).send({ question: 'What is our cash?' }).expect(201)).body;
    let last: { status?: string; errorCode?: string } = {};
    for (let i = 0; i < 100 && last.status !== 'FAILED'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const done = (await ctx.http().get(`${a.base}/copilot/conversations/${c.id}`).set(owner.auth).expect(200)).body;
      last = done.messages[done.messages.length - 1];
    }
    expect(last).toMatchObject({ status: 'FAILED', errorCode: 'AI_BUSY' });
    await releaseAll();
    await Promise.all([hold1, hold2]);
  });

  it('shows the lanes in System health, for the platform team only', async () => {
    await ctx.http().get('/v1/admin/system').set(owner.auth).expect(403);
    const h = (await ctx.http().get('/v1/admin/system').set(support.auth).expect(200)).body;
    expect(h.ai).toMatchObject({ limits: { total: 3, background: 1, perOrg: 2 }, waitSeconds: { interactive: 1, background: 1 }, interactive: { running: 0, waiting: 0 }, background: { running: 0 } });
    expect(h.ai.turnedAwayLast15Minutes).toBeGreaterThanOrEqual(2);
    expect(h.problems).toEqual(expect.arrayContaining([expect.stringMatching(/AI calls were turned away in the last 15 minutes/)]));
  });

  it('refuses limits that leave no room for people', async () => {
    await expect(bootApp({ AI_MAX_CONCURRENT: '4', AI_MAX_BACKGROUND: '4' })).rejects.toThrow(/AI_MAX_BACKGROUND/);
  });
});

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { tenantStorage } from '../src/common/tenant-context';
import { WorkflowRunnerService } from '../src/workflows/workflow-runner.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Workflow recovery (QA-016), against the real API and database with two API processes on the
 * same database and a real webhook receiver. A runner that was down picks up what happened
 * meanwhile, once; two runners never act twice on one event; a pass that fails part-way leaves
 * nothing half done and is redone in full; a delivery claimed by a process that died is sent
 * again by another, as the same delivery; a lease held by a dead process runs out; and a schedule
 * that came round several times while the server was down acts once, not once per missed time.
 */
let a: Ctx;
let b: Ctx;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let customer: string;
let hookUrl: string;
let receiver: http.Server;
const received: { delivery: string; attempt: string; body: string }[] = [];
const replies: number[] = [];
const H = 3_600_000;
const T = new Date(Date.now() + 5.5 * H).toISOString().slice(0, 10);

const runner = (ctx: Ctx) => ctx.app.get(WorkflowRunnerService);
// As the server runs it: outside any request.
const tick = (ctx: Ctx, now?: Date) => tenantStorage.run({}, () => runner(ctx).tick(now ? { now } : {}));
const invoice = async (amount: string) =>
  (await a.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: customer, issueDate: T, dueDate: T, post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount }] }).expect(201)).body as { id: string; number: string };
const runsOf = async (id: string) => ((await a.http().get(`${org.base}/workflows/${id}/runs`).set(owner.auth).expect(200)).body as { id: string; status: string; link: { label: string } | null; occurrenceKey: string | null; actions: { status: string; attempts: number }[] }[]).filter((r) => r.status !== 'TEST');
const create = async (body: Record<string, unknown>) => {
  const w = (await a.http().post(`${org.base}/workflows`).set(owner.auth).send(body).expect(201)).body as { id: string };
  await a.http().post(`${org.base}/workflows/${w.id}/turn-on`).set(owner.auth).expect(200);
  return w.id;
};
const turnOff = (id: string) => a.http().post(`${org.base}/workflows/${id}/turn-off`).set(owner.auth).expect(200);

beforeAll(async () => {
  receiver = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (x: Buffer) => chunks.push(x));
    req.on('end', () => {
      received.push({ delivery: String(req.headers['t2t-delivery']), attempt: String(req.headers['t2t-attempt']), body: Buffer.concat(chunks).toString('utf8') });
      const status = replies.shift() ?? 200;
      res.writeHead(status).end(status === 200 ? 'ok' : 'busy');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
  // Two API processes on one database; neither runs on a timer here, so each pass is driven by hand.
  a = await bootApp({ WEBHOOK_ALLOW_PRIVATE_NETWORKS: 'true' });
  b = await bootApp({ WEBHOOK_ALLOW_PRIVATE_NETWORKS: 'true' });
  owner = await registerUser(a, 'Recovery Owner');
  org = await createOrg(a, owner, { name: 'Recovery Test Pvt Ltd' });
  customer = (await a.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Banyan Retail', isCustomer: true }).expect(201)).body.id;
});
afterAll(async () => {
  await a?.app.close();
  await b?.app.close();
  await new Promise((r) => receiver?.close(r));
});

describe('events', () => {
  let wf: string;

  it('acts once on everything that happened while no runner was going', async () => {
    wf = await create({ name: 'Every invoice', trigger: 'INVOICE_POSTED', conditions: [], actions: [{ type: 'WEBHOOK', url: hookUrl }] });
    await tick(a);
    const posted = [await invoice('100.00'), await invoice('200.00'), await invoice('300.00')];
    // The process that was down comes back (here: the other one).
    expect((await tick(b)).runs).toBe(3);
    expect((await tick(a)).runs).toBe(0);
    expect((await tick(b)).runs).toBe(0);
    const runs = await runsOf(wf);
    expect(runs.map((r) => r.link!.label).sort()).toEqual(posted.map((p) => `Invoice ${p.number}`).sort());
    expect(runs.every((r) => r.status === 'SUCCEEDED')).toBe(true);
    expect(received).toHaveLength(3);
    received.length = 0;
  });

  it('never acts twice when two runners go at once', async () => {
    for (const amount of ['401.00', '402.00', '403.00', '404.00']) await invoice(amount);
    const [x, y] = await Promise.all([tick(a), tick(b)]);
    expect(x.runs + y.runs).toBe(4);
    const runs = await runsOf(wf);
    expect(runs).toHaveLength(7);
    expect(new Set(runs.map((r) => r.link!.label)).size).toBe(7);
    // Each delivery went out once.
    expect(received).toHaveLength(4);
    expect(new Set(received.map((r) => r.delivery)).size).toBe(4);
    received.length = 0;
  });

  it('leaves nothing half done when a pass fails part-way, and redoes it in full', async () => {
    for (const amount of ['501.00', '502.00', '503.00']) await invoice(amount);
    const r = runner(a) as unknown as { startRun: (...args: unknown[]) => Promise<unknown> };
    const real = r.startRun.bind(r);
    let calls = 0;
    const spy = vi.spyOn(r, 'startRun').mockImplementation(async (...args: unknown[]) => {
      if (++calls === 2) throw new Error('The process stopped here');
      return real(...args);
    });
    try {
      expect((await tick(a)).runs).toBe(0);
    } finally {
      spy.mockRestore();
    }
    // The first run of that pass was rolled back with the rest, and the cursor did not move.
    expect(await runsOf(wf)).toHaveLength(7);
    expect((await tick(a)).runs).toBe(3);
    expect(await runsOf(wf)).toHaveLength(10);
    expect((await tick(b)).runs).toBe(0);
    received.length = 0;
  });

  it('waits for a lease another process holds, and takes it over when that process has died', async () => {
    await invoice('601.00');
    const leases = a.db.collection<{ _id: string; until: Date }>('_leases');
    const name = `workflow-events:${org.orgId}`;
    await leases.updateOne({ _id: name }, { $set: { until: new Date(Date.now() + 60_000) } }, { upsert: true });
    // A live holder: this pass leaves the organisation to it.
    expect((await tick(a)).runs).toBe(0);
    // The holder died without letting go: its lease runs out, and the next pass goes ahead.
    await leases.updateOne({ _id: name }, { $set: { until: new Date(Date.now() - 1000) } });
    expect((await tick(a)).runs).toBe(1);
    expect(await runsOf(wf)).toHaveLength(11);
    received.length = 0;
  });
});

describe('deliveries', () => {
  it('sends a delivery claimed by a process that died, as the same delivery, and not while the claim holds', async () => {
    replies.push(503);
    await invoice('701.00');
    await tick(a);
    expect(received).toHaveLength(1);
    const first = received[0];
    const actions = a.db.collection<{ _id: string; status: string; attempts: number; nextAttemptAt: Date | null; lockedUntil: Date | null }>('workflow_action_runs');
    const pending = await actions.findOne({ orgId: org.orgId, status: 'PENDING', type: 'WEBHOOK' } as never);
    expect(pending).toMatchObject({ attempts: 1 });
    // Another process claimed it and is (as far as anyone knows) still sending it.
    await actions.updateOne({ _id: pending!._id }, { $set: { nextAttemptAt: new Date(Date.now() - 1000), lockedUntil: new Date(Date.now() + 60_000) } });
    await tick(a);
    await tick(b);
    expect(received).toHaveLength(1);
    // That process died: its claim runs out and the delivery goes again, with the same id and bytes.
    await actions.updateOne({ _id: pending!._id }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });
    await tick(b);
    expect(received).toHaveLength(2);
    expect(received[1]).toEqual({ delivery: first.delivery, attempt: '2', body: first.body });
    const done = await actions.findOne({ _id: pending!._id });
    expect(done).toMatchObject({ status: 'SUCCEEDED', attempts: 2, lockedUntil: null });
    // And the run it belongs to is finished.
    const runs = await runsOf((await a.http().get(`${org.base}/workflows`).set(owner.auth).expect(200)).body.find((w: { name: string }) => w.name === 'Every invoice').id);
    expect(runs.every((r) => r.status === 'SUCCEEDED')).toBe(true);
    received.length = 0;
  });
});

describe('schedules', () => {
  it('acts once for a schedule that came round several times while the server was down', async () => {
    const all = (await a.http().get(`${org.base}/workflows`).set(owner.auth).expect(200)).body as { id: string; name: string }[];
    await turnOff(all.find((w) => w.name === 'Every invoice')!.id);
    const now = Date.now();
    const time = new Date(now + 5.5 * H + H).toISOString().slice(11, 16); // an hour from now, India time
    const wf = await create({ name: 'Daily ping', trigger: 'SCHEDULE', triggerParams: { frequency: 'DAILY', time }, conditions: [], actions: [{ type: 'WEBHOOK', url: hookUrl }] });
    await tick(a, new Date(now));
    expect(await runsOf(wf)).toEqual([]);
    // Down for three days: it came round three times. On the way back it acts for the latest only.
    const back = new Date(now + 3 * 24 * H + 2 * H);
    await Promise.all([tick(a, back), tick(b, back)]);
    await tick(b, back);
    const runs = await runsOf(wf);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('SUCCEEDED');
    expect(Date.parse(runs[0].occurrenceKey!.slice(3))).toBeGreaterThan(back.getTime() - 24 * H);
    expect(received).toHaveLength(1);
    // The next day comes round as usual.
    await tick(a, new Date(back.getTime() + 24 * H));
    expect(await runsOf(wf)).toHaveLength(2);
    await turnOff(wf);
  });
});

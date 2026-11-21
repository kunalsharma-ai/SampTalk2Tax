import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInOrg } from '../src/common/tenant-context';
import { attachments } from '../src/db/collections/sales';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Document versioning (AUDIT-007) against the real API and database: a new version of an attached
 * file replaces it in the list while the earlier one is kept and can still be opened; versions are
 * numbered in a single line (a file is replaced once, even when two uploads race); the history
 * shows who uploaded each and why; guards keep versions fixed; audited; permissions and tenant
 * isolation.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let journalId: string;
const T = today();
const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`);
type Version = { id: string; version: number; fileName: string; note: string | null; uploadedBy: string | null; current: boolean; replacedAt: string | null; sha256: string };
type Listed = { id: string; fileName: string; version: number; versionNote: string | null };

const A = () => `${org.base}/attachments`;
const upload = (user: TestUser, body: Buffer, fileName: string) => ctx.http().post(`${A()}?entityType=JOURNAL_ENTRY&entityId=${journalId}&fileName=${encodeURIComponent(fileName)}`).set(user.auth).set('content-type', 'application/pdf').send(body);
const newVersion = (user: TestUser, id: string, body: Buffer, fileName: string, note: string, base = A()) => ctx.http().post(`${base}/${id}/versions?fileName=${encodeURIComponent(fileName)}&note=${encodeURIComponent(note)}`).set(user.auth).set('content-type', 'application/pdf').send(body);
const list = async (user = owner) => (await ctx.http().get(`${A()}?entityType=JOURNAL_ENTRY&entityId=${journalId}`).set(user.auth).expect(200)).body as Listed[];

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Versions Owner');
  viewer = await registerUser(ctx, 'Versions Viewer');
  outsider = await registerUser(ctx, 'Versions Outsider');
  org = await createOrg(ctx, owner, { name: 'Versions Test Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Versions Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  journalId = (await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: T, post: true, memo: 'Rent', lines: [{ accountId: org.acc['6200'], debit: '5000' }, { accountId: org.acc['1120'], credit: '5000' }] }).expect(201)).body.id;
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('document versioning', () => {
  let v1: string;
  let v2: string;
  let v3: string;

  it('replaces a file with a new version and keeps the earlier one', async () => {
    v1 = (await upload(owner, pdf('rent agreement draft'), 'rent-agreement.pdf').expect(201)).body.id;
    expect(await list()).toMatchObject([{ id: v1, version: 1, versionNote: null }]);
    await newVersion(viewer, v1, pdf('rent agreement signed'), 'rent-agreement-signed.pdf', 'Signed copy').expect(403);
    expect((await newVersion(owner, v1, pdf('rent agreement draft'), 'same.pdf', 'Same bytes again').expect(409)).body.error).toBe('SAME_FILE');
    await newVersion(owner, v1, pdf('rent agreement signed'), 'x.pdf', 'ab').expect(400);
    expect((await newVersion(owner, v1, Buffer.from('not a pdf'), 'x.txt', 'Wrong file type').expect(415)).body.error).toBe('UNSUPPORTED_FILE');
    const r = (await newVersion(owner, v1, pdf('rent agreement signed'), 'rent-agreement-signed.pdf', 'Signed by both parties').expect(201)).body;
    v2 = r.id;
    expect(r).toMatchObject({ version: 2, versionNote: 'Signed by both parties', fileName: 'rent-agreement-signed.pdf' });
    expect(await list()).toMatchObject([{ id: v2, version: 2 }]);
    // The earlier version is kept, exactly as it was, and can still be opened.
    const old = await ctx.http().get(`${A()}/${v1}/content`).set(owner.auth).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); }).expect(200);
    expect((old.body as Buffer).toString()).toContain('rent agreement draft');
  });

  it('keeps the history in a single line, even when two uploads race', async () => {
    expect((await newVersion(owner, v1, pdf('another'), 'another.pdf', 'Replacing the old one').expect(409)).body.error).toBe('NOT_LATEST');
    const race = await Promise.all([newVersion(owner, v2, pdf('stamped A'), 'a.pdf', 'Stamped copy A'), newVersion(owner, v2, pdf('stamped B'), 'b.pdf', 'Stamped copy B')]);
    expect(race.map((x) => x.status).sort()).toEqual([201, 409]);
    v3 = race.find((x) => x.status === 201)!.body.id;
    const history = (await ctx.http().get(`${A()}/${v1}/versions`).set(viewer.auth).expect(200)).body as Version[];
    expect(history.map((h) => [h.version, h.current])).toEqual([[3, true], [2, false], [1, false]]);
    expect(history[1]).toMatchObject({ id: v2, note: 'Signed by both parties', uploadedBy: 'Versions Owner' });
    expect(history[2]!.replacedAt).not.toBeNull();
    expect(((await ctx.http().get(`${A()}/${v3}/versions`).set(owner.auth).expect(200)).body as Version[]).map((h) => h.id)).toEqual(history.map((h) => h.id));
    // Only one file in use on the journal; earlier versions do not count against the limit.
    expect((await list()).map((x) => x.id)).toEqual([v3]);
  });

  it('keeps versions fixed, audits each upload and removes only the version in use', async () => {
    await expect(runInOrg(org.orgId, () => ctx.store.collection(attachments).updateOne({ id: v2 }, { $set: { version: 9 } }))).rejects.toThrow(/keeps its version/);
    await expect(runInOrg(org.orgId, () => ctx.store.collection(attachments).updateOne({ id: v1 }, { $set: { replacedById: v3 } }))).rejects.toThrow(/replaced by a later version once/);
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=attachment`).set(owner.auth).expect(200)).body;
    const events = (audit.items ?? audit) as { action: string; data: { version?: number; replaces?: string } }[];
    expect(events.filter((e) => e.action === 'attachment.new_version').map((e) => e.data.version).sort()).toEqual([2, 3]);
    await ctx.http().post(`${A()}/${v3}/remove`).set(owner.auth).send({ reason: 'Uploaded to the wrong journal' }).expect(200);
    expect(await list()).toEqual([]);
    expect((await newVersion(owner, v3, pdf('after removal'), 'c.pdf', 'Trying after removal').expect(410)).body.error).toBe('REMOVED');
    const history = (await ctx.http().get(`${A()}/${v1}/versions`).set(owner.auth).expect(200)).body as Version[];
    expect(history).toHaveLength(3);
  });

  it('keeps each organisation to its own files', async () => {
    await ctx.http().get(`${A()}/${v1}/versions`).set(outsider.auth).expect(404);
    await ctx.http().get(`${other.base}/attachments/${v1}/versions`).set(outsider.auth).expect(404);
    await newVersion(outsider, v2, pdf('theirs'), 'theirs.pdf', 'Taking it over', `${other.base}/attachments`).expect(404);
  });
});

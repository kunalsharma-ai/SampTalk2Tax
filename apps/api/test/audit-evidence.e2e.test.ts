import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';
import { sqlWrite } from './sql-writes';

/**
 * AUDIT-028 against the real API and database: an audit event about a record that can hold
 * evidence files carries a reference (id, name, SHA-256) to each file attached at that moment.
 * The reference is hashed into the chain; removed files drop out of later events; other records
 * carry none; a file altered afterwards no longer matches the checksum its events recorded.
 */
const T = today();
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const PDF2 = Buffer.from('%PDF-1.4\n% delivery note\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let ctx: Ctx;
let owner: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let vendor: { id: string };

const upload = (entityType: string, entityId: string, body: Buffer, fileName: string) =>
  ctx.http().post(`${org.base}/attachments?entityType=${entityType}&entityId=${entityId}&fileName=${encodeURIComponent(fileName)}`).set(owner.auth).set('Content-Type', 'application/pdf').send(body);
const events = async (entityType: string, entityId: string) => {
  const r = (await ctx.http().get(`${org.base}/audit-events?entityType=${entityType}&entityId=${entityId}`).set(owner.auth).expect(200)).body;
  return (r.items ?? r) as { action: string; data: Record<string, unknown> | null }[];
};
const bill = async (post = false) =>
  (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: vendor.id, issueDate: T, dueDate: T, post, lines: [{ accountId: org.acc['6400'], quantity: '1', unitPrice: '2400.00' }] }).expect(201)).body;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Evidence Owner');
  outsider = await registerUser(ctx, 'Evidence Outsider');
  org = await createOrg(ctx, owner, { name: 'Evidence Refs Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Evidence Ltd' });
  vendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Highway Fuels', isVendor: true }).expect(201)).body;
});
afterAll(async () => {
  await ctx.app.close();
});

describe('evidence references on audit events', () => {
  it('records the files a bill had when it was posted, by name and checksum', async () => {
    const b = await bill();
    const created = (await events('document', b.id)).find((e) => e.action !== 'document.posted');
    expect(created?.data?.evidence).toBeUndefined();

    const a1 = (await upload('DOCUMENT', b.id, PDF, 'fuel receipt.pdf').expect(201)).body;
    const a2 = (await upload('DOCUMENT', b.id, PDF2, 'delivery note.pdf').expect(201)).body;
    await ctx.http().post(`${org.base}/purchases/documents/${b.id}/post`).set(owner.auth).send({}).expect(200);

    const posted = (await events('document', b.id)).find((e) => e.action === 'document.posted');
    expect(posted?.data?.evidence).toEqual([
      { attachmentId: a1.id, fileName: 'fuel receipt.pdf', sha256: sha(PDF) },
      { attachmentId: a2.id, fileName: 'delivery note.pdf', sha256: sha(PDF2) },
    ]);
    // The references are hashed into the chain like the rest of the event.
    expect((await ctx.http().get(`${org.base}/audit-events/verify`).set(owner.auth).expect(200)).body).toMatchObject({ valid: true });
  });

  it('leaves out files removed before the event', async () => {
    const b = await bill();
    const keep = (await upload('DOCUMENT', b.id, PDF, 'invoice copy.pdf').expect(201)).body;
    const drop = (await upload('DOCUMENT', b.id, PDF2, 'wrong file.pdf').expect(201)).body;
    await ctx.http().post(`${org.base}/attachments/${drop.id}/remove`).set(owner.auth).send({ reason: 'Uploaded to the wrong bill' }).expect(200);
    await ctx.http().post(`${org.base}/purchases/documents/${b.id}/post`).set(owner.auth).send({}).expect(200);
    const posted = (await events('document', b.id)).find((e) => e.action === 'document.posted');
    expect(posted?.data?.evidence).toEqual([{ attachmentId: keep.id, fileName: 'invoice copy.pdf', sha256: sha(PDF) }]);
  });

  it('adds nothing to events about records without files, or of other kinds', async () => {
    const b = await bill(true);
    expect((await events('document', b.id)).every((e) => !e.data || !('evidence' in e.data))).toBe(true);
    const all = (await ctx.http().get(`${org.base}/audit-events?limit=200`).set(owner.auth).expect(200)).body;
    const list = (all.items ?? all) as { entityType: string; data: Record<string, unknown> | null }[];
    expect(list.filter((e) => e.data && 'evidence' in e.data).every((e) => e.entityType === 'document')).toBe(true);
  });

  it('shows a file altered afterwards no longer matches its recorded checksum', async () => {
    const b = await bill();
    const a = (await upload('DOCUMENT', b.id, PDF, 'original.pdf').expect(201)).body;
    await ctx.http().post(`${org.base}/purchases/documents/${b.id}/post`).set(owner.auth).send({}).expect(200);
    const recorded = ((await events('document', b.id)).find((e) => e.action === 'document.posted')?.data?.evidence as { sha256: string }[])[0]!.sha256;
    // Attachments are immutable in the database; even a direct write is refused.
    await expect(sqlWrite(ctx, `UPDATE attachments SET sha256 = 'x' WHERE id = '${a.id}'`, [], { bypass: true })).rejects.toThrow();
    const served = await ctx.http().get(`${org.base}/attachments/${a.id}/content`).set(owner.auth).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); }).expect(200);
    expect(sha(served.body as Buffer)).toBe(recorded);
  });

  it('stays inside the organisation', async () => {
    const r = (await ctx.http().get(`${other.base}/audit-events?limit=200`).set(outsider.auth).expect(200)).body;
    expect(((r.items ?? r) as { data: Record<string, unknown> | null }[]).some((e) => e.data && 'evidence' in e.data)).toBe(false);
  });
});

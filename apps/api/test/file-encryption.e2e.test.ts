import { createHash, randomUUID } from 'node:crypto';
import { Binary } from '@talk2tax/document-db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../src/admin/admin.service';
import { FileVault } from '../src/files/file-vault';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Encryption at rest for uploaded files (SEC-011), against the real API and database: files are
 * stored sealed with AES-256-GCM and come back exactly as uploaded; a file stored before is
 * still read, counted as not encrypted and sealed from Platform admin → Encryption keys; and the
 * stored bytes can only ever be sealed again, never swapped or put back in plain.
 */
let ctx: Ctx;
let owner: TestUser;
let admin: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let billId: string;
const PDF = Buffer.from(`%PDF-1.4\n% private: PAN ABCPE1234F ${randomUUID()}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`);
const raw = (r: { on: (e: string, f: (c?: Buffer) => void) => void }, cb: (e: null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  r.on('data', (c?: Buffer) => chunks.push(c!));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
};
const download = (path: string) => ctx.http().get(path).set(owner.auth).buffer(true).parse(raw as never);
const day = (d: number) => new Date(Date.now() + 5.5 * 3_600_000 + d * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Vault Owner');
  admin = await registerUser(ctx, 'Vault Admin');
  await ctx.app.get(AdminService).grant(admin.email, 'SUPER_ADMIN');
  org = await createOrg(ctx, owner, { name: `Sealed Files ${randomUUID().slice(0, 6)} Ltd` });
  const vendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Vault Supplies', isVendor: true }).expect(201)).body.id;
  billId = (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: vendor, issueDate: today(), reference: 'VAULT-1', lines: [{ accountId: org.acc['6600'], quantity: '1', unitPrice: '100.00' }] }).expect(201)).body.id;
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('encryption at rest', () => {
  it('stores attachments sealed, and gives them back exactly as uploaded', async () => {
    const a = (await ctx.http().post(`${org.base}/attachments?entityType=DOCUMENT&entityId=${billId}&fileName=bill.pdf`).set(owner.auth).set('Content-Type', 'application/pdf').send(PDF).expect(201)).body;
    const stored = await ctx.db.collection('attachments').findOne({ _id: a.id });
    const bytes = Buffer.from((stored!.content as Binary).buffer);
    expect(stored!.contentKeyId).toBe(ctx.app.get(FileVault).box.keyId);
    expect(bytes.length).toBe(PDF.length + 33);
    expect(bytes.includes(Buffer.from('ABCPE1234F'))).toBe(false);
    expect(stored!.sha256).toBe(createHash('sha256').update(PDF).digest('hex'));
    const dl = await download(`${org.base}/attachments/${a.id}/content`).expect(200);
    expect(Buffer.compare(dl.body as Buffer, PDF)).toBe(0);

    // The stored bytes cannot be swapped, put back in plain, or changed behind the API's back.
    const col = ctx.store.collection((await import('../src/db/collections/sales')).attachments);
    const { runInOrg } = await import('../src/common/tenant-context');
    await expect(runInOrg(org.orgId, () => col.updateOne({ id: a.id }, { $set: { content: PDF, contentKeyId: null } }))).rejects.toThrow(/cannot be changed|size is its content/);
    const flipped = Buffer.from(bytes);
    flipped[flipped.length - 1] ^= 0xff;
    await expect(runInOrg(org.orgId, () => col.updateOne({ id: a.id }, { $set: { content: flipped } }))).rejects.toThrow(/cannot be changed/);
    // Changed in the database directly, the file is refused rather than served.
    await ctx.db.collection('attachments').updateOne({ _id: a.id }, { $set: { content: new Binary(flipped) } });
    expect((await ctx.http().get(`${org.base}/attachments/${a.id}/content`).set(owner.auth).expect(500)).body.error).toBe('FILE_DAMAGED');
    await ctx.db.collection('attachments').updateOne({ _id: a.id }, { $set: { content: new Binary(bytes) } });
    await download(`${org.base}/attachments/${a.id}/content`).expect(200);
  });

  it('stores tax notice files sealed', async () => {
    const n = (await ctx.http().post(`${org.base}/tax-notices`).set(owner.auth).send({ authority: 'GST', reference: `ZD${randomUUID().slice(0, 10)}`, section: 'ASMT-10', subject: 'Synthetic notice for encryption', period: '2025-26', receivedOn: day(-3), responseDue: day(10), demand: '100.00' }).expect(201)).body;
    const c = (await ctx.http().post(`${org.base}/tax-notices/${n.id}/files?fileName=asmt.pdf`).set(owner.auth).set('Content-Type', 'application/pdf').send(PDF).expect(201)).body;
    const stored = await ctx.db.collection('tax_notice_files').findOne({ noticeId: n.id });
    expect(stored!.contentKeyId).toBe(ctx.app.get(FileVault).box.keyId);
    expect(Buffer.from((stored!.content as Binary).buffer).includes(Buffer.from('ABCPE1234F'))).toBe(false);
    const dl = await download(`${org.base}/tax-notices/${n.id}/files/${c.files[0].id}/content`).expect(200);
    expect(Buffer.compare(dl.body as Buffer, PDF)).toBe(0);
  });

  it('reads files stored before, counts them, and seals them from Encryption keys', async () => {
    // A file stored before encryption at rest: plain bytes and no key id.
    const old = (await ctx.http().post(`${org.base}/attachments?entityType=DOCUMENT&entityId=${billId}&fileName=old.pdf`).set(owner.auth).set('Content-Type', 'application/pdf').send(Buffer.concat([PDF, Buffer.from('% old\n')])).expect(201)).body;
    const plain = Buffer.concat([PDF, Buffer.from('% old\n')]);
    await ctx.db.collection('attachments').updateOne({ _id: old.id }, { $set: { content: new Binary(plain) }, $unset: { contentKeyId: '' } });
    expect(Buffer.compare((await download(`${org.base}/attachments/${old.id}/content`).expect(200)).body as Buffer, plain)).toBe(0);

    const before = (await ctx.http().get('/v1/admin/encryption-keys').set(admin.auth).expect(200)).body;
    const files = before.files.find((f: { key: string }) => f.key === 'attachments');
    expect(files.unencrypted).toBeGreaterThanOrEqual(1);
    expect(before.fileTotals.unencrypted).toBeGreaterThanOrEqual(1);

    const after = (await ctx.http().post('/v1/admin/encryption-keys/reseal').set(admin.auth).expect(200)).body;
    expect(after.filesSealed.attachments).toBeGreaterThanOrEqual(1);
    expect(after.fileTotals.unencrypted).toBe(0);
    const stored = await ctx.db.collection('attachments').findOne({ _id: old.id });
    expect(stored!.contentKeyId).toBe(ctx.app.get(FileVault).box.keyId);
    expect(Buffer.compare((await download(`${org.base}/attachments/${old.id}/content`).expect(200)).body as Buffer, plain)).toBe(0);
    const audit = await ctx.prisma.auditEvent.findFirst({ where: { action: 'platform.secrets_resealed', actorId: admin.id }, orderBy: { createdAt: 'desc' } });
    expect((audit!.data as { files: Record<string, number> }).files.attachments).toBeGreaterThanOrEqual(1);
  });
});

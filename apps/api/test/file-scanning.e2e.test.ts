import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EICAR, startClamdStandIn, type ClamdStandIn } from '../../../test-support/clamd-stand-in.mjs';
import { AdminService } from '../src/admin/admin.service';
import { pdfActiveContent } from '../src/files/inspect';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Upload checks and malware scanning (SEC-018/019) against the real API and database, and a local
 * stand-in for ClamAV's daemon (test-support/clamd-stand-in.mjs): PDFs that can run code are
 * refused even without a scanner; with a scanner, files with a virus signature are refused, and
 * every upload is refused while the scanner cannot answer. Each check is recorded, each refusal
 * audited, refused files are not kept, and platform admins see the scanner's state.
 */
const CLAMD_PORT = 4570;
let clamd: ClamdStandIn;
let scanned: Ctx;
let plain: Ctx;
let admin: TestUser;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let billId: string;

const PDF = (body: string) => Buffer.from(`%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R ${body} >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');
const CLEAN = PDF('');
const upload = (ctx: Ctx, body: Buffer, fileName: string) =>
  ctx.http().post(`${org.base}/attachments?entityType=DOCUMENT&entityId=${billId}&fileName=${encodeURIComponent(fileName)}`).set(owner.auth).set('Content-Type', 'application/pdf').send(body);

beforeAll(async () => {
  clamd = await startClamdStandIn(CLAMD_PORT);
  scanned = await bootApp({ CLAMAV_URL: `tcp://127.0.0.1:${CLAMD_PORT}`, CLAMAV_TIMEOUT_SECONDS: '3' });
  plain = await bootApp({ CLAMAV_URL: '' });
  admin = await registerUser(scanned, 'Scan Admin');
  owner = await registerUser(scanned, 'Scan Owner');
  await scanned.app.get(AdminService).grant(admin.email, 'SUPER_ADMIN');
  org = await createOrg(scanned, owner, { name: 'Scanned Uploads Ltd' });
  const vendor = (await scanned.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Scan Supplies', isVendor: true }).expect(201)).body.id;
  billId = (await scanned.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: vendor, issueDate: today(), reference: 'SCAN-1', lines: [{ accountId: org.acc['6600'], quantity: '1', unitPrice: '100.00' }] }).expect(201)).body.id;
});
afterAll(async () => {
  await scanned?.app.close();
  await plain?.app.close();
  await clamd?.close();
});

describe('upload checks', () => {
  it('finds active content in PDFs, also when escaped or compressed', () => {
    expect(pdfActiveContent(CLEAN)).toEqual([]);
    expect(pdfActiveContent(PDF('/URI (https://example.test) /OpenAction 3 0 R'))).toEqual([]);
    expect(pdfActiveContent(PDF('/OpenAction << /S /JavaScript /JS (app.alert(1)) >>'))).toEqual(['JavaScript', 'JS']);
    expect(pdfActiveContent(PDF('/AA << /O << /S /J#61vaScript >> >>'))).toEqual(['JavaScript']);
    expect(pdfActiveContent(PDF('/Names << /EmbeddedFiles 4 0 R >>'))).toEqual(['EmbeddedFiles']);
    expect(pdfActiveContent(PDF('/JSONData 1'))).toEqual([]);
    const hidden = deflateSync(Buffer.from('<< /Type /Action /S /Launch /F (cmd.exe) >>'));
    const objStm = Buffer.concat([Buffer.from('%PDF-1.7\n5 0 obj << /Type /ObjStm /Filter /FlateDecode >>\nstream\n', 'latin1'), hidden, Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1')]);
    expect(pdfActiveContent(objStm)).toEqual(['Launch']);
  });

  it('refuses a PDF that can run code, without a scanner too', async () => {
    const r = await upload(plain, PDF('/OpenAction << /S /JavaScript /JS (app.alert(1)) >>'), 'scripted.pdf').expect(422);
    expect(r.body).toMatchObject({ error: 'FILE_ACTIVE_CONTENT', message: expect.stringMatching(/JavaScript, JS/) });
    await upload(plain, CLEAN, 'plain.pdf').expect(201);
    const scans = await plain.prisma.fileScan.findMany({ where: { orgId: org.orgId }, orderBy: { createdAt: 'asc' } });
    expect(scans.map((s) => [s.fileName, s.result])).toEqual([
      ['scripted.pdf', 'ACTIVE_CONTENT'],
      ['plain.pdf', 'NOT_SCANNED'],
    ]);
    const refused = await plain.prisma.auditEvent.findFirst({ where: { orgId: org.orgId, action: 'file.refused' } });
    expect(refused?.data).toMatchObject({ source: 'ATTACHMENT', fileName: 'scripted.pdf', result: 'ACTIVE_CONTENT' });
    // Not kept.
    expect((await plain.http().get(`${org.base}/attachments?entityType=DOCUMENT&entityId=${billId}`).set(owner.auth).expect(200)).body.map((a: { fileName: string }) => a.fileName)).toEqual(['plain.pdf']);
  });

  it('scans every upload with the virus scanner, and refuses infected files', async () => {
    const before = clamd.scanned;
    await upload(scanned, PDF('/Producer (Tally)'), 'clean-bill.pdf').expect(201);
    const infected = await upload(scanned, PDF(`/Title (${EICAR})`), 'invoice.pdf').expect(422);
    expect(infected.body).toMatchObject({ error: 'FILE_INFECTED', message: expect.stringMatching(/Eicar-Test-Signature/) });
    expect(clamd.scanned - before).toBe(2);
    // Tax notices' files too.
    const notice = (await scanned.http().post(`${org.base}/tax-notices`).set(owner.auth).send({ authority: 'GST', reference: 'SCAN-1', section: 'ASMT-10', subject: 'Synthetic notice', period: '2025-26', receivedOn: today(), responseDue: today(), demand: '0.00' }).expect(201)).body;
    expect((await scanned.http().post(`${org.base}/tax-notices/${notice.id}/files?fileName=notice.pdf`).set(owner.auth).set('Content-Type', 'application/pdf').send(PDF(`/Subject (${EICAR})`)).expect(422)).body.error).toBe('FILE_INFECTED');
    const scans = await scanned.prisma.fileScan.findMany({ where: { orgId: org.orgId, result: { in: ['CLEAN', 'INFECTED'] } }, orderBy: { createdAt: 'asc' } });
    expect(scans.map((s) => [s.source, s.fileName, s.result, s.detail])).toEqual([
      ['ATTACHMENT', 'clean-bill.pdf', 'CLEAN', null],
      ['ATTACHMENT', 'invoice.pdf', 'INFECTED', 'Eicar-Test-Signature'],
      ['TAX_NOTICE', 'notice.pdf', 'INFECTED', 'Eicar-Test-Signature'],
    ]);
    expect(scans[0]!.engine).toMatch(/^ClamAV 1\.4\.1/);
  });

  it('refuses uploads while the scanner cannot answer', async () => {
    clamd.mode = 'error';
    try {
      expect((await upload(scanned, PDF('/Producer (Busy)'), 'busy.pdf').expect(503)).body.error).toBe('FILE_SCAN_UNAVAILABLE');
    } finally {
      clamd.mode = 'ok';
    }
    const failed = await scanned.prisma.fileScan.findFirst({ where: { orgId: org.orgId, fileName: 'busy.pdf' } });
    expect(failed).toMatchObject({ result: 'SCAN_FAILED', detail: expect.stringMatching(/ERROR/) });
  });

  it('shows platform admins the scanner and the refused files', async () => {
    await scanned.http().get('/v1/admin/file-scanning').set(owner.auth).expect(403);
    const r = (await scanned.http().get('/v1/admin/file-scanning').set(admin.auth).expect(200)).body;
    expect(r.scanner).toMatchObject({ configured: true, ok: true, version: expect.stringMatching(/^ClamAV/) });
    expect(r.last30Days.INFECTED).toBeGreaterThanOrEqual(2);
    expect(r.refused.find((x: { fileName: string }) => x.fileName === 'invoice.pdf')).toMatchObject({ organisation: 'Scanned Uploads Ltd', source: 'Attachments', result: 'INFECTED', detail: 'Eicar-Test-Signature' });
    const off = (await plain.http().get('/v1/admin/file-scanning').set(admin.auth).expect(200)).body;
    expect(off.scanner).toEqual({ configured: false, ok: false, version: null, error: null });
  });
});

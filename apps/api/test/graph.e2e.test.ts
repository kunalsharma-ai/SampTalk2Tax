import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * The relationship graph and figure tracing against the real API and database: a customer, its
 * invoice tagged with a project, the receipt that settles it, a vendor bill, a manual journal and
 * an overdue-invoice alert, connected and explained; the general ledger saying which record
 * created each line; permissions and tenant isolation.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let employee: TestUser;
let outsider: TestUser;
type Org = Awaited<ReturnType<typeof createOrg>>;
let org: Org;
let other: Org;
const T = today();
const addDays = (iso: string, d: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
const ids: Record<string, string> = {};
type Edge = { relation: string; explanation: string; node: { type: string; id: string; label: string; path: string | null } };
const node = async (type: string, id: string, who: TestUser = viewer) => (await ctx.http().get(`${org.base}/graph/nodes/${type}/${id}`).set(who.auth).expect(200)).body as { node: Edge['node'] & { subtitle: string }; edges: Edge[]; more: { relation: string; count: number }[] };
const edge = (edges: Edge[], relation: string, id: string) => edges.find((e) => e.relation === relation && e.node.id === id);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Graph Owner');
  viewer = await registerUser(ctx, 'Graph Viewer');
  employee = await registerUser(ctx, 'Graph Employee');
  outsider = await registerUser(ctx, 'Graph Outsider');
  org = await createOrg(ctx, owner, { name: 'Graph Traders Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Graph Co' });
  for (const [u, role] of [[viewer, 'VIEWER'], [employee, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  const post = async (path: string, body: Record<string, unknown>) => (await ctx.http().post(`${org.base}${path}`).set(owner.auth).send(body).expect(201)).body;
  ids.acme = (await post('/contacts', { name: 'Acme Retail', isCustomer: true, email: 'ap@acme.test' })).id;
  ids.granite = (await post('/contacts', { name: 'Granite Supplies', isVendor: true })).id;
  ids.project = (await post('/dimensions', { type: 'PROJECT', code: 'WH-AUTO', name: 'Warehouse automation' })).id;
  const inv = await post('/sales/documents', { kind: 'INVOICE', contactId: ids.acme, issueDate: addDays(T, -40), dueDate: addDays(T, -10), post: true, lines: [{ accountId: org.acc['4100'], description: 'Conveyor design', quantity: '1', unitPrice: '100000.00', projectId: ids.project }, { accountId: org.acc['4100'], description: 'Support', quantity: '1', unitPrice: '20000.00' }] });
  ids.invoice = inv.id;
  ids.invoiceNumber = inv.number;
  ids.invoiceEntry = inv.journalEntryId;
  const inv2 = await post('/sales/documents', { kind: 'INVOICE', contactId: ids.acme, issueDate: addDays(T, -70), dueDate: addDays(T, -40), post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '50000.00' }] });
  ids.overdue = inv2.id;
  const rec = await post('/sales/payments', { contactId: ids.acme, date: addDays(T, -5), bankAccountId: org.acc['1120'], amount: '60000.00', allocations: [{ documentId: ids.invoice, amount: '60000.00' }], post: true });
  ids.receipt = rec.id;
  ids.receiptNumber = rec.number;
  const bill = await post('/purchases/documents', { kind: 'BILL', contactId: ids.granite, issueDate: addDays(T, -3), post: true, lines: [{ accountId: org.acc['6400'], quantity: '1', unitPrice: '8000.00', projectId: ids.project }] });
  ids.bill = bill.id;
  const j = await post('/journals', { date: addDays(T, -2), memo: 'Site visit costs', post: true, lines: [{ accountId: org.acc['6400'], debit: '1500.00', projectId: ids.project }, { accountId: org.acc['1120'], credit: '1500.00' }] });
  ids.journal = j.id;
  await ctx.http().post(`${org.base}/alerts/scan`).set(owner.auth).expect(200);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('relationship graph', () => {
  it('finds records to start from by name or number', async () => {
    const r = (await ctx.http().get(`${org.base}/graph/search?q=acme`).set(viewer.auth).expect(200)).body;
    expect(r[0]).toMatchObject({ type: 'CONTACT', id: ids.acme, label: 'Acme Retail', subtitle: 'Customer' });
    const n = (await ctx.http().get(`${org.base}/graph/search?q=${ids.invoiceNumber}`).set(viewer.auth).expect(200)).body;
    expect(n.find((x: { id: string }) => x.id === ids.invoice)).toMatchObject({ type: 'DOCUMENT', label: ids.invoiceNumber, path: `/sales/invoices/${ids.invoice}` });
    const w = (await ctx.http().get(`${org.base}/graph/search?q=wh-auto`).set(viewer.auth).expect(200)).body;
    expect(w).toEqual([expect.objectContaining({ type: 'PROJECT', id: ids.project, label: 'WH-AUTO Warehouse automation' })]);
    expect((await ctx.http().get(`${org.base}/graph/search?q=a`).set(viewer.auth).expect(200)).body).toEqual([]);
  });

  it('connects a customer to its invoices, payments, projects and alerts, and says why', async () => {
    const g = await node('CONTACT', ids.acme);
    expect(g.node).toMatchObject({ type: 'CONTACT', label: 'Acme Retail', path: `/sales/customers/${ids.acme}` });
    expect(edge(g.edges, 'ISSUED_TO', ids.invoice)!.explanation).toBe(`Invoice ${ids.invoiceNumber} for ₹1,20,000.00 was issued to Acme Retail.`);
    expect(edge(g.edges, 'PAID_BY', ids.receipt)!.explanation).toMatch(new RegExp(`^Acme Retail paid ₹60,000.00 \\(${ids.receiptNumber}\\) on `));
    expect(edge(g.edges, 'WORKS_ON', ids.project)!.explanation).toBe("1 line on Acme Retail's posted documents, ₹1,00,000.00 before tax, is tagged with project WH-AUTO.");
    const alert = g.edges.find((e) => e.relation === 'FLAGGED_BY');
    expect(alert!.explanation).toMatch(/lists it as evidence/);
    expect(alert!.node.type).toBe('ALERT');
    ids.alert = alert!.node.id;
  });

  it('connects an invoice to its journal, the receipt that settled it, its accounts and project', async () => {
    const g = await node('DOCUMENT', ids.invoice);
    expect(g.node.subtitle).toMatch(/^Invoice, .*₹1,20,000.00$/);
    expect(edge(g.edges, 'ISSUED_TO', ids.acme)).toBeDefined();
    expect(edge(g.edges, 'POSTED_BY', ids.invoiceEntry)!.explanation).toMatch(new RegExp(`^JE-\\d{6} put Invoice ${ids.invoiceNumber} into the ledger on `));
    expect(edge(g.edges, 'SETTLED_BY', ids.receipt)!.explanation).toMatch(new RegExp(`^${ids.receiptNumber} settled ₹60,000.00 of Invoice ${ids.invoiceNumber} on `));
    expect(edge(g.edges, 'BOOKED_TO', org.acc['4100']!)!.explanation).toBe('₹1,20,000.00 of its lines, before tax, is income in 4100 Sales Revenue.');
    expect(edge(g.edges, 'FOR_PROJECT', ids.project)!.explanation).toBe('1 line (₹1,00,000.00) is tagged with project WH-AUTO.');
  });

  it('connects a payment, a journal entry and an account', async () => {
    const p = await node('PAYMENT', ids.receipt);
    expect(edge(p.edges, 'SETTLES', ids.invoice)!.explanation).toBe(`₹60,000.00 of ${ids.receiptNumber} settled Invoice ${ids.invoiceNumber}.`);
    expect(edge(p.edges, 'DEPOSITED_TO', org.acc['1120']!)).toBeDefined();
    const e = await node('JOURNAL', ids.invoiceEntry);
    expect(e.edges.find((x) => x.relation === 'CREATED_BY')).toMatchObject({ explanation: expect.stringMatching(new RegExp(`posts ${ids.invoiceNumber}\\.$`)), node: { type: 'DOCUMENT', id: ids.invoice } });
    expect(edge(e.edges, 'CREDITS', org.acc['4100']!)!.explanation).toBe('Credits 4100 Sales Revenue with ₹1,20,000.00.');
    const manual = await node('JOURNAL', ids.journal);
    expect(manual.edges.find((x) => x.relation === 'CREATED_BY')).toBeUndefined();
    expect(edge(manual.edges, 'FOR_PROJECT', ids.project)).toBeDefined();
    const a = await node('ACCOUNT', org.acc['4100']!);
    expect(edge(a.edges, 'POSTED_IN', ids.invoiceEntry)!.explanation).toMatch(/ credits it with ₹1,20,000.00\.$/);
  });

  it('connects a project to its customers, documents and journal entries', async () => {
    const g = await node('PROJECT', ids.project);
    expect(edge(g.edges, 'WORKS_ON', ids.acme)!.explanation).toBe("1 of Acme Retail's documents has lines tagged with this project.");
    expect(edge(g.edges, 'WORKS_ON', ids.granite)).toBeDefined();
    expect(edge(g.edges, 'FOR_PROJECT', ids.bill)!.explanation).toMatch(/^1 line of Bill .* \(₹8,000.00 before tax\) is tagged with this project\.$/);
    expect(edge(g.edges, 'TAGGED_IN', ids.journal)).toBeDefined();
    await ctx.http().get(`${org.base}/graph/nodes/DEPARTMENT/${ids.project}`).set(viewer.auth).expect(404);
  });

  it('connects an alert to its evidence', async () => {
    const g = await node('ALERT', ids.alert!);
    expect(g.edges.some((e) => e.relation === 'EVIDENCE' && e.node.id === ids.overdue)).toBe(true);
  });

  it('is limited to members who can read reports and both ledgers, within the organisation', async () => {
    await ctx.http().get(`${org.base}/graph/nodes/CONTACT/${ids.acme}`).set(employee.auth).expect(403);
    await ctx.http().get(`${org.base}/graph/search?q=acme`).set(outsider.auth).expect(404);
    await ctx.http().get(`${other.base}/graph/nodes/CONTACT/${ids.acme}`).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/graph/search?q=acme`).set(outsider.auth).expect(200)).body).toEqual([]);
    await ctx.http().get(`${org.base}/graph/nodes/WIDGET/${ids.acme}`).set(viewer.auth).expect(400);
  });
});

describe('tracing a figure', () => {
  it('says which record created each line of the general ledger', async () => {
    const gl = (await ctx.http().get(`${org.base}/reports/general-ledger?accountId=${org.acc['6400']}&from=${addDays(T, -60)}&to=${T}`).set(viewer.auth).expect(200)).body;
    expect(gl.closingBalance).toBe('9500.00');
    const sources = gl.rows.map((r: { source: unknown }) => r.source);
    expect(sources).toEqual([{ type: 'DOCUMENT', id: ids.bill, label: expect.any(String), path: `/purchases/bills/${ids.bill}`, role: 'posts' }, null]);
    const bank = (await ctx.http().get(`${org.base}/reports/general-ledger?accountId=${org.acc['1120']}&from=${addDays(T, -60)}&to=${T}`).set(viewer.auth).expect(200)).body;
    expect(bank.rows[0].source).toMatchObject({ type: 'PAYMENT', id: ids.receipt, label: ids.receiptNumber, path: `/sales/receipts/${ids.receipt}` });
  });
});

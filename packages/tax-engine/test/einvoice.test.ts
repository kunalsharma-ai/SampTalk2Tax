import { describe, expect, it } from 'vitest';
import { buildEInvoice, cancellable, EInvoiceInput, irpDateToIso, matchIrpResponse, parseIrpResponse, reportingDeadline } from '../src';

const SELLER = '27ZZZCE0011Z1ZV';
const BUYER = '29ZZZCB0012Z1Z5';
const input = (over: Partial<EInvoiceInput> = {}): EInvoiceInput => ({
  kind: 'INVOICE',
  number: 'INV-000042',
  issueDate: '2026-10-12',
  currency: 'INR',
  placeOfSupply: '29',
  seller: { gstin: SELLER, legalName: 'Northwind Traders Private Limited', address1: '12 MG Road', location: 'Pune', pincode: '411001' },
  buyer: { gstin: BUYER, legalName: 'Karnataka Metals LLP', address1: '4 Residency Road', location: 'Bengaluru', pincode: '560025' },
  lines: [
    { description: 'Steel brackets', hsnCode: '73269099', quantity: '3', unitPrice: '1000', netAmount: '3000', gstRate: '18', cgst: '0', sgst: '0', igst: '540' },
    { description: 'Installation', hsnCode: '995461', quantity: '1', unitPrice: '1000', netAmount: '1000', gstRate: '18', cgst: '0', sgst: '0', igst: '180' },
  ],
  otherCharges: '0',
  total: '4720',
  goodsUnit: 'NOS',
  ...over,
});

/** An unsigned token with the IRP's shape, for tests only. */
const token = (data: unknown) => `e30.${Buffer.from(JSON.stringify({ data: JSON.stringify(data) })).toString('base64url')}.c2ln`;

describe('INV-01 payload', () => {
  it('builds the schema 1.1 JSON for an inter-state B2B invoice', () => {
    const { payload, issues } = buildEInvoice(input());
    expect(issues).toEqual([]);
    expect(payload).toMatchObject({
      Version: '1.1',
      TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N' },
      DocDtls: { Typ: 'INV', No: 'INV-000042', Dt: '12/10/2026' },
      SellerDtls: { Gstin: SELLER, Stcd: '27', Pin: 411001, Loc: 'Pune' },
      BuyerDtls: { Gstin: BUYER, Stcd: '29', Pos: '29' },
      ValDtls: { AssVal: 4000, IgstVal: 720, CgstVal: 0, SgstVal: 0, OthChrg: 0, TotInvVal: 4720 },
    });
    const items = (payload as { ItemList: Record<string, unknown>[] }).ItemList;
    expect(items[0]).toMatchObject({ SlNo: '1', IsServc: 'N', HsnCd: '73269099', Qty: 3, Unit: 'NOS', UnitPrice: 1000, TotAmt: 3000, AssAmt: 3000, GstRt: 18, IgstAmt: 540, TotItemVal: 3540 });
    expect(items[1]).toMatchObject({ IsServc: 'Y', HsnCd: '995461', TotItemVal: 1180 });
    expect(items[1]).not.toHaveProperty('Unit');
  });

  it('reports TCS as other charges and marks a credit note CRN', () => {
    const { payload } = buildEInvoice(input({ kind: 'CREDIT_NOTE', number: 'CN-000001', otherCharges: '4', total: '4724' }));
    expect(payload).toMatchObject({ DocDtls: { Typ: 'CRN' }, ValDtls: { OthChrg: 4, TotInvVal: 4724 } });
  });

  it('lists everything the IRP would reject', () => {
    const { payload, issues } = buildEInvoice(
      input({
        number: '0INV/2026/000000042',
        placeOfSupply: '96',
        buyer: { gstin: BUYER, legalName: 'KM', address1: '', location: 'B', pincode: '56002' },
        lines: [{ description: 'x', hsnCode: '99', quantity: '1', unitPrice: '100', netAmount: '100', gstRate: '17', cgst: '0', sgst: '0', igst: '17' }],
        total: '500',
      }),
    );
    expect(payload).toBeNull();
    expect(issues.map((i) => i.field)).toEqual(['number', 'placeOfSupply', 'buyer.legalName', 'buyer.address1', 'buyer.location', 'buyer.pincode', 'lines.1.hsnCode', 'lines.1.gstRate', 'total']);
  });
});

describe('time limits', () => {
  it('gives the 30-day reporting deadline only for AATO of Rs 10 crore or more', () => {
    expect(reportingDeadline('2025-04-01', true)).toBe('2025-04-30');
    expect(reportingDeadline('2026-10-12', true)).toBe('2026-11-10');
    expect(reportingDeadline('2026-10-12', false)).toBeNull();
  });
  it('allows cancellation within 24 hours of the acknowledgement', () => {
    expect(cancellable('2026-10-12T14:03:00+05:30', '2026-10-13T14:03:00+05:30')).toBe(true);
    expect(cancellable('2026-10-12T14:03:00+05:30', '2026-10-13T14:03:01+05:30')).toBe(false);
  });
});

describe('IRP response', () => {
  const irn = 'a'.repeat(64);
  const qr = { SellerGstin: SELLER, BuyerGstin: BUYER, DocNo: 'inv-000042', DocTyp: 'INV', DocDt: '12/10/2026', TotInvVal: 4720, ItemCnt: 2, MainHsnCode: '73269099', Irn: irn, IrnDt: '2026-10-12 14:03:00' };
  const raw = { AckNo: 112610012345678, AckDt: '2026-10-12 14:03:00', Irn: irn, SignedInvoice: token({ DocDtls: { No: 'INV-000042' } }), SignedQRCode: token(qr), Status: 'ACT' };
  const doc = { sellerGstin: SELLER, buyerGstin: BUYER, number: 'INV-000042', kind: 'INVOICE' as const, issueDate: '2026-10-12', total: '4720.00' };

  it('reads the response, also when wrapped in data', () => {
    const r = parseIrpResponse({ Data: raw });
    expect(r.issues).toEqual([]);
    expect(r.response).toMatchObject({ irn, ackNo: '112610012345678', ackDate: '2026-10-12T14:03:00+05:30' });
    expect(irpDateToIso('12/10/2026')).toBeNull();
    expect(parseIrpResponse({ Irn: 'abc' }).issues).toHaveLength(4);
    expect(parseIrpResponse([raw]).response).toBeNull();
  });

  it('accepts a QR code for this document and names every mismatch otherwise', () => {
    expect(matchIrpResponse(parseIrpResponse(raw).response!, doc)).toEqual([]);
    const other = parseIrpResponse({ ...raw, SignedQRCode: token({ ...qr, DocNo: 'INV-000043', TotInvVal: 4721, BuyerGstin: SELLER }) }).response!;
    expect(matchIrpResponse(other, doc)).toEqual([
      `The QR code is for buyer ${SELLER}, not ${BUYER}`,
      'The QR code is for document INV-000043, not INV-000042',
      'The QR code total 4721 does not match 4720.00',
    ]);
    expect(matchIrpResponse({ ...parseIrpResponse(raw).response!, signedQrCode: 'garbage' }, doc)[0]).toMatch(/could not be read/);
  });
});

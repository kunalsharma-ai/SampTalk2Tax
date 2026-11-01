import { describe, expect, it } from 'vitest';
import {
  buildEWayBill,
  consignmentValue,
  EWayBillInput,
  ewayBillCancellable,
  ewayBillFile,
  ewayBillRequired,
  expectedValidUntil,
  generationDeadline,
  transportIssues,
  validityDays,
  vehicleNoIssue,
} from '../src';

const SELLER = '27ZZZCE0011Z1ZV';
const BUYER = '29ZZZCB0012Z1Z5';
const input = (over: Partial<EWayBillInput> = {}): EWayBillInput => ({
  number: 'INV-000042',
  issueDate: '2026-10-12',
  generationDate: '2026-10-13',
  placeOfSupply: '29',
  seller: { gstin: SELLER, legalName: 'Northwind Traders Private Limited', address1: '12 MG Road', place: 'Pune', pincode: '411001', stateCode: '27' },
  buyer: { gstin: BUYER, legalName: 'Karnataka Metals LLP', address1: '4 Residency Road', address2: 'Ashok Nagar', place: 'Bengaluru', pincode: '560025', stateCode: '29' },
  lines: [
    { description: 'Steel brackets', hsnCode: '73269099', quantity: '300', netAmount: '60000', gstRate: '18', cgst: '0', sgst: '0', igst: '10800', exempt: false },
    { description: 'Installation', hsnCode: '995461', quantity: '1', netAmount: '5000', gstRate: '18', cgst: '0', sgst: '0', igst: '900', exempt: false },
  ],
  otherCharges: '0',
  total: '76700',
  goodsUnit: 'NOS',
  transport: { mode: 'ROAD', distanceKm: 842, vehicleNo: 'mh 12 ab-1234', vehicleType: 'R', transporterId: null, transporterName: null, transDocNo: null, transDocDate: null },
  ...over,
});

describe('when an e-way bill is needed', () => {
  it('counts goods with their GST, leaving out services and exempt goods', () => {
    const lines = [...input().lines, { description: 'Fresh produce', hsnCode: '0702', quantity: '10', netAmount: '9000', gstRate: '0', cgst: '0', sgst: '0', igst: '0', exempt: true }];
    expect(consignmentValue(lines)).toBe('70800.00');
    expect(ewayBillRequired('70800.00', '50000', false)).toBe(true);
    expect(ewayBillRequired('50000.00', '50000', false)).toBe(false);
    // A state's own threshold for movement within it.
    expect(ewayBillRequired('70800.00', '50000', true, '100000')).toBe(false);
    expect(ewayBillRequired('70800.00', '50000', false, '100000')).toBe(true);
  });
});

describe('validity (Rule 138(10))', () => {
  it('gives a day per 200 km, or per 20 km for over-dimensional cargo', () => {
    expect([validityDays(1), validityDays(200), validityDays(201), validityDays(842), validityDays(4000)]).toEqual([1, 1, 2, 5, 20]);
    expect([validityDays(20, 'O'), validityDays(21, 'O'), validityDays(90, 'O')]).toEqual([1, 2, 5]);
  });

  it('ends at midnight after the last day, counted from the day Part B is entered (IST)', () => {
    // 1 Apr 2026, 17:00 IST for 90 km: valid until midnight of 2 April.
    expect(expectedValidUntil('2026-04-01T11:30:00Z', 90)).toBe('2026-04-02T18:29:59.000Z');
    // 1 Apr 2026, 00:30 IST is still 1 April in India though 31 March in UTC.
    expect(expectedValidUntil('2026-03-31T19:00:00Z', 190)).toBe('2026-04-02T18:29:59.000Z');
    expect(expectedValidUntil('2026-04-01T11:30:00Z', 842)).toBe('2026-04-06T18:29:59.000Z');
  });

  it('allows documents dated within 180 days and cancellation within 24 hours', () => {
    expect(generationDeadline('2026-04-01')).toBe('2026-09-28');
    expect(ewayBillCancellable('2026-10-12T10:00:00Z', '2026-10-13T10:00:00Z')).toBe(true);
    expect(ewayBillCancellable('2026-10-12T10:00:00Z', '2026-10-13T10:00:01Z')).toBe(false);
    expect(ewayBillCancellable('2026-10-12T10:00:00Z', '2026-10-12T09:59:00Z')).toBe(false);
  });
});

describe('Part B', () => {
  it('knows vehicle numbers', () => {
    for (const ok of ['MH12AB1234', 'mh 12 ab 1234', 'DL1C1234', 'KA011234', '22BH1234AA', 'TM1234567']) expect(vehicleNoIssue(ok)).toBeNull();
    for (const bad of ['12345', 'MH12AB12345X', 'ABCDEFG']) expect(vehicleNoIssue(bad)).not.toBeNull();
  });

  it('asks for what each mode needs', () => {
    const ctx = { issueDate: '2026-10-12', samePin: false };
    expect(transportIssues({ mode: 'ROAD', distanceKm: 10, vehicleType: 'R' }, ctx).map((i) => i.field)).toEqual(['transport.vehicleNo']);
    expect(transportIssues({ mode: 'RAIL', distanceKm: 10, vehicleType: 'R' }, ctx).map((i) => i.field)).toEqual(['transport.transDocNo']);
    expect(transportIssues({ mode: 'AIR', distanceKm: 10, vehicleType: 'O', transDocNo: 'AWB 778', transDocDate: '2026-10-11' }, ctx).map((i) => i.field)).toEqual(['transport.transDocDate', 'transport.vehicleType']);
    expect(transportIssues({ mode: null, distanceKm: 10, vehicleType: 'R', transporterId: '29ZZZCB0012Z1Z5' }, ctx)).toEqual([]);
    expect(transportIssues({ mode: null, distanceKm: 0, vehicleType: 'R' }, ctx).map((i) => i.field)).toEqual(['transport.distanceKm']);
    expect(transportIssues({ mode: 'ROAD', distanceKm: 150, vehicleType: 'R', vehicleNo: 'MH12AB1234' }, { ...ctx, samePin: true })[0].message).toMatch(/at most 100 km/);
  });
});

describe('bulk JSON', () => {
  it('builds a bill for an inter-state invoice with goods and a service', () => {
    const { payload, issues } = buildEWayBill(input());
    expect(issues).toEqual([]);
    expect(payload).toMatchObject({
      userGstin: SELLER,
      supplyType: 'O',
      subSupplyType: 1,
      docType: 'INV',
      docNo: 'INV-000042',
      docDate: '12/10/2026',
      transType: 1,
      fromGstin: SELLER,
      fromPincode: 411001,
      fromStateCode: 27,
      actualFromStateCode: 27,
      toGstin: BUYER,
      toAddr2: 'Ashok Nagar',
      toPincode: 560025,
      toStateCode: 29,
      actualToStateCode: 29,
      totalValue: 65000,
      igstValue: 11700,
      cgstValue: 0,
      totInvValue: 76700,
      transMode: '1',
      transDistance: '842',
      vehicleNo: 'MH12AB1234',
      vehicleType: 'R',
      mainHsnCode: 73269099,
    });
    const items = (payload as { itemList: Record<string, unknown>[] }).itemList;
    expect(items[0]).toMatchObject({ itemNo: 1, hsnCode: 73269099, quantity: 300, qtyUnit: 'NOS', taxableAmount: 60000, igstRate: 18, cgstRate: 0 });
    expect(items[1]).toMatchObject({ hsnCode: 995461, qtyUnit: 'OTH' });
    expect(ewayBillFile([payload!])).toEqual({ version: '1.0.0621', billLists: [payload] });
  });

  it('handles an unregistered buyer within the state and Part A only', () => {
    const { payload, issues } = buildEWayBill(
      input({
        placeOfSupply: '27',
        buyer: { gstin: null, legalName: 'Walk-in buyer', address1: 'Shop 4, Camp', place: 'Pune', pincode: '411001', stateCode: '27' },
        lines: [{ description: 'Steel brackets', hsnCode: '7326', quantity: '300', netAmount: '60000', gstRate: '18', cgst: '5400', sgst: '5400', igst: '0', exempt: false }],
        total: '70800',
        transport: { mode: null, distanceKm: 8, vehicleType: 'R' },
      }),
    );
    expect(issues).toEqual([]);
    expect(payload).toMatchObject({ toGstin: 'URP', toStateCode: 27, cgstValue: 5400, sgstValue: 5400, transMode: '', vehicleNo: '', vehicleType: '', transDistance: '8' });
    expect((payload as { itemList: Record<string, unknown>[] }).itemList[0]).toMatchObject({ cgstRate: 9, sgstRate: 9, igstRate: 0 });
  });

  it('lists what the portal would reject', () => {
    const { payload, issues } = buildEWayBill(
      input({
        generationDate: '2027-05-01',
        buyer: { gstin: BUYER, legalName: 'Karnataka Metals LLP', address1: '', place: '', pincode: '', stateCode: '29' },
        lines: [{ description: 'Advisory', hsnCode: '998311', quantity: '1', netAmount: '65000', gstRate: '18', cgst: '0', sgst: '0', igst: '11700', exempt: false }],
        total: '1',
      }),
    );
    expect(payload).toBeNull();
    expect(issues.map((i) => i.message)).toEqual([
      'The portal takes documents dated within 180 days only',
      'Delivery address is missing',
      'Delivery city is missing',
      'Delivery PIN code is missing',
      'There are no goods on this invoice (only services)',
      'Lines and other charges add up to 76700.00, not the total 1.00',
    ]);
  });
});

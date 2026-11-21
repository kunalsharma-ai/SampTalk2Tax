import { describe, expect, it } from 'vitest';
import { IMPORT_KINDS, importTemplate, planAccountImport, planContactImport, planOpeningBalanceImport } from '../src/data-import';

const chart = [
  { code: '1000', type: 'ASSET' as const, isPostable: false },
  { code: '1100', type: 'ASSET' as const, isPostable: true },
  { code: '6000', type: 'EXPENSE' as const, isPostable: false },
];

describe('account import', () => {
  it('reads headings by name, creates new codes parents first and skips codes already in the chart', () => {
    const csv = ['Account Number,Account Name,Class,Detail type,Parent,Is header', '6110,Cloud hosting,Expense,Operating expense,6100,no', '6100,Software,expenses,,6000,yes', '1100,Bank,Asset,Bank,1000,'].join('\n');
    const plan = planAccountImport(csv, chart);
    expect(plan.issues).toEqual([]);
    expect(plan.columns.map((c) => c.key)).toEqual(['code', 'name', 'type', 'subtype', 'parentCode', 'header']);
    expect(plan.rows.map((r) => [r.values.code, r.action])).toEqual([['6100', 'CREATE'], ['6110', 'CREATE'], ['1100', 'SKIP']]);
    expect(plan.rows[0]!.values).toMatchObject({ type: 'EXPENSE', isPostable: false, parentCode: '6000' });
    expect(plan.rows[1]!.values.subtype).toBe('OPERATING_EXPENSE');
    expect(plan.summary).toEqual({ rows: 3, create: 2, skip: 1, problems: 0 });
  });

  it('names each problem with its row and column', () => {
    const csv = ['Code,Name,Type,Subtype,Parent code', '6200,,Expense,,', '6300,Rent,Expens,,6000', '6400,Rent,Expense,Bank,', '1200,Deposit,Asset,,1100', '6500,Travel,Expense,,1000', '6200,Again,Expense,,', 'bad code!,X,Asset,,'].join('\n');
    const plan = planAccountImport(csv, chart);
    const at = (row: number) => plan.issues.filter((i) => i.row === row).map((i) => `${i.column}: ${i.message}`);
    expect(at(2)).toEqual(['Name: Name is empty.']);
    expect(at(3)).toEqual(['Type: "Expens" is not a type: use Asset, Liability, Equity, Revenue or Expense.']);
    expect(at(4)[0]).toMatch(/^Subtype: "Bank" is not an expense subtype/);
    expect(at(5)[0]).toMatch(/Parent 1100 takes entries/);
    expect(at(6)[0]).toMatch(/Parent 1000 is an asset account; an expense account needs an expense parent/);
    expect(at(7)).toEqual(['Code: Code 6200 is also on row 2.']);
    expect(at(8)[0]).toMatch(/is not a valid code/);
    expect(plan.summary.create).toBe(0);
  });

  it('refuses a file without a required column, and parent codes that loop', () => {
    expect(planAccountImport('Name,Type\nRent,Expense', chart).issues[0]).toMatchObject({ row: 1, column: 'Code' });
    const loop = planAccountImport('Code,Name,Type,Header,Parent code\n7000,A,Expense,yes,7100\n7100,B,Expense,yes,7000', chart);
    expect(loop.issues.some((i) => /loop/.test(i.message))).toBe(true);
  });
});

describe('contact import', () => {
  const gst = (g: string) => (g === '27AAPFU0939F1ZV' ? { valid: true, issues: [], stateCode: '27' } : { valid: false, issues: ['check digit does not match'] });

  it('creates new customers, skips names already there and reads semicolon files', () => {
    const csv = ['Customer name;E-mail;GST number;PIN;Terms;Credit limit', 'Asha Traders;accounts@asha.example;27AAPFU0939F1ZV;411001;Net 45;"5,00,000.50"', 'Existing Co;;;;;'].join('\n');
    const plan = planContactImport('customers', csv, [{ name: 'existing co' }], { decimals: 2, checkGstin: gst });
    expect(plan.issues).toEqual([]);
    expect(plan.rows[0]).toMatchObject({ action: 'CREATE', values: { name: 'Asha Traders', gstin: '27AAPFU0939F1ZV', pincode: '411001', paymentTermsDays: 45, creditLimit: '500000.5' } });
    expect(plan.rows[1]).toMatchObject({ action: 'SKIP', reason: 'existing co is already in your contacts' });
  });

  it('checks GSTIN, PAN, state, email, PIN code, terms and amounts', () => {
    const csv = ['Name,Email,GSTIN,PAN,State code,PIN code,Payment terms (days),Credit limit', 'A,not-an-email,27AAPFU0939F1ZX,,,12345,ninety,12.345', 'B,,27AAPFU0939F1ZV,AAAAA1111A,29,,,-5'].join('\n');
    const plan = planContactImport('vendors', csv, [], { decimals: 2, checkGstin: gst });
    const cols = (row: number) => plan.issues.filter((i) => i.row === row).map((i) => i.column);
    expect(cols(2)).toEqual(['Email', 'GSTIN', 'PIN code', 'Payment terms (days)', 'Credit limit']);
    expect(cols(3)).toEqual(['PAN', 'State code', 'Credit limit']);
  });
});

describe('opening balance import', () => {
  const accounts = [
    { id: 'bank', code: '1100', name: 'Bank' },
    { id: 'loan', code: '2100', name: 'Loan' },
    { id: 'kit', code: '1500', name: 'Equipment' },
  ];

  it('totals debits and credits in decimals and leaves empty lines out', () => {
    const csv = ['Account code,Account name,Dr,Cr', '1100,Bank,"2,50,000.10",', '2100,Loan,,100000', '1500,Equipment,0.20,', '1500x,,,'].join('\n');
    const plan = planOpeningBalanceImport(csv.replace('1500x,,,', ''), accounts, { decimals: 2 });
    expect(plan.issues).toEqual([]);
    expect(plan.totals).toEqual({ debit: '250000.30', credit: '100000.00', difference: '150000.30' });
    expect(plan.rows.filter((r) => r.action === 'CREATE').map((r) => [r.values.accountId, r.values.debit, r.values.credit])).toEqual([
      ['bank', '250000.10', null],
      ['loan', null, '100000.00'],
      ['kit', '0.20', null],
    ]);
  });

  it('refuses unknown accounts, both sides on one line, repeats and a file with no amounts', () => {
    const csv = ['Code,Debit,Credit', '9999,10,', '1100,10,5', '2100,,5', '2100,,6'].join('\n');
    const plan = planOpeningBalanceImport(csv, accounts, { decimals: 2 });
    expect(plan.issues.map((i) => [i.row, i.column])).toEqual([[2, 'Account code'], [3, 'Debit'], [5, 'Account code']]);
    expect(planOpeningBalanceImport('Code,Debit,Credit\n1100,,', accounts, { decimals: 2 }).issues[0]!.message).toBe('No line has an amount.');
  });
});

it('every template reads back with no problems about its columns', () => {
  for (const kind of IMPORT_KINDS) {
    const t = importTemplate(kind);
    const plan =
      kind === 'accounts'
        ? planAccountImport(t, [])
        : kind === 'opening-balances'
          ? planOpeningBalanceImport(t, [{ id: 'a', code: '1100', name: 'Bank' }, { id: 'b', code: '2100', name: 'Loan' }], { decimals: 2 })
          : planContactImport(kind, t, [], { decimals: 2 });
    expect(plan.ignored).toEqual([]);
    expect(plan.issues.filter((i) => i.row <= 1)).toEqual([]);
  }
});

import { describe, expect, it } from 'vitest';
import { detectStatementFormat, fileTotalsCheck, parseStatementFile } from '../src';

const OFX_SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>INR
<BANKTRANLIST>
<DTSTART>20261101
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20261103120000[+5:30:IST]
<TRNAMT>11800.00
<FITID>N3031
<NAME>NEFT HARBOUR CAFE
<MEMO>Invoice INV-000001
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20261105
<TRNAMT>-500.00
<FITID>C5512
<CHECKNUM>004512
<NAME>BANK CHARGES &amp; GST
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>111300.00<DTASOF>20261105</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

const OFX_XML = `<?xml version="1.0"?><?OFX OFXHEADER="200" VERSION="220"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>INR</CURDEF><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261107</DTPOSTED><TRNAMT>-2500,50</TRNAMT><FITID>X1</FITID><NAME>Power bill</NAME></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

const QIF = `!Type:Bank
D03/11/2026
T11,800.00
PNEFT HARBOUR CAFE
MInvoice INV-000001
^
D05/11'26
T-500.00
N004512
PBANK CHARGES
SBank fees
$-500.00
^
`;

const MT940 = `{1:F01HDFCINBBAXXX0000000000}{4:
:20:STMT2611
:25:50200012345678
:28C:00045/001
:60F:C261031INR100000,00
:61:2611031103C11800,00NTRFUTR778812//N3031
:86:NEFT HARBOUR CAFE INVOICE INV-000001
:61:2611051105D500,00NCHG004512
:86:BANK CHARGES
:61:2611061106RC200,00NTRFNONREF//R1
:86:REVERSAL OF CREDIT
:62F:C261106INR111100,00
-}`;

const rows = (f: ReturnType<typeof parseStatementFile>) => f.lines.map((l) => [l.date, l.amount.toFixed(), l.description, l.reference]);

describe('bank statement file formats', () => {
  it('detects OFX, QIF and MT940 from the content', () => {
    expect([OFX_SGML, OFX_XML, QIF, MT940, 'Date,Narration,Amount\n'].map(detectStatementFormat)).toEqual(['OFX', 'OFX', 'QIF', 'MT940', null]);
  });

  it('reads OFX 1 (SGML) with its closing balance', () => {
    const f = parseStatementFile('OFX', OFX_SGML, 'INR');
    expect(rows(f)).toEqual([
      ['2026-11-03', '11800', 'NEFT HARBOUR CAFE - Invoice INV-000001', 'N3031'],
      ['2026-11-05', '-500', 'BANK CHARGES & GST', '004512'],
    ]);
    expect(f.closing!.toFixed()).toBe('111300');
    expect(f.currency).toBe('INR');
  });

  it('reads OFX 2 (XML), with a decimal comma', () => {
    expect(rows(parseStatementFile('OFX', OFX_XML, 'INR'))).toEqual([['2026-11-07', '-2500.5', 'Power bill', 'X1']]);
  });

  it('reads QIF with day-first or month-first dates, ignoring splits', () => {
    expect(rows(parseStatementFile('QIF', QIF, 'INR', 'DD/MM/YYYY'))).toEqual([
      ['2026-11-03', '11800', 'NEFT HARBOUR CAFE - Invoice INV-000001', null],
      ['2026-11-05', '-500', 'BANK CHARGES', '004512'],
    ]);
    expect(parseStatementFile('QIF', QIF, 'INR', 'MM/DD/YYYY').lines[0].date).toBe('2026-03-11');
  });

  it('reads MT940 with reversals and checks the file adds up', () => {
    const f = parseStatementFile('MT940', MT940, 'INR');
    expect(rows(f)).toEqual([
      ['2026-11-03', '11800', 'NEFT HARBOUR CAFE INVOICE INV-000001', 'UTR778812'],
      ['2026-11-05', '-500', 'BANK CHARGES', '004512'],
      ['2026-11-06', '-200', 'REVERSAL OF CREDIT', 'R1'],
    ]);
    const t = fileTotalsCheck(f)!;
    expect([t.opening.toFixed(), t.computed.toFixed(), t.closing.toFixed(), t.difference.toFixed()]).toEqual(['100000', '111100', '111100', '0']);
    const short = parseStatementFile('MT940', MT940.replace(/:61:2611051105D500,00NCHG004512\n:86:BANK CHARGES\n/, ''), 'INR');
    expect(fileTotalsCheck(short)!.difference.toFixed()).toBe('-500');
  });

  it('names the transaction that cannot be read', () => {
    expect(() => parseStatementFile('OFX', OFX_SGML.replace('<TRNAMT>-500.00', '<TRNAMT>abc'), 'INR')).toThrow(/Transaction 2: "abc" is not an amount/);
    expect(() => parseStatementFile('QIF', '!Type:Bank\nT5.00\nPX\n^\n', 'INR')).toThrow(/Transaction 1: no date/);
    expect(() => parseStatementFile('MT940', ':20:X\n:61:garbage\n', 'INR')).toThrow(/Transaction 1: "garbage" is not an MT940 statement line/);
  });
});

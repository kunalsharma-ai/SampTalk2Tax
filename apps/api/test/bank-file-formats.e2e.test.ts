import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/** OFX, QIF and MT940 statement imports (BANK-003) against the real API and database. */
let ctx: Ctx;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let bank: string;

const MT940 = [
  ':20:STMT2611',
  ':25:50200012345678',
  ':60F:C261031INR100000,00',
  ':61:2611031103C11800,00NTRFUTR778812//N3031',
  ':86:NEFT HARBOUR CAFE',
  ':61:2611051105D500,00NCHG004512',
  ':86:BANK CHARGES',
  ':62F:C261105INR112300,00',
].join('\n');
const OFX = `OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>INR<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261107<TRNAMT>-2500.00<FITID>X1<NAME>POWER BILL</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>108800.00</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
const QIF = '!Type:Bank\nD08/11/2026\nT-1,200.00\nPOFFICE TEA\n^\n';
const send = (body: Record<string, unknown>) => ctx.http().post(`${org.base}/banking/accounts/${bank}/imports`).set(owner.auth).send({ fileName: 'statement', ...body });

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Formats Owner');
  org = await createOrg(ctx, owner);
  bank = org.acc['1120'];
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('statement file formats', () => {
  it('previews an MT940 file and flags one that does not add up', async () => {
    const p = (await send({ csv: MT940, format: 'MT940', dryRun: true }).expect(201)).body;
    expect(p.format).toBe('MT940');
    expect(p.lines.map((l: { date: string; amount: string; description: string }) => [l.date, l.amount, l.description])).toEqual([
      ['2026-11-03', '11800.00', 'NEFT HARBOUR CAFE'],
      ['2026-11-05', '-500.00', 'BANK CHARGES'],
    ]);
    // 1,00,000 + 11,800 − 500 = 1,11,300, but the bank's closing balance says 1,12,300.
    expect(p.fileTotals).toEqual({ opening: '100000.00', closing: '112300.00', computed: '111300.00', difference: '1000.00' });
  });

  it('imports MT940, OFX and QIF, and skips lines already imported', async () => {
    expect((await send({ csv: MT940, format: 'MT940' }).expect(201)).body).toMatchObject({ imported: true, newCount: 2 });
    expect((await send({ csv: OFX, format: 'OFX' }).expect(201)).body).toMatchObject({ imported: true, newCount: 1, fileTotals: null });
    expect((await send({ csv: QIF, format: 'QIF', dateFormat: 'DD/MM/YYYY' }).expect(201)).body).toMatchObject({ imported: true, newCount: 1 });
    expect((await send({ csv: MT940, format: 'MT940' }).expect(409)).body.error).toBe('NOTHING_NEW');
    const lines = (await ctx.http().get(`${org.base}/banking/accounts/${bank}/lines`).set(owner.auth).expect(200)).body;
    expect(lines.lines.map((l: { description: string }) => l.description).sort()).toEqual(['BANK CHARGES', 'NEFT HARBOUR CAFE', 'OFFICE TEA', 'POWER BILL']);
  });

  it('refuses a file that is not what it says, and CSV without a mapping', async () => {
    expect((await send({ csv: QIF, format: 'OFX', dryRun: true }).expect(422)).body.details.issues).toEqual(['This file does not look like OFX']);
    await send({ csv: 'a,b\n', dryRun: true }).expect(400);
  });
});

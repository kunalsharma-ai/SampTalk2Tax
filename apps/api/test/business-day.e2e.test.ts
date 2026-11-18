import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * An organisation's business day follows its time zone (I18N-008): "today" for future-date
 * checks is the date there, not in India, and a person's own display time zone does not move it.
 */
let ctx: Ctx;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;

const dateIn = (tz: string, at = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
// At any moment one of these two is on a different date from India: Kiribati (UTC+14) from 15:30
// India time, Samoa (UTC-11) before 16:30 India time.
const zone = dateIn('Pacific/Kiritimati') !== dateIn('Asia/Kolkata') ? 'Pacific/Kiritimati' : 'Pacific/Pago_Pago';
const FUTURE = 'The statement date cannot be in the future';

async function futureIssue(date: string) {
  const r = await ctx.http().post(`${org.base}/banking/accounts/${org.acc['1120']}/reconciliations/preview`).set(owner.auth).send({ statementDate: date, statementBalance: '0', openingBalance: '0' }).expect(200);
  return (r.body.issues as string[]).includes(FUTURE);
}

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Zone Owner');
  org = await createOrg(ctx, owner);
});
afterAll(async () => {
  await ctx.app.close();
});

describe('the business day', () => {
  it('is India time by default', async () => {
    expect(await futureIssue(dateIn('Asia/Kolkata'))).toBe(false);
  });

  it('follows the organisation\'s time zone once it is set', async () => {
    expect(zone === 'Pacific/Kiritimati' || dateIn(zone) < dateIn('Asia/Kolkata')).toBe(true);
    await ctx.http().put(`/v1/orgs/${org.orgId}/time-zone`).set(owner.auth).send({ timeZone: zone }).expect(200);
    const local = dateIn(zone);
    const india = dateIn('Asia/Kolkata');
    expect(local).not.toBe(india);
    // The date there is today; India's date is a day ahead of it (Samoa) or behind it (Kiribati).
    expect(await futureIssue(local)).toBe(false);
    expect(await futureIssue(india)).toBe(zone === 'Pacific/Pago_Pago');
  });

  it('is not moved by a person\'s own display time zone', async () => {
    await ctx.http().put('/v1/auth/me/preferences').set(owner.auth).send({ language: 'en', numberFormat: 'AUTO', dateFormat: 'D_MON_Y', timeZone: 'Asia/Kolkata' }).expect(200);
    expect(await futureIssue(dateIn(zone))).toBe(false);
    expect(await futureIssue(dateIn('Asia/Kolkata'))).toBe(zone === 'Pacific/Pago_Pago');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { RegionsService } from '../src/regions/regions.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/** Regional deployment: organisations live in one region and only that region serves them. */
const DIRECTORY = JSON.stringify({
  'in-mumbai': { name: 'India (Mumbai)', appUrl: 'https://in.talk2tax.example' },
  'eu-frankfurt': { name: 'European Union (Frankfurt)', appUrl: 'https://eu.talk2tax.example' },
  'uk-london': { name: 'United Kingdom (London)', appUrl: 'https://uk.talk2tax.example' },
});
let india: Ctx;
let europe: Ctx;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;

beforeAll(async () => {
  india = await bootApp({ DEPLOYMENT_REGION: 'in-mumbai', DEPLOYMENT_REGION_NAME: 'India (Mumbai)', REGION_DIRECTORY: DIRECTORY });
  europe = await bootApp({ DEPLOYMENT_REGION: 'eu-frankfurt', DEPLOYMENT_REGION_NAME: 'European Union (Frankfurt)', REGION_DIRECTORY: DIRECTORY });
  owner = await registerUser(india, 'Region Owner');
  org = await createOrg(india, owner, { name: 'Region Traders Pvt Ltd' });
});
afterAll(async () => {
  await india.app.close();
  await europe.app.close();
});

describe('a deployment says which region it serves', () => {
  it('on the public region endpoint and in the health check', async () => {
    const r = (await india.http().get('/v1/region').expect(200)).body;
    expect(r).toEqual({
      region: 'in-mumbai',
      name: 'India (Mumbai)',
      regions: [
        { region: 'eu-frankfurt', name: 'European Union (Frankfurt)', appUrl: 'https://eu.talk2tax.example' },
        { region: 'in-mumbai', name: 'India (Mumbai)', appUrl: 'https://in.talk2tax.example' },
        { region: 'uk-london', name: 'United Kingdom (London)', appUrl: 'https://uk.talk2tax.example' },
      ],
    });
    expect((await europe.http().get('/health').expect(200)).body).toEqual({ status: 'ok', database: 'ok', region: 'eu-frankfurt' });
  });

  it('refuses a region code or directory that is not well formed', () => {
    const base = { DATABASE_URL: 'postgres://x', JWT_SECRET: 'x'.repeat(40) };
    expect(() => loadConfig({ ...base, DEPLOYMENT_REGION: 'EU West' })).toThrow(/DEPLOYMENT_REGION/);
    expect(() => loadConfig({ ...base, REGION_DIRECTORY: '{not json' })).toThrow(/REGION_DIRECTORY must be JSON/);
    expect(() => loadConfig({ ...base, REGION_DIRECTORY: JSON.stringify({ eu: { name: 'EU', appUrl: 'ftp://eu' } }) })).toThrow(/REGION_DIRECTORY/);
    expect(loadConfig({ ...base }).DEPLOYMENT_REGION).toBe('local');
  });
});

describe('an organisation lives in the region it was created in', () => {
  it('is tagged at creation and served there', async () => {
    const o = (await india.http().get(org.base).set(owner.auth).expect(200)).body;
    expect(o.dataRegion).toEqual({ region: 'in-mumbai', name: 'India (Mumbai)', appUrl: 'https://in.talk2tax.example', here: true });
    const created = await india.prisma.auditEvent.findFirstOrThrow({ where: { orgId: org.orgId, action: 'organization.created' } });
    expect((created.data as { dataRegion: string }).dataRegion).toBe('in-mumbai');
  });

  it('is refused by another region, which points to its home', async () => {
    const res = await europe.http().get(`${org.base}/accounts`).set(owner.auth).expect(421);
    expect(res.body).toMatchObject({ error: 'WRONG_REGION', region: 'in-mumbai', regionName: 'India (Mumbai)', appUrl: 'https://in.talk2tax.example' });
    expect(res.body.message).toMatch(/kept in India \(Mumbai\)\. Open it at https:\/\/in\.talk2tax\.example/);
    // Writes are refused as well, so the books are never written in two places.
    await europe.http().post(`${org.base}/accounts`).set(owner.auth).send({ code: '9999', name: 'Nope', type: 'EXPENSE' }).expect(421);
    // The list of organisations still shows it, marked as elsewhere.
    const list = (await europe.http().get('/v1/orgs').set(owner.auth).expect(200)).body as { id: string; dataRegion: { here: boolean; appUrl: string } }[];
    expect(list.find((x) => x.id === org.orgId)?.dataRegion).toMatchObject({ here: false, appUrl: 'https://in.talk2tax.example' });
    // Non-members still get 404 first, so ids cannot be probed through the region check.
    const stranger = await registerUser(europe, 'Region Stranger');
    await europe.http().get(org.base).set(stranger.auth).expect(404);
  });
});

describe('moving an organisation to another region', () => {
  it('hands it over, audited, and can be undone before the copy is done', async () => {
    const regions = india.app.get(RegionsService);
    await expect(regions.move(org.orgId, 'us-east', 'test')).rejects.toMatchObject({ code: 'REGION_UNKNOWN' });
    await expect(regions.move(org.orgId, 'in-mumbai', 'test')).rejects.toMatchObject({ code: 'REGION_UNCHANGED' });
    await expect(regions.move(org.orgId, 'eu-frankfurt', '  ')).rejects.toMatchObject({ code: 'REGION_REASON_REQUIRED' });

    expect(await regions.move(org.orgId, 'eu-frankfurt', 'Customer asked for EU hosting')).toMatchObject({ from: 'in-mumbai', to: 'eu-frankfurt' });
    await india.http().get(org.base).set(owner.auth).expect(421);
    expect((await europe.http().get(org.base).set(owner.auth).expect(200)).body.dataRegion).toMatchObject({ region: 'eu-frankfurt', here: true });
    // Only the region it lives in can move it on.
    await expect(regions.move(org.orgId, 'eu-frankfurt', 'again')).rejects.toMatchObject({ code: 'REGION_UNCHANGED' });

    // Moving it back to this region undoes the move.
    await regions.move(org.orgId, 'in-mumbai', 'Move cancelled');
    await india.http().get(org.base).set(owner.auth).expect(200);
    const moves = await india.prisma.auditEvent.findMany({ where: { orgId: org.orgId, action: 'organization.region_moved' }, orderBy: { createdAt: 'asc' } });
    expect(moves.map((m) => m.data)).toEqual([
      { from: 'in-mumbai', to: 'eu-frankfurt', reason: 'Customer asked for EU hosting', by: 'in-mumbai' },
      { from: 'eu-frankfurt', to: 'in-mumbai', reason: 'Move cancelled', by: 'in-mumbai' },
    ]);
  });

  it('refuses a move between two other regions', async () => {
    const other = await createOrg(europe, owner, { name: 'Region EU GmbH', countryCode: 'DE', functionalCurrency: 'EUR', fiscalYearStartMonth: 1 });
    const regions = india.app.get(RegionsService);
    await expect(regions.move(other.orgId, 'eu-frankfurt', 'x')).rejects.toMatchObject({ code: 'REGION_UNCHANGED' });
    await expect(regions.move(other.orgId, 'uk-london', 'x')).rejects.toMatchObject({ code: 'REGION_NOT_HERE' });
    await expect(europe.app.get(RegionsService).move(other.orgId, 'nowhere-1', 'x')).rejects.toMatchObject({ code: 'REGION_UNKNOWN' });
  });
});

describe('organisations from before regions', () => {
  it('are claimed by the region that serves the database, and a region is never cleared', async () => {
    const legacy = await india.prisma.organization.create({ data: { name: 'Legacy Region Ltd', countryCode: 'IN', functionalCurrency: 'INR', fiscalYearStartMonth: 4 } });
    expect(legacy.dataRegion).toBeNull();
    await india.app.get(RegionsService).claimUntagged();
    const after = await india.prisma.organization.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(after.dataRegion).not.toBeNull();
    await expect(india.prisma.organization.update({ where: { id: legacy.id }, data: { dataRegion: null } })).rejects.toThrow(/cannot be cleared/);
    await expect(india.prisma.organization.update({ where: { id: legacy.id }, data: { dataRegion: 'Not A Region' } })).rejects.toThrow(/data_region_format/);
  });
});

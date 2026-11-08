import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/bootstrap';
import type { CopilotModel } from '../src/copilot/copilot.model';
import { allowSystemAccessOutsideRequests } from '../src/common/tenant-context';
import { loadConfig } from '../src/config';
import { PrismaService } from '../src/common/prisma.service';

export interface Ctx {
  app: INestApplication;
  http: () => ReturnType<typeof request>;
  prisma: PrismaService;
}

/** Tests read and tamper with the database directly, as the system. */
allowSystemAccessOutsideRequests();

export async function bootApp(overrides: Record<string, string> = {}, opts: { copilotModel?: CopilotModel | null } = {}): Promise<Ctx> {
  // The copilot never reaches a real AI provider from the tests, even when a key is set locally.
  const config = loadConfig({
    // Suites register many users from one address; the rate limit test sets its own low limits.
    RATE_LIMIT_AUTH_PER_MINUTE: '100000',
    RATE_LIMIT_API_PER_MINUTE: '100000',
    ...process.env,
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_BASE_URL: '',
    // The tests drive the workflow runner by hand, and their webhook receiver is on localhost.
    WORKFLOW_RUNNER_INTERVAL_SECONDS: '0',
    ALERTS_RUNNER_INTERVAL_SECONDS: '0',
    CONTRACT_RUNNER_INTERVAL_SECONDS: '0',
    RECURRING_JOURNAL_RUNNER_INTERVAL_SECONDS: '0',
    RECURRING_BILL_RUNNER_INTERVAL_SECONDS: '0',
    CRM_WEBHOOK_RUNNER_INTERVAL_SECONDS: '0',
    WEBHOOK_ALLOW_PRIVATE_NETWORKS: 'true',
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
    JWT_SECRET: process.env.JWT_SECRET ?? 'test-secret-that-is-long-enough-for-hs256-signing',
    ...overrides,
  });
  const app = await createApp(config, { logger: process.env.TEST_LOGS === '1', copilotModel: 'copilotModel' in opts ? opts.copilotModel : null });
  await app.init();
  return { app, http: () => request(app.getHttpServer()), prisma: app.get(PrismaService) };
}

export interface TestUser {
  id: string;
  email: string;
  token: string;
  refreshToken: string;
  auth: { Authorization: string };
}

export async function registerUser(ctx: Ctx, name = 'Test User'): Promise<TestUser> {
  const email = `${randomUUID()}@example.test`;
  const res = await ctx.http().post('/v1/auth/register').send({ email, name, password: 'a-very-long-test-password' }).expect(201);
  return { id: res.body.user.id, email, token: res.body.accessToken, refreshToken: res.body.refreshToken, auth: { Authorization: `Bearer ${res.body.accessToken}` } };
}

export async function createOrg(ctx: Ctx, user: TestUser, overrides: Record<string, unknown> = {}) {
  const res = await ctx
    .http()
    .post('/v1/orgs')
    .set(user.auth)
    .send({ name: 'Acme Test Pvt Ltd', countryCode: 'IN', functionalCurrency: 'INR', fiscalYearStartMonth: 4, ...overrides })
    .expect(201);
  const orgId: string = res.body.id;
  const accounts = await ctx.http().get(`/v1/orgs/${orgId}/accounts`).set(user.auth).expect(200);
  const byCode = Object.fromEntries((accounts.body as { code: string; id: string }[]).map((a) => [a.code, a.id]));
  return { orgId, acc: byCode as Record<string, string>, base: `/v1/orgs/${orgId}` };
}

/** A date inside the fiscal year created at onboarding (the current one). */
export function today(): string {
  return new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

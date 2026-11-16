import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { PrismaService } from '../src/common/prisma.service';

export interface Ctx {
  app: INestApplication;
  http: () => ReturnType<typeof request>;
  prisma: PrismaService;
}

export async function bootApp(): Promise<Ctx> {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
    JWT_SECRET: process.env.JWT_SECRET ?? 'test-secret-that-is-long-enough-for-hs256-signing',
  });
  const app = await createApp(config, { logger: process.env.TEST_LOGS === '1' });
  await app.init();
  return { app, http: () => request(app.getHttpServer()), prisma: app.get(PrismaService) };
}

export interface TestUser {
  id: string;
  email: string;
  token: string;
  auth: { Authorization: string };
}

export async function registerUser(ctx: Ctx, name = 'Test User'): Promise<TestUser> {
  const email = `${randomUUID()}@example.test`;
  const res = await ctx.http().post('/v1/auth/register').send({ email, name, password: 'a-very-long-test-password' }).expect(201);
  return { id: res.body.user.id, email, token: res.body.accessToken, auth: { Authorization: `Bearer ${res.body.accessToken}` } };
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
  return new Date().toISOString().slice(0, 10);
}

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { parseArgs } from 'node:util';
import { AppModule } from '../app.module';
import { allowSystemAccessOutsideRequests } from '../common/tenant-context';
import { loadConfig } from '../config';
import { AdminService } from './admin.service';

/**
 * Gives a registered person a platform role, for the first administrator:
 *   pnpm --filter @talk2tax/api admin:grant --email you@example.com [--role SUPER_ADMIN|SUPPORT]
 * After that, super admins manage roles in the app (Platform administration → People).
 */
async function main() {
  const { values } = parseArgs({ options: { email: { type: 'string' }, role: { type: 'string', default: 'SUPER_ADMIN' } } });
  if (!values.email || !['SUPER_ADMIN', 'SUPPORT'].includes(values.role ?? '')) throw new Error('Usage: admin:grant --email <email> [--role SUPER_ADMIN|SUPPORT]');
  const config = loadConfig();
  allowSystemAccessOutsideRequests();
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(config), { logger: ['error', 'warn'] });
  try {
    await app.get(AdminService).grant(values.email, values.role as 'SUPER_ADMIN' | 'SUPPORT');
    console.log(`${values.email} is now ${values.role}.`);
  } finally {
    await app.close();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

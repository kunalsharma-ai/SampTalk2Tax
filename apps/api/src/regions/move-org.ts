import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { parseArgs } from 'node:util';
import { AppModule } from '../app.module';
import { allowSystemAccessOutsideRequests } from '../common/tenant-context';
import { loadConfig } from '../config';
import { RegionsService } from './regions.service';

/**
 * Hands an organisation to another region:
 *   pnpm region:move --org <organisation id> --to <region> --reason "Customer asked for EU hosting"
 * Run it on the API of the region the organisation lives in now. See docs/REGIONAL_DEPLOYMENT.md.
 */
async function main() {
  const { values } = parseArgs({ options: { org: { type: 'string' }, to: { type: 'string' }, reason: { type: 'string' } } });
  if (!values.org || !values.to || !values.reason) throw new Error('Usage: region:move --org <id> --to <region> --reason "<why>"');
  const config = loadConfig();
  allowSystemAccessOutsideRequests();
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(config), { logger: ['error', 'warn'] });
  try {
    const r = await app.get(RegionsService).move(values.org, values.to, values.reason);
    console.log(`${r.name} (${r.orgId}) moved from ${r.from} to ${r.to}. ${r.to === config.DEPLOYMENT_REGION ? 'It is served here again.' : 'This region now refuses it; copy its data to the new region next.'}`);
  } finally {
    await app.close();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

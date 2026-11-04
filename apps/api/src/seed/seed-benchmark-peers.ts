import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { BenchmarkingService } from '../benchmarking/benchmarking.service';
import { allowSystemAccessOutsideRequests } from '../common/tenant-context';
import { loadConfig } from '../config';

/**
 * Fills the SYNTHETIC benchmarking pool that demo organisations are compared with. Generated
 * values, every row marked synthetic; live organisations never see them. Refused in production.
 */
async function main() {
  const config = loadConfig();
  if (config.NODE_ENV === 'production') throw new Error('Refusing to seed synthetic benchmark peers in production');
  allowSystemAccessOutsideRequests();
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(config), { logger: ['error', 'warn'] });
  const n = await app.get(BenchmarkingService).seedSyntheticPeers(+(process.env.SYNTHETIC_PEERS ?? 60));
  console.log(`Synthetic benchmark pool: ${n} peers (labelled synthetic; compared only with demo organisations).`);
  await app.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

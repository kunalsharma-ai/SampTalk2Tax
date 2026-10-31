import { Logger } from '@nestjs/common';
import { createApp } from './bootstrap';
import { loadConfig } from './config';

async function main() {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.PORT);
  new Logger('Talk2Tax').log(`API listening on http://localhost:${config.PORT} (OpenAPI at /docs)`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

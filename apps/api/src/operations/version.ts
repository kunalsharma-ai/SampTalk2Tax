import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The API's version, from its package.json. */
export const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
})();

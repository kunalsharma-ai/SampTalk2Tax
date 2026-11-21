import type { AppConfig } from '../config';

/**
 * Synthetic data (the demo organisation, benchmark peers) is never written where real books are
 * kept (RULE-004): not when NODE_ENV is production, and not in a deployed region, whatever
 * NODE_ENV says. Returns why it is refused, or null when seeding may go ahead.
 */
export function syntheticDataRefusal(config: Pick<AppConfig, 'NODE_ENV' | 'DEPLOYMENT_REGION'>, what: string): string | null {
  if (config.NODE_ENV === 'production') return `Refusing to seed ${what} in production`;
  if (config.DEPLOYMENT_REGION !== 'local') return `Refusing to seed ${what} in deployment region "${config.DEPLOYMENT_REGION}": synthetic data goes only into local development and test databases`;
  return null;
}

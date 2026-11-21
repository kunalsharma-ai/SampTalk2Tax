import { describe, expect, it } from 'vitest';
import { syntheticDataRefusal } from '../src/seed/guard';

/** RULE-004: synthetic data is never seeded where real books are kept. */
describe('synthetic data guard (RULE-004)', () => {
  it('allows seeding only in a local development or test setup', () => {
    expect(syntheticDataRefusal({ NODE_ENV: 'development', DEPLOYMENT_REGION: 'local' }, 'demo data')).toBeNull();
    expect(syntheticDataRefusal({ NODE_ENV: 'test', DEPLOYMENT_REGION: 'local' }, 'demo data')).toBeNull();
  });

  it('refuses production, and any deployed region whatever NODE_ENV says', () => {
    expect(syntheticDataRefusal({ NODE_ENV: 'production', DEPLOYMENT_REGION: 'local' }, 'demo data')).toBe('Refusing to seed demo data in production');
    expect(syntheticDataRefusal({ NODE_ENV: 'development', DEPLOYMENT_REGION: 'in-mumbai' }, 'synthetic benchmark peers')).toContain('deployment region "in-mumbai"');
  });
});

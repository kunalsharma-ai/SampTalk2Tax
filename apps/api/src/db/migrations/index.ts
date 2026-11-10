import type { Migration } from '@talk2tax/document-db';
import foundation from './20261109090000_foundation';
import identity from './20261109100000_identity';
import tenancy from './20261109110000_tenancy';
import chart from './20261109120000_chart';

/** In order. Never edit a migration that has been applied anywhere; add a new one. */
export const MIGRATIONS: readonly Migration[] = [foundation, identity, tenancy, chart];

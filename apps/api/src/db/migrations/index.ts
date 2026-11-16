import type { Migration } from '@talk2tax/document-db';
import foundation from './20261109090000_foundation';

/** In order. Never edit a migration that has been applied anywhere; add a new one. */
export const MIGRATIONS: readonly Migration[] = [foundation];

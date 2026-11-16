import catalog from './catalog.json';

/**
 * The schema's CHECK constraints and foreign keys, as PostgreSQL had them
 * (scripts/snapshot-constraints.sh), for the API to enforce on MongoDB records.
 */
export interface ForeignKey {
  name: string;
  table: string;
  columns: string[];
  references: string;
  referencedColumns: string[];
  onDelete: 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT' | 'NO ACTION';
  onUpdate: 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT' | 'NO ACTION';
  deferrable: boolean;
}

export interface Check {
  name: string;
  def: string;
}

export const foreignKeys = (): ForeignKey[] => catalog.foreignKeys as ForeignKey[];
export const checksOf = (table: string): Check[] => (catalog.checks as Record<string, Check[]>)[table] ?? [];

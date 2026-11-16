import catalog from './catalog.json';

/**
 * The schema's CHECK constraints, foreign keys and unique indexes, as PostgreSQL had them
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

export interface UniqueIndex {
  name: string;
  table: string;
  /** Each key: a column name, or an expression (`lower((name)::text)`). */
  keys: string[];
  /** A partial index's predicate, or null. */
  where: string | null;
}

const uniques = new Map<string, UniqueIndex[]>();
export const uniquesOf = (table: string): UniqueIndex[] => {
  if (!uniques.size) for (const u of catalog.uniques as UniqueIndex[]) (uniques.get(u.table) ?? uniques.set(u.table, []).get(u.table)!).push(u);
  return uniques.get(table) ?? [];
};

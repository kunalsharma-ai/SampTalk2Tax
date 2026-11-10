#!/bin/bash
# Writes the PostgreSQL CHECK constraints and foreign keys of the public schema to
# src/db/constraints/catalog.json, which the API enforces in MongoDB. Run it against a database
# with every migration applied: scripts/snapshot-constraints.sh postgresql://...
set -euo pipefail
URL=${1:?usage: snapshot-constraints.sh <postgres url>}
OUT="$(dirname "$0")/../src/db/constraints/catalog.json"
psql "$URL" -qtA <<'SQL' | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin), indent=1, sort_keys=True))' > "$OUT"
SELECT json_build_object(
  'checks', (SELECT json_object_agg(t, c) FROM (
      SELECT rel::text AS t, json_agg(json_build_object('name', conname, 'def', def) ORDER BY conname) AS c
      FROM (SELECT conrelid::regclass AS rel, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE contype = 'c' AND connamespace = 'public'::regnamespace) x GROUP BY rel) y),
  'foreignKeys', (SELECT json_agg(json_build_object(
        'name', c.conname, 'table', c.conrelid::regclass::text, 'columns', (SELECT json_agg(a.attname ORDER BY k.i) FROM unnest(c.conkey) WITH ORDINALITY k(n, i) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n),
        'references', c.confrelid::regclass::text, 'referencedColumns', (SELECT json_agg(a.attname ORDER BY k.i) FROM unnest(c.confkey) WITH ORDINALITY k(n, i) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n),
        'onDelete', CASE c.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END,
        'onUpdate', CASE c.confupdtype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END,
        'deferrable', c.condeferrable) ORDER BY c.conrelid::regclass::text, c.conname)
      FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace)
);
SQL
echo "wrote $OUT"

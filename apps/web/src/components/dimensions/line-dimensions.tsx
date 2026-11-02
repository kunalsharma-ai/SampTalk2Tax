'use client';
import { Select } from '@talk2tax/ui';
import { lineChoices, type DimensionValue } from '@/lib/dimensions';

/**
 * The department and project pickers under a line's account. Shown only when the organisation
 * has departments or projects, so books that do not use them see no extra fields.
 */
export function LineDimensions({
  values,
  line,
  departmentId,
  projectId,
  onChange,
}: {
  values: DimensionValue[] | undefined;
  line: number;
  departmentId: string;
  projectId: string;
  onChange: (patch: { departmentId?: string; projectId?: string }) => void;
}) {
  const departments = lineChoices(values, 'DEPARTMENT', departmentId);
  const projects = lineChoices(values, 'PROJECT', projectId);
  if (!departments.length && !projects.length) return null;
  return (
    <div className="mt-1.5 grid grid-cols-2 gap-2">
      {departments.length ? (
        <Select aria-label={`Department for line ${line}`} className="h-8 min-w-0 text-xs" value={departmentId} onChange={(e) => onChange({ departmentId: e.target.value })}>
          <option value="">Department</option>
          {departments.map((v) => <option key={v.id} value={v.id} title={v.code}>{v.name}{v.isActive ? '' : ' (inactive)'}</option>)}
        </Select>
      ) : null}
      {projects.length ? (
        <Select aria-label={`Project for line ${line}`} className="h-8 min-w-0 text-xs" value={projectId} onChange={(e) => onChange({ projectId: e.target.value })}>
          <option value="">Project</option>
          {projects.map((v) => <option key={v.id} value={v.id} title={v.code}>{v.name}{v.isActive ? '' : ' (inactive)'}</option>)}
        </Select>
      ) : null}
    </div>
  );
}

/** The department and project names of a saved line, for read-only views. */
export function LineDimensionTags({ values, departmentId, projectId }: { values: DimensionValue[] | undefined; departmentId: string | null; projectId: string | null }) {
  const find = (id: string | null) => (id ? values?.find((v) => v.id === id) : undefined);
  const d = find(departmentId);
  const p = find(projectId);
  if (!d && !p) return null;
  return (
    <p className="mt-0.5 flex flex-wrap gap-1.5 text-xs">
      {d ? <span className="rounded bg-accent/10 px-1.5 py-0.5 text-accent" title="Department">{d.name}</span> : null}
      {p ? <span className="rounded bg-violet/10 px-1.5 py-0.5 text-violet" title="Project">{p.name}</span> : null}
    </p>
  );
}

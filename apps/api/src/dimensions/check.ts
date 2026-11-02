import { HttpStatus } from '@nestjs/common';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';

/**
 * Check the departments and projects on lines: each must be one of the organisation's, of the
 * right kind, and active (unless reversing or reposting what was already accepted).
 */
export async function checkLineDimensions(db: Tx | PrismaService, orgId: string, lines: { departmentId?: string | null; projectId?: string | null }[], opts: { allowInactive?: boolean; code?: string } = {}) {
  const ids = [...new Set(lines.flatMap((l) => [l.departmentId, l.projectId]).filter((x): x is string => !!x))];
  if (!ids.length) return;
  const values = await db.dimensionValue.findMany({ where: { orgId, id: { in: ids } }, select: { id: true, type: true, code: true, isActive: true } });
  const byId = new Map(values.map((v) => [v.id, v]));
  const errors: string[] = [];
  lines.forEach((l, i) => {
    for (const [id, type, label] of [[l.departmentId, 'DEPARTMENT', 'department'], [l.projectId, 'PROJECT', 'project']] as const) {
      if (!id) continue;
      const v = byId.get(id);
      if (!v || v.type !== type) errors.push(`Line ${i + 1}: ${label} not found`);
      else if (!v.isActive && !opts.allowInactive) errors.push(`Line ${i + 1}: ${label} ${v.code} is inactive`);
    }
  });
  if (errors.length) throw new DomainError(opts.code ?? 'INVALID_DIMENSION', errors[0]!, HttpStatus.UNPROCESSABLE_ENTITY, { errors, issues: errors });
}

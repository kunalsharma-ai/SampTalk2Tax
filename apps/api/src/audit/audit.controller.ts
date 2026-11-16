import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { AuditService } from './audit.service';

const ListQuery = z.object({
  entityType: z.string().max(64).optional(),
  entityId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  beforeId: z.string().regex(/^\d+$/).optional(),
});

@ApiTags('audit')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/audit-events')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermission('audit.read')
  list(@Param('orgId') orgId: string, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.audit.list(orgId, { ...q, beforeId: q.beforeId ? BigInt(q.beforeId) : undefined });
  }

  @Get('verify')
  @RequirePermission('audit.read')
  verify(@Param('orgId') orgId: string) {
    return this.audit.verify(orgId);
  }
}

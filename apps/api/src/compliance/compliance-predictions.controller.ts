import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentOrg, OrgContext, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { CompliancePredictionsService } from './compliance-predictions.service';

const Q = z.object({ days: z.coerce.number().int().min(7).max(120).default(60) }).strict();

/** Compliance deadline predictions (TAX-047). */
@ApiTags('compliance')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/compliance/predictions')
export class CompliancePredictionsController {
  constructor(private readonly predictions: CompliancePredictionsService) {}

  @Get()
  @RequirePermission('reports.read')
  get(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(Q)) q: z.infer<typeof Q>) {
    return this.predictions.predict(org, q.days);
  }
}

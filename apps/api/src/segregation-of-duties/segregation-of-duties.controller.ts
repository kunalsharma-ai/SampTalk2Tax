import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { SegregationOfDutiesService } from './segregation-of-duties.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const PeriodQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() }).strict();
const ReviewBody = z
  .object({
    key: z.string().regex(/^[A-Z_]+:[0-9a-f-]{36}$/, 'Not a finding'),
    date: isoDate,
    reason: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(500, 'Keep the reason under 500 characters'),
  })
  .strict();

@ApiTags('audit')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/segregation-of-duties')
export class SegregationOfDutiesController {
  constructor(private readonly sod: SegregationOfDutiesService) {}

  /** Places one person did two jobs that should be split over a period (the last 90 days by default), and the conflicting duties each member's role holds. */
  @Get()
  @RequirePermission('audit.read')
  overview(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Query(new ZodPipe(PeriodQuery)) q: z.infer<typeof PeriodQuery>) {
    return this.sod.overview(org, user, q);
  }

  /** Clears a finding with a reason. Only someone who was not involved may. */
  @Post('reviews')
  @RequirePermission('approvals.decide')
  @ApiBody({ schema: openApi(ReviewBody) })
  review(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(ReviewBody)) body: z.infer<typeof ReviewBody>) {
    return this.sod.review(org, user, body);
  }
}

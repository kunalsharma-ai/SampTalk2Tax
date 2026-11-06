import { Body, Controller, Delete, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { BENCHMARK_INDUSTRIES, BENCHMARK_METRICS, BENCHMARK_SIZE_BANDS, type BenchmarkIndustry, type BenchmarkMetricKey, type BenchmarkSizeBand } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission, RequireFlag } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { BenchmarkingService } from './benchmarking.service';

const JoinBody = z
  .object({
    industry: z.enum(BENCHMARK_INDUSTRIES.map((i) => i.key) as [BenchmarkIndustry, ...BenchmarkIndustry[]], { message: 'Choose an industry from the list' }),
    sizeBand: z.enum(BENCHMARK_SIZE_BANDS.map((s) => s.key) as [BenchmarkSizeBand, ...BenchmarkSizeBand[]], { message: 'Choose a size band from the list' }),
    headcount: z.number().int('Headcount is a whole number').min(1, 'Headcount is at least 1').max(10_000_000).nullable(),
    metrics: z
      .array(z.enum(BENCHMARK_METRICS.map((m) => m.key) as [BenchmarkMetricKey, ...BenchmarkMetricKey[]], { message: 'Unknown metric' }))
      .min(1, 'Choose at least one metric to share')
      .refine((a) => new Set(a).size === a.length, 'A metric is listed twice'),
    consent: z.literal(true, { message: 'Agree to the terms to take part' }),
  })
  .strict();

/**
 * Privacy-preserving benchmarking. Anyone who can read reports sees this organisation's own
 * metrics and, once it takes part, how they compare. Joining, changing what is shared, refreshing
 * and withdrawing need org.manage (owners and admins), because they decide what leaves the
 * organisation.
 */
@ApiTags('benchmarking')
@ApiBearerAuth()
@RequireFlag('benchmarking')
@Controller('v1/orgs/:orgId/benchmarking')
export class BenchmarkingController {
  constructor(private readonly svc: BenchmarkingService) {}

  @Get()
  @RequirePermission('reports.read')
  overview(@CurrentOrg() org: OrgContext) {
    return this.svc.overview(org);
  }

  @Put('participation')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(JoinBody) })
  join(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(JoinBody)) b: z.infer<typeof JoinBody>) {
    return this.svc.join(org, user, b);
  }

  @Post('participation/refresh')
  @HttpCode(200)
  @RequirePermission('org.manage')
  refresh(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser) {
    return this.svc.refresh(org, user);
  }

  @Delete('participation')
  @RequirePermission('org.manage')
  withdraw(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser) {
    return this.svc.withdraw(org, user);
  }
}

import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AI_AGENTS, type AiAgentId } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { AiDecisionsService } from './ai-decisions.service';

const ListQuery = z
  .object({
    agent: z.enum(Object.keys(AI_AGENTS) as [AiAgentId, ...AiAgentId[]]).optional(),
    subjectId: z.uuid().optional(),
    outcome: z.enum(['ANSWERED', 'FAILED']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.iso.datetime().optional(),
  })
  .strict();
const PerformanceQuery = z.object({ days: z.coerce.number().pipe(z.union([z.literal(7), z.literal(30), z.literal(90)])).default(30) }).strict();

@ApiTags('ai')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/ai-decisions')
export class AiDecisionsController {
  constructor(private readonly decisions: AiDecisionsService) {}

  /** Every call to an AI model, newest first (the explainable AI ledger). */
  @Get()
  @RequirePermission('audit.read')
  list(@Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.decisions.list(q);
  }

  /** How the AI performed over the last 7, 30 or 90 days (PERF-020): calls, failures, time taken and tokens, per agent and per day. */
  @Get('performance')
  @RequirePermission('audit.read')
  performance(@Query(new ZodPipe(PerformanceQuery)) q: z.infer<typeof PerformanceQuery>) {
    return this.decisions.performance(q.days);
  }
}

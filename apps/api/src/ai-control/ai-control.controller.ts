import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { AGENT_KEYS, AiControlService } from './ai-control.service';

const agent = z.enum(AGENT_KEYS as [string, ...string[]], { message: 'Not an AI agent' });
const AgentBody = z
  .object({
    enabled: z.boolean(),
    monthlyTokenLimit: z.number().int('Use a whole number of tokens').min(1000, 'A budget is at least 1,000 tokens').max(1_000_000_000, 'A budget is at most 1,000,000,000 tokens').nullable(),
  })
  .strict();
const money = z.string().trim().regex(/^\d{1,6}(\.\d{1,4})?$/, 'Use a price in US dollars per million tokens, up to 4 decimal places').refine((v) => Number(v) <= 100_000, 'A price is at most 100,000 per million tokens');
const PriceBody = z.object({ model: z.string().trim().min(1, 'Name the model').max(100, 'Keep the model name under 100 characters'), inputPerMillion: money, outputPerMillion: money }).strict();
const ModelsBody = z.object({ allowed: z.array(z.string().trim().min(1).max(100)).max(20) }).strict();
const RemovePriceBody = z.object({ model: z.string().trim().min(1, 'Name the model').max(100) }).strict();
const StopBody = z.object({ reason: z.string().trim().min(10, 'Say why AI is being stopped (at least 10 characters)').max(500, 'Keep the reason under 500 characters') }).strict();

@ApiTags('ai-control')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/ai-control')
export class AiControlController {
  constructor(private readonly control: AiControlService) {}

  /** Every AI agent: what it may do, whether it is on, this month's usage against its budget, and how often people accept what it proposes. */
  @Get()
  @RequirePermission('audit.read')
  overview(@CurrentOrg() org: OrgContext) {
    return this.control.overview({ orgId: org.id, role: org.role });
  }

  /** Turn one agent on or off, and set its monthly token budget (null for none). */
  @Put('agents/:agent')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(AgentBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('agent', new ZodPipe(agent)) a: string, @Body(new ZodPipe(AgentBody)) b: z.infer<typeof AgentBody>) {
    return this.control.updateAgent({ orgId: org.id, role: org.role }, user, a as never, b);
  }

  /** Set what one model costs per million input and output tokens, in US dollars, so usage shows its cost. */
  @Put('prices')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(PriceBody) })
  setPrice(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(PriceBody)) b: z.infer<typeof PriceBody>) {
    return this.control.setPrice({ orgId: org.id, role: org.role }, user, b);
  }

  /** The models this organisation allows (SEC-034); [] = every model Talk2Tax allows. */
  @Put('models')
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(ModelsBody) })
  saveModels(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(ModelsBody)) b: z.infer<typeof ModelsBody>) {
    return this.control.saveModels({ orgId: org.id, role: org.role }, user, b.allowed);
  }

  @Post('prices/remove')
  @HttpCode(200)
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(RemovePriceBody) })
  removePrice(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(RemovePriceBody)) b: z.infer<typeof RemovePriceBody>) {
    return this.control.removePrice({ orgId: org.id, role: org.role }, user, b.model);
  }

  /** Emergency stop: turn AI off for the whole organisation now, with a reason. Running work stops before its next model call. */
  @Post('stop')
  @HttpCode(200)
  @RequirePermission('org.manage')
  @ApiBody({ schema: openApi(StopBody) })
  stop(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(StopBody)) b: z.infer<typeof StopBody>) {
    return this.control.stop({ orgId: org.id, role: org.role }, user, b.reason);
  }

  /** Turn AI back on. */
  @Post('resume')
  @HttpCode(200)
  @RequirePermission('org.manage')
  resume(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser) {
    return this.control.resume({ orgId: org.id, role: org.role }, user);
  }
}

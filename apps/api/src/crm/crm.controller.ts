import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { DEAL_STAGES, LEAD_SOURCES, LEAD_STATUSES } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { CrmService } from './crm.service';

const id = z.string().uuid('Not a valid id');
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-12-31')
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d, 'Not a real date');
const amount = z.string().trim().regex(/^\d{1,15}(\.\d{1,6})?$/, 'Use an amount like 250000.00');
const text = (max: number) => z.string().trim().max(max, `Keep it under ${max} characters`).nullish();
const name = (what: string) => z.string().trim().min(1, `Give the ${what} a name`).max(200, 'Keep the name under 200 characters');
const probability = z.number().int('Use a whole percentage').min(0, 'From 0 to 100').max(100, 'From 0 to 100');

const LeadBody = z
  .object({
    name: name('lead'),
    company: text(200),
    email: z.string().trim().max(254).email('Not an email address').nullish().or(z.literal('')),
    phone: text(40),
    source: z.enum(LEAD_SOURCES),
    ownerId: id.nullish(),
    estimatedValue: amount.nullish().or(z.literal('')),
    notes: text(2000),
  })
  .strict();
const LeadStatusBody = z.object({ status: z.enum(LEAD_STATUSES), reason: text(500) }).strict();
const ConvertBody = z
  .object({
    contactId: id.nullish(),
    deal: z.object({ name: name('deal'), amount, expectedCloseDate: date }).strict().nullish(),
  })
  .strict();
const DealBody = z.object({ name: name('deal'), contactId: z.string().uuid('Choose the customer'), amount, expectedCloseDate: date, ownerId: id.nullish(), notes: text(2000) }).strict();
const NewDealBody = DealBody.extend({ stage: z.enum(DEAL_STAGES).optional(), probability: probability.nullish() }).strict();
const MoveBody = z.object({ stage: z.enum(DEAL_STAGES), probability: probability.nullish(), lostReason: text(500) }).strict();
const ActivityBody = z.object({ leadId: id.nullish(), dealId: id.nullish(), kind: z.enum(['NOTE', 'CALL', 'EMAIL', 'MEETING']), body: z.string().trim().min(1, 'Write what happened').max(4000, 'Keep it under 4000 characters') }).strict();
const LeadQuery = z.object({ status: z.enum(LEAD_STATUSES).optional(), ownerId: id.optional(), q: z.string().trim().max(100).optional() });
const DealQuery = z.object({ stage: z.enum(DEAL_STAGES).optional(), ownerId: id.optional(), contactId: id.optional(), q: z.string().trim().max(100).optional(), view: z.enum(['open', 'closed', 'all']).optional() });

const blank = <T extends { email?: string | null; estimatedValue?: string | null }>(b: T) => ({ ...b, email: b.email || null, estimatedValue: b.estimatedValue || null });

@ApiTags('crm')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/crm')
export class CrmController {
  constructor(private readonly crm: CrmService) {}

  /** Members leads and deals can be given to. */
  @Get('owners')
  @RequirePermission('sales.read')
  owners(@CurrentOrg() org: OrgContext) {
    return this.crm.owners(org);
  }

  /** Leads, newest work first, with counts by status. */
  @Get('leads')
  @RequirePermission('sales.read')
  leads(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(LeadQuery)) q: z.infer<typeof LeadQuery>) {
    return this.crm.listLeads(org, q);
  }

  /** One lead with its timeline and likely duplicates (same email). */
  @Get('leads/:id')
  @RequirePermission('sales.read')
  lead(@CurrentOrg() org: OrgContext, @Param('id', new ZodPipe(id)) leadId: string) {
    return this.crm.getLead(org, leadId);
  }

  @Post('leads')
  @RequirePermission('crm.manage')
  @ApiBody({ schema: openApi(LeadBody) })
  createLead(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(LeadBody)) b: z.infer<typeof LeadBody>) {
    return this.crm.createLead(org, user, blank(b));
  }

  @Put('leads/:id')
  @RequirePermission('crm.manage')
  @ApiBody({ schema: openApi(LeadBody) })
  updateLead(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) leadId: string, @Body(new ZodPipe(LeadBody)) b: z.infer<typeof LeadBody>) {
    return this.crm.updateLead(org, user, leadId, blank(b));
  }

  /** Mark a lead contacted, qualified or disqualified (with a reason), or reopen it. */
  @Post('leads/:id/status')
  @RequirePermission('crm.manage')
  @ApiBody({ schema: openApi(LeadStatusBody) })
  leadStatus(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) leadId: string, @Body(new ZodPipe(LeadStatusBody)) b: z.infer<typeof LeadStatusBody>) {
    return this.crm.setLeadStatus(org, user, leadId, b);
  }

  /** Convert a qualified lead into a customer (new or existing), optionally with a deal. */
  @Post('leads/:id/convert')
  @RequirePermission('crm.manage')
  @ApiBody({ schema: openApi(ConvertBody) })
  convert(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) leadId: string, @Body(new ZodPipe(ConvertBody)) b: z.infer<typeof ConvertBody>) {
    return this.crm.convertLead(org, user, leadId, b);
  }

  /** Deals (open by default) with the pipeline summary and weighted value by close month. */
  @Get('deals')
  @RequirePermission('sales.read')
  deals(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(DealQuery)) q: z.infer<typeof DealQuery>) {
    return this.crm.listDeals(org, q);
  }

  @Get('deals/:id')
  @RequirePermission('sales.read')
  deal(@CurrentOrg() org: OrgContext, @Param('id', new ZodPipe(id)) dealId: string) {
    return this.crm.getDeal(org, dealId);
  }

  @Post('deals')
  @RequirePermission('crm.manage')
  @ApiBody({ schema: openApi(NewDealBody) })
  createDeal(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(NewDealBody)) b: z.infer<typeof NewDealBody>) {
    return this.crm.createDeal(org, user, b);
  }

  @Put('deals/:id')
  @RequirePermission('crm.manage')
  @ApiBody({ schema: openApi(DealBody) })
  updateDeal(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) dealId: string, @Body(new ZodPipe(DealBody)) b: z.infer<typeof DealBody>) {
    return this.crm.updateDeal(org, user, dealId, b);
  }

  /** Move a deal to another stage, change its probability, win it, lose it (with a reason) or reopen it. */
  @Post('deals/:id/stage')
  @RequirePermission('crm.manage')
  @ApiBody({ schema: openApi(MoveBody) })
  move(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) dealId: string, @Body(new ZodPipe(MoveBody)) b: z.infer<typeof MoveBody>) {
    return this.crm.moveDeal(org, user, dealId, b);
  }

  /** Log a note, call, email or meeting on a lead or a deal. */
  @Post('activities')
  @RequirePermission('crm.manage')
  @ApiBody({ schema: openApi(ActivityBody) })
  log(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(ActivityBody)) b: z.infer<typeof ActivityBody>) {
    return this.crm.logActivity(org, user, b);
  }
}

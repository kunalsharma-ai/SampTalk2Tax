import { Body, Controller, Get, HttpStatus, NotFoundException, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, Public } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { ContactsService } from '../contacts/contacts.service';
import { blank, ConvertBody, DealBody, DealQuery, LeadBody, LeadQuery, LeadStatusBody, MoveBody, NewDealBody } from '../crm/crm.controller';
import { CrmService } from '../crm/crm.service';
import { ApiKeyGuard, RequireScope } from './api-key.guard';
import type { ApiKeyCaller } from './api-keys.service';

const id = z.string().uuid('Not a valid id');
const externalRef = z.string().trim().min(1).max(100, 'Keep the external id under 100 characters').nullish();
const NewLead = LeadBody.extend({ externalRef }).strict();
const NewDeal = NewDealBody.extend({ externalRef }).strict();
const CustomerQuery = z.object({ q: z.string().trim().max(100).optional(), includeInactive: z.enum(['true', 'false']).optional().transform((v) => v === 'true') });

/**
 * The CRM API for another system (a CRM, a website form, a marketing tool): leads, deals and
 * customers of one organisation, authenticated with an API key made under Settings → Integrations.
 * The same rules apply as in the app, and every change is in the audit trail with the key used.
 */
@ApiTags('crm-api')
@ApiBearerAuth()
@Public()
@UseGuards(ApiKeyGuard)
@Controller('v1/crm-api')
export class CrmApiController {
  constructor(
    private readonly crm: CrmService,
    private readonly contacts: ContactsService,
  ) {}

  /** The organisation and the key in use: a quick way to check a key works. */
  @Get('me')
  @RequireScope('crm.read')
  me(@Req() req: { apiKey: ApiKeyCaller }) {
    const k = req.apiKey;
    return { organisationId: k.org.id, currency: k.org.functionalCurrency, key: { prefix: k.prefix, scopes: k.scopes }, actsAs: { name: k.user.name, role: k.org.role } };
  }

  @Get('leads')
  @RequireScope('crm.read')
  leads(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(LeadQuery)) q: z.infer<typeof LeadQuery>) {
    return this.crm.listLeads(org, q);
  }

  @Get('leads/:id')
  @RequireScope('crm.read')
  lead(@CurrentOrg() org: OrgContext, @Param('id', new ZodPipe(id)) leadId: string) {
    return this.crm.getLead(org, leadId);
  }

  /** Creates a lead. With externalRef, sending the same lead again returns the first one (200) instead of a copy. */
  @Post('leads')
  @RequireScope('crm.write')
  @ApiBody({ schema: openApi(NewLead) })
  async createLead(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(NewLead)) b: z.infer<typeof NewLead>, @Res({ passthrough: true }) res: Response) {
    const r = await this.crm.createLeadOnce(org, user, blank(b));
    res.status(r.created ? HttpStatus.CREATED : HttpStatus.OK);
    return r.lead;
  }

  @Put('leads/:id')
  @RequireScope('crm.write')
  @ApiBody({ schema: openApi(LeadBody) })
  updateLead(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) leadId: string, @Body(new ZodPipe(LeadBody)) b: z.infer<typeof LeadBody>) {
    return this.crm.updateLead(org, user, leadId, blank(b));
  }

  @Post('leads/:id/status')
  @RequireScope('crm.write')
  @ApiBody({ schema: openApi(LeadStatusBody) })
  leadStatus(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) leadId: string, @Body(new ZodPipe(LeadStatusBody)) b: z.infer<typeof LeadStatusBody>) {
    return this.crm.setLeadStatus(org, user, leadId, b);
  }

  /** Converts a qualified lead into a customer, optionally with a deal. */
  @Post('leads/:id/convert')
  @RequireScope('crm.write')
  @ApiBody({ schema: openApi(ConvertBody) })
  convert(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) leadId: string, @Body(new ZodPipe(ConvertBody)) b: z.infer<typeof ConvertBody>) {
    return this.crm.convertLead(org, user, leadId, b);
  }

  @Get('deals')
  @RequireScope('crm.read')
  deals(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(DealQuery)) q: z.infer<typeof DealQuery>) {
    return this.crm.listDeals(org, q);
  }

  @Get('deals/:id')
  @RequireScope('crm.read')
  deal(@CurrentOrg() org: OrgContext, @Param('id', new ZodPipe(id)) dealId: string) {
    return this.crm.getDeal(org, dealId);
  }

  /** Creates a deal for a customer. With externalRef, sending it again returns the first one (200). */
  @Post('deals')
  @RequireScope('crm.write')
  @ApiBody({ schema: openApi(NewDeal) })
  async createDeal(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(NewDeal)) b: z.infer<typeof NewDeal>, @Res({ passthrough: true }) res: Response) {
    const r = await this.crm.createDealOnce(org, user, b);
    res.status(r.created ? HttpStatus.CREATED : HttpStatus.OK);
    return r.deal;
  }

  @Put('deals/:id')
  @RequireScope('crm.write')
  @ApiBody({ schema: openApi(DealBody) })
  updateDeal(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) dealId: string, @Body(new ZodPipe(DealBody)) b: z.infer<typeof DealBody>) {
    return this.crm.updateDeal(org, user, dealId, b);
  }

  @Post('deals/:id/stage')
  @RequireScope('crm.write')
  @ApiBody({ schema: openApi(MoveBody) })
  move(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) dealId: string, @Body(new ZodPipe(MoveBody)) b: z.infer<typeof MoveBody>) {
    return this.crm.moveDeal(org, user, dealId, b);
  }

  /** Customers (active by default), with what they owe. */
  @Get('customers')
  @RequireScope('crm.read')
  customers(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(CustomerQuery)) q: z.infer<typeof CustomerQuery>) {
    return this.contacts.list(org, { role: 'customer', q: q.q, includeInactive: q.includeInactive });
  }

  @Get('customers/:id')
  @RequireScope('crm.read')
  async customer(@CurrentOrg() org: OrgContext, @Param('id', new ZodPipe(id)) contactId: string) {
    const c = await this.contacts.get(org, contactId);
    if (!(c as { isCustomer?: boolean }).isCustomer) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Customer not found' });
    return c;
  }
}

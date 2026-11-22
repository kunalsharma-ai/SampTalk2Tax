import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, openApi, ZodPipe } from '../common/zod';
import { VendorContractsService } from './vendor-contracts.service';

const id = z.string().uuid('Not a valid id');
const amount = z.string().regex(/^\d{1,15}(\.\d{1,6})?$/, 'Give an amount such as 1250.50');
const CreateBody = z
  .object({
    contactId: id,
    title: z.string().trim().min(1, 'Give the contract a title').max(200),
    vendorReference: z.string().trim().max(100).nullish(),
    startDate: isoDate,
    endDate: isoDate,
    paymentTermsDays: z.number().int().min(0).max(365).nullish(),
    spendCap: amount.nullish(),
    itemsOnly: z.boolean().optional(),
    prices: z.array(z.object({ hsnCode: z.string().trim().max(10).nullish(), description: z.string().trim().max(200).nullish(), unitPrice: amount }).strict()).max(200).default([]),
    note: z.string().max(1000).nullish(),
  })
  .strict();
const TerminateBody = z.object({ reason: z.string().trim().min(1, 'Say why the contract is terminated').max(1000), date: isoDate.optional() }).strict();

@ApiTags('vendor contracts')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/purchases/vendor-contracts')
export class VendorContractsController {
  constructor(private readonly contracts: VendorContractsService) {}

  /** Every vendor contract with its compliance, and every finding on bills, most serious first. */
  @Get()
  @RequirePermission('purchases.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.contracts.list(org);
  }

  @Get(':contractId')
  @RequirePermission('purchases.read')
  get(@CurrentOrg() org: OrgContext, @Param('contractId', new ZodPipe(id)) contractId: string) {
    return this.contracts.get(org, contractId);
  }

  /** Record a contract: period, payment terms, spend cap and price list. */
  @Post()
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(CreateBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>) {
    return this.contracts.create(org, user, body);
  }

  /** End a contract early; bills after the date count as outside its term. */
  @Post(':contractId/terminate')
  @HttpCode(200)
  @RequirePermission('purchases.manage')
  @ApiBody({ schema: openApi(TerminateBody) })
  terminate(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('contractId', new ZodPipe(id)) contractId: string, @Body(new ZodPipe(TerminateBody)) body: z.infer<typeof TerminateBody>) {
    return this.contracts.terminate(org, user, contractId, body);
  }
}

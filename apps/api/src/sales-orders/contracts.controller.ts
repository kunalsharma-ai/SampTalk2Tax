import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { CONTRACT_FREQUENCIES } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { decimalString, isoDate, openApi, ZodPipe } from '../common/zod';
import { ContractsService } from './contracts.service';

const id = z.string().uuid('Not a valid id');
const text = (max: number) => z.string().trim().max(max, `Keep it under ${max} characters`).nullish();
const Line = z
  .object({
    accountId: z.string().uuid('Choose an income account'),
    description: text(500),
    quantity: decimalString,
    unitPrice: decimalString,
    taxRateId: z.string().uuid().nullish(),
    hsnCode: z.string().trim().max(8).nullish(),
  })
  .strict();
const ContractBody = z
  .object({
    contactId: z.string().uuid('Choose the customer'),
    dealId: id.nullish(),
    title: z.string().trim().min(1, 'Give the contract a title').max(200),
    frequency: z.enum(CONTRACT_FREQUENCIES),
    timing: z.enum(['ADVANCE', 'ARREARS']),
    startDate: isoDate,
    endDate: isoDate.nullish(),
    autoRenew: z.boolean(),
    renewalMonths: z.number().int().min(1).max(120).nullish(),
    noticeDays: z.number().int().min(0).max(365),
    paymentTermsDays: z.number().int().min(0).max(365).nullish(),
    placeOfSupply: z.string().regex(/^\d{2}$/).nullish(),
    reference: text(100),
    memo: text(1000),
    lines: z.array(Line).min(1, 'Add at least one line').max(200),
  })
  .strict();
const ReasonBody = z.object({ reason: z.string().trim().min(1, 'Give a reason').max(500) }).strict();
const RenewBody = z.object({ months: z.number().int().min(1).max(120), upliftPercent: decimalString.nullish() }).strict();
const ListQuery = z.object({ view: z.enum(['active', 'renewals', 'draft', 'closed', 'all']).optional(), contactId: id.optional(), dealId: id.optional() });

@ApiTags('sales')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/sales/contracts')
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  /** Contracts with MRR, ARR and renewals due. */
  @Get()
  @RequirePermission('sales.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.contracts.list(org, q);
  }

  /** Bill every active contract's due periods now (the runner also does this in the background). */
  @Post('bill-due')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  billOrg(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser) {
    return this.contracts.billOrg(org, user);
  }

  @Get(':id')
  @RequirePermission('sales.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', new ZodPipe(id)) contractId: string) {
    return this.contracts.get(org, contractId);
  }

  @Post()
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(ContractBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(ContractBody)) b: z.infer<typeof ContractBody>) {
    return this.contracts.create(org, user, b);
  }

  @Put(':id')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(ContractBody) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) contractId: string, @Body(new ZodPipe(ContractBody)) b: z.infer<typeof ContractBody>) {
    return this.contracts.update(org, user, contractId, b);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('sales.manage')
  async remove(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) contractId: string) {
    await this.contracts.remove(org, user, contractId);
  }

  /** Start billing; periods already due are billed straight away. */
  @Post(':id/activate')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  activate(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) contractId: string) {
    return this.contracts.activate(org, user, contractId);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  pause(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) contractId: string) {
    return this.contracts.pause(org, user, contractId);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  resume(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) contractId: string) {
    return this.contracts.resume(org, user, contractId);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(ReasonBody) })
  cancel(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) contractId: string, @Body(new ZodPipe(ReasonBody)) b: z.infer<typeof ReasonBody>) {
    return this.contracts.cancel(org, user, contractId, b.reason);
  }

  @Post(':id/renew')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(RenewBody) })
  renew(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) contractId: string, @Body(new ZodPipe(RenewBody)) b: z.infer<typeof RenewBody>) {
    return this.contracts.renew(org, user, contractId, b);
  }

  /** Bill this contract's due periods now. */
  @Post(':id/bill-due')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  billNow(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) contractId: string) {
    return this.contracts.billNow(org, user, contractId);
  }

  /** Bill a period again after its invoice was voided or deleted. */
  @Post(':id/periods/:periodNo/bill-again')
  @RequirePermission('sales.manage')
  billAgain(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) contractId: string, @Param('periodNo', ParseIntPipe) periodNo: number) {
    return this.contracts.billAgain(org, user, contractId, periodNo);
  }
}

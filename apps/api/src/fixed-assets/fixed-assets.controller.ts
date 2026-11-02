import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { FixedAssetsService } from './fixed-assets.service';

const id = z.string().uuid('Not an asset id');
const runId = z.string().uuid('Not a depreciation run id');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-04-01');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month like 2026-04');
const amount = z.string().trim().regex(/^\d{1,15}(\.\d{1,6})?$/, 'Use an amount like 125000.00');
const text = (max: number) => z.string().trim().max(max, `Keep it under ${max} characters`).nullish();
const AssetBody = z
  .object({
    name: z.string().trim().min(1, 'Give the asset a name').max(200, 'Keep the name under 200 characters'),
    category: text(100),
    serialNumber: text(100),
    location: text(200),
    assetAccountId: z.string().uuid('Choose the asset account'),
    accumulatedAccountId: z.string().uuid('Choose the accumulated depreciation account'),
    expenseAccountId: z.string().uuid('Choose the depreciation expense account'),
    acquisitionDate: date,
    inServiceDate: date,
    cost: amount,
    residualValue: amount,
    method: z.enum(['STRAIGHT_LINE', 'WRITTEN_DOWN_VALUE']),
    usefulLifeMonths: z.number().int().nullish(),
    annualRate: z.string().trim().regex(/^\d{1,3}(\.\d{1,4})?$/, 'Use a rate like 15 or 25.89').nullish(),
    openingAccumulated: amount.nullish(),
    depreciatedThrough: month.nullish(),
    fundingAccountId: z.string().uuid().nullish(),
  })
  .strict();
const RunBody = z.object({ month }).strict();
const DisposeBody = z.object({ date, proceeds: amount, proceedsAccountId: z.string().uuid().nullish(), gainLossAccountId: z.string().uuid('Choose where the gain or loss goes'), note: text(500) }).strict();
const DepQuery = z.object({ month: month.optional() }).strict();

@ApiTags('fixed-assets')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/fixed-assets')
export class FixedAssetsController {
  constructor(private readonly assets: FixedAssetsService) {}

  /** The register: every asset with cost, accumulated depreciation and net book value, and totals for active assets. */
  @Get()
  @RequirePermission('journals.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.assets.list(org);
  }

  /** Accounts the asset forms offer, by role. */
  @Get('accounts')
  @RequirePermission('journals.read')
  accounts(@CurrentOrg() org: OrgContext) {
    return this.assets.accounts(org);
  }

  /** Depreciation runs, the next month to post, and what posting a month would charge. */
  @Get('depreciation')
  @RequirePermission('journals.read')
  depreciation(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(DepQuery)) q: z.infer<typeof DepQuery>) {
    return this.assets.depreciation(org, q.month);
  }

  /** Post a month's depreciation as one journal on its last day. */
  @Post('depreciation/runs')
  @RequirePermission('assets.manage')
  @ApiBody({ schema: openApi(RunBody) })
  run(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(RunBody)) b: z.infer<typeof RunBody>) {
    return this.assets.run(org, user, b.month);
  }

  /** Reverse the latest depreciation run. */
  @Post('depreciation/runs/:runId/reverse')
  @HttpCode(200)
  @RequirePermission('assets.manage')
  reverse(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('runId', new ZodPipe(runId)) r: string) {
    return this.assets.reverse(org, user, r);
  }

  /** Add an asset; with fundingAccountId, its purchase is posted too. */
  @Post()
  @RequirePermission('assets.manage')
  @ApiBody({ schema: openApi(AssetBody) })
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(AssetBody)) b: z.infer<typeof AssetBody>) {
    return this.assets.create(org, user, b);
  }

  @Get(':id')
  @RequirePermission('journals.read')
  get(@CurrentOrg() org: OrgContext, @Param('id', new ZodPipe(id)) a: string) {
    return this.assets.get(org, a);
  }

  /** Change an asset; its terms only until depreciation is posted for it. */
  @Put(':id')
  @RequirePermission('assets.manage')
  @ApiBody({ schema: openApi(AssetBody.omit({ fundingAccountId: true })) })
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) a: string, @Body(new ZodPipe(AssetBody.omit({ fundingAccountId: true }))) b: z.infer<typeof AssetBody>) {
    return this.assets.update(org, user, a, b);
  }

  /** Take the asset off the books: proceeds in, cost and accumulated depreciation out, the difference to gain or loss. */
  @Post(':id/dispose')
  @HttpCode(200)
  @RequirePermission('assets.manage')
  @ApiBody({ schema: openApi(DisposeBody) })
  dispose(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', new ZodPipe(id)) a: string, @Body(new ZodPipe(DisposeBody)) b: z.infer<typeof DisposeBody>) {
    return this.assets.dispose(org, user, a, b);
  }
}

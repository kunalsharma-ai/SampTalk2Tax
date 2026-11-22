import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { ContractMatchingService } from './contract-matching.service';

const Pair = { documentId: z.string().uuid('Not a valid invoice'), contractId: z.string().uuid('Not a valid contract') };
const LinkBody = z.object(Pair).strict();
const DismissBody = z.object({ ...Pair, reason: z.string().trim().min(3, 'Say why, for the record').max(500) }).strict();

/** Contract-to-invoice matching (AR-041). */
@ApiTags('sales')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/sales/contract-matching')
export class ContractMatchingController {
  constructor(private readonly matching: ContractMatchingService) {}

  @Get()
  @RequirePermission('sales.read')
  list(@CurrentOrg() org: OrgContext) {
    return this.matching.list(org);
  }

  @Post('link')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(LinkBody) })
  link(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(LinkBody)) b: z.infer<typeof LinkBody>) {
    return this.matching.link(org, user, b);
  }

  @Post('dismiss')
  @HttpCode(200)
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(DismissBody) })
  dismiss(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(DismissBody)) b: z.infer<typeof DismissBody>) {
    return this.matching.dismiss(org, user, b);
  }
}

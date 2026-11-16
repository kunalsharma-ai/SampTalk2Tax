import { BadRequestException, Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { checkGstin, FOREIGN_PLACE_OF_SUPPLY, INDIA_STATES } from '@talk2tax/tax-engine';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, openApi, ZodPipe } from '../common/zod';
import { GstService } from './gst.service';

const RegistrationBody = z
  .object({
    gstin: z.string().trim().min(1).max(20),
    legalName: z.string().trim().max(200).nullable().optional(),
    effectiveFrom: isoDate,
    accounts: z
      .object({
        outputCgstAccountId: z.uuid(),
        outputSgstAccountId: z.uuid(),
        outputIgstAccountId: z.uuid(),
        inputCgstAccountId: z.uuid(),
        inputSgstAccountId: z.uuid(),
        inputIgstAccountId: z.uuid(),
      })
      .optional(),
  })
  .strict();
const GstinBody = z.object({ gstin: z.string().max(20) });
const PeriodQuery = z.object({ from: isoDate, to: isoDate });

function checkPeriod(q: { from: string; to: string }) {
  if (q.from > q.to) throw new BadRequestException({ error: 'INVALID_RANGE', message: '"from" must be on or before "to"' });
  const days = (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000;
  if (days > 366) throw new BadRequestException({ error: 'INVALID_RANGE', message: 'A return period can be at most a year' });
}

@ApiTags('gst')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/gst')
export class GstController {
  constructor(private readonly gst: GstService) {}

  @Get('registration')
  @RequirePermission('accounts.read')
  registration(@CurrentOrg() org: OrgContext) {
    return this.gst.get(org.id);
  }

  /** Create or change the organisation's GST registration. Without `accounts`, the standard GST accounts are created (or reused). */
  @Put('registration')
  @RequirePermission('accounts.manage')
  @ApiBody({ schema: openApi(RegistrationBody) })
  register(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(RegistrationBody)) body: z.infer<typeof RegistrationBody>) {
    return this.gst.register(org.id, user, body);
  }

  /** States and union territories for place of supply, plus 96 for exports. */
  @Get('states')
  @RequirePermission('contacts.read')
  states() {
    return [...INDIA_STATES.map((s) => ({ code: s.code, name: s.name, levies: s.levies })), { code: FOREIGN_PLACE_OF_SUPPLY, name: 'Outside India (export)', levies: null }];
  }

  /** Format and check-character test only; it does not ask the GST portal whether the GSTIN is active. */
  @Post('check-gstin')
  @RequirePermission('contacts.read')
  @ApiBody({ schema: openApi(GstinBody) })
  check(@Body(new ZodPipe(GstinBody)) body: z.infer<typeof GstinBody>) {
    return checkGstin(body.gstin);
  }

  @Get('returns/gstr-1')
  @RequirePermission('reports.read')
  gstr1(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(PeriodQuery)) q: z.infer<typeof PeriodQuery>) {
    checkPeriod(q);
    return this.gst.gstr1(org.id, q.from, q.to);
  }

  @Get('returns/gstr-3b')
  @RequirePermission('reports.read')
  gstr3b(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(PeriodQuery)) q: z.infer<typeof PeriodQuery>) {
    checkPeriod(q);
    return this.gst.gstr3b(org.id, q.from, q.to);
  }
}

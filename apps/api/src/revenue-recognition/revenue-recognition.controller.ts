import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { isoDate, openApi, ZodPipe } from '../common/zod';
import { RevenueRecognitionService } from './revenue-recognition.service';

const Settings = z.object({ deferredAccountId: z.string().uuid('Choose the deferred revenue account') }).strict();
const Lines = z
  .object({
    lines: z
      .array(
        z
          .object({
            lineNo: z.number().int().min(1),
            startDate: isoDate,
            months: z.number().int('Months are whole').min(1, 'At least one month').max(120, 'At most 120 months'),
            method: z.enum(['EVEN', 'DAILY']),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
const OverviewQuery = z.object({ from: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM').optional() });

/** Revenue recognition (AR-028): invoice lines recognised over a service period. */
@ApiTags('sales')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/sales')
export class RevenueRecognitionController {
  constructor(private readonly svc: RevenueRecognitionService) {}

  @Get('revenue-recognition')
  @RequirePermission('sales.read')
  overview(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(OverviewQuery)) q: z.infer<typeof OverviewQuery>) {
    return this.svc.overview(org, q.from);
  }

  @Get('revenue-recognition/settings')
  @RequirePermission('sales.read')
  settings(@CurrentOrg() org: OrgContext) {
    return this.svc.settings(org);
  }

  @Put('revenue-recognition/settings')
  @RequirePermission('sales.read')
  @ApiBody({ schema: openApi(Settings) })
  saveSettings(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodPipe(Settings)) body: z.infer<typeof Settings>) {
    return this.svc.saveSettings(org, user, body.deferredAccountId);
  }

  @Get('documents/:documentId/recognition')
  @RequirePermission('sales.read')
  forDocument(@CurrentOrg() org: OrgContext, @Param('documentId', ParseUUIDPipe) id: string) {
    return this.svc.forDocument(org, id);
  }

  @Put('documents/:documentId/recognition')
  @RequirePermission('sales.manage')
  @ApiBody({ schema: openApi(Lines) })
  setForDocument(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('documentId', ParseUUIDPipe) id: string, @Body(new ZodPipe(Lines)) body: z.infer<typeof Lines>) {
    return this.svc.setForDocument(org, user, id, body.lines);
  }
}

import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthUser, CurrentOrg, CurrentUser, OrgContext, RequirePermission } from '../auth/decorators';
import { ReportExportService } from './report-exports.service';

@ApiTags('reports')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/reports/export')
export class ReportExportsController {
  constructor(private readonly exports: ReportExportService) {}

  /**
   * Downloads a report as CSV, Excel (.xlsx) or PDF. Takes the same parameters as the report's
   * own endpoint plus `format`. The receivables and payables ageing also need sales.read or
   * purchases.read. Every export is recorded in the audit log with the file's SHA-256.
   */
  @Get(':report')
  @RequirePermission('reports.read')
  @ApiQuery({ name: 'format', enum: ['csv', 'xlsx', 'pdf'] })
  async download(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('report') report: string, @Query() query: Record<string, unknown>, @Res() res: Response) {
    const { format, ...params } = query;
    const file = await this.exports.export(org, user, report, typeof format === 'string' ? format : undefined, params);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    res.setHeader('Content-Length', String(file.body.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Report-SHA256', file.sha256);
    res.end(file.body);
  }
}

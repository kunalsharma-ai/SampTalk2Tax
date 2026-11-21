import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentOrg, OrgContext, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { BankActivityService } from './bank-activity.service';

const ActivityQuery = z
  .object({
    days: z.coerce.number().int().min(7).max(365).default(30),
    threshold: z.string().regex(/^\d{1,13}(\.\d{1,4})?$/, 'Enter an amount').refine((v) => /[1-9]/.test(v), 'Enter an amount above zero').optional(),
  })
  .strict();

@ApiTags('banking')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/banking/unusual-activity')
export class BankActivityController {
  constructor(private readonly activity: BankActivityService) {}

  /** Imported bank statement lines with warning signs, most serious first, with what each sign was raised on. */
  @Get()
  @RequirePermission('banking.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(ActivityQuery)) q: z.infer<typeof ActivityQuery>) {
    return this.activity.findings(org, q);
  }
}

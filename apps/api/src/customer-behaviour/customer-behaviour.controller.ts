import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentOrg, OrgContext, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { CustomerBehaviourService } from './customer-behaviour.service';

const BehaviourQuery = z.object({ contactId: z.uuid().optional() }).strict();

@ApiTags('sales')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/customer-behaviour')
export class CustomerBehaviourController {
  constructor(private readonly behaviour: CustomerBehaviourService) {}

  /** How each customer invoiced in the last two years pays and buys, how that is changing, and the signals behind it. */
  @Get()
  @RequirePermission('reports.read')
  list(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(BehaviourQuery)) q: z.infer<typeof BehaviourQuery>) {
    return this.behaviour.analyse(org, q);
  }
}

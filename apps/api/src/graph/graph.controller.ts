import { Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { hasPermission } from '@talk2tax/security';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentOrg, OrgContext, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod';
import { GRAPH_NODE_TYPES, GraphService, type GraphNodeType } from './graph.service';

const NodeType = z.enum(GRAPH_NODE_TYPES as unknown as [GraphNodeType, ...GraphNodeType[]], { message: 'Unknown kind of record' });
const SearchQuery = z.object({ q: z.string().max(100, 'Keep the search under 100 characters') }).strict();

/** The graph shows customers' and vendors' records, so it also needs both ledgers. */
function ledgers(org: OrgContext) {
  if (!hasPermission(org.role, 'sales.read') || !hasPermission(org.role, 'purchases.read')) throw new ForbiddenException({ error: 'FORBIDDEN', message: 'The relationship graph needs access to sales and purchases' });
}

/**
 * The relationship graph: how customers, vendors, documents, payments, journal entries,
 * accounts, projects, loans, fixed assets and alerts connect, each connection explained.
 * Reading it needs reports.read and the ledgers it shows (sales.read and purchases.read).
 */
@ApiTags('graph')
@ApiBearerAuth()
@Controller('v1/orgs/:orgId/graph')
export class GraphController {
  constructor(private readonly svc: GraphService) {}

  @Get('search')
  @RequirePermission('reports.read')
  search(@CurrentOrg() org: OrgContext, @Query(new ZodPipe(SearchQuery)) q: z.infer<typeof SearchQuery>) {
    ledgers(org);
    return this.svc.search(org.id, q.q);
  }

  @Get('nodes/:type/:id')
  @RequirePermission('reports.read')
  node(@CurrentOrg() org: OrgContext, @Param('type', new ZodPipe(NodeType)) type: GraphNodeType, @Param('id', ParseUUIDPipe) id: string) {
    ledgers(org);
    return this.svc.neighbourhood(org.id, type, id);
  }
}

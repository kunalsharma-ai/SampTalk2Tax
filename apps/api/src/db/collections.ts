import type { AnyCollectionDef } from '@talk2tax/document-db';
import { authSessions, loginThrottles, users } from './collections/identity';
import { invitations, memberships, organizations } from './collections/tenancy';

/**
 * Every MongoDB collection the API uses. A collection must be listed here before any code
 * can reach it, and before a $lookup or $unionWith may read it. Modules add their
 * definitions as they move from PostgreSQL (see docs/MONGODB.md › Order of the move).
 */
export const COLLECTIONS: readonly AnyCollectionDef[] = [users, authSessions, loginThrottles, organizations, memberships, invitations];

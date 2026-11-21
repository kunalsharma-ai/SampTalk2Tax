/**
 * External auditor portal (AUDIT-002). An owner or admin gives an external auditor a private,
 * read-only link to one internal audit engagement: its scope, work programme and sign-offs,
 * accepted evidence (files can be opened), findings, samples and the trial balance at the end of
 * the scope. The link always expires, can be withdrawn at any time, and only its SHA-256 is stored.
 */
import { makePortalToken } from './customer-portal';

/** t2ta_ followed by 40 letters and digits (about 238 bits). */
export const AUDITOR_PORTAL_TOKEN_PATTERN = /^t2ta_[A-Za-z0-9]{40}$/;
export const makeAuditorPortalToken = (random: (n: number) => Uint8Array) => `t2ta_${makePortalToken(random).slice(5)}`;
export const auditorPortalTokenPrefix = (token: string) => token.slice(5, 13);

/** How long an auditor link lasts. External access always ends. */
export const AUDITOR_LINK_DAYS = [7, 30, 90] as const;
export const MAX_ACTIVE_AUDITOR_LINKS = 10;

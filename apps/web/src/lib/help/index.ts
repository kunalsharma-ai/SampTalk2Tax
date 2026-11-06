import { PAGE_HELP } from './pages';
import { SECTION_HELP } from './sections';
import type { Help } from './types';

export type { Help } from './types';
export { PAGE_HELP, SECTION_HELP };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH = /^\d{4}-\d{2}$/;
/** An invitation token or similar: long, and with at least one digit (no route segment has one). */
const TOKEN = /^(?=.*\d)[A-Za-z0-9_-]{16,}$/;

/**
 * The help key for a path: without the organisation part, ids as [id] and a month as [month].
 * `/orgs/<uuid>/sales/contracts/<uuid>/edit` → `sales/contracts/[id]/edit`.
 */
export function helpRoute(pathname: string): string {
  const parts = pathname.split(/[?#]/)[0]!.split('/').filter(Boolean);
  const rest = parts[0] === 'orgs' && parts[1] ? parts.slice(2) : parts;
  if (rest[0] === 'invite' && rest.length === 2) return 'invite/[id]';
  return rest.map((p) => (MONTH.test(p) ? '[month]' : UUID.test(p) || /^\d+$/.test(p) || TOKEN.test(p) ? '[id]' : p)).join('/');
}

/** The nearest help for a route: its own, or that of the closest page above it. */
export function pageHelpKey(route: string): string | null {
  let key = route;
  for (;;) {
    if (PAGE_HELP[key]) return key;
    if (key === '') return null;
    key = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '';
  }
}

export function pageHelp(route: string): (Help & { where: string }) | null {
  const key = pageHelpKey(route);
  return key === null ? null : PAGE_HELP[key]!;
}

/** Help for a section titled `title` on the page at `route`: the page's own entry wins. */
export function sectionHelp(route: string, title: string): Help | null {
  const key = pageHelpKey(route);
  return SECTION_HELP[`${route} > ${title}`] ?? (key !== null ? SECTION_HELP[`${key} > ${title}`] : undefined) ?? SECTION_HELP[title] ?? null;
}

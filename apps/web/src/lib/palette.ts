import type { NavItem } from './nav';

/** Pages whose name (or group) has every word typed, best first: names that start with the text lead. */
export function matchPages(groups: { group: string; items: NavItem[] }[], text: string): { group: string; item: NavItem }[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const all = groups.flatMap((g) => g.items.filter((i) => !i.locked).map((item) => ({ group: g.group, item })));
  if (!words.length) return [];
  const typed = text.trim().toLowerCase();
  // Exact name, then names that start with the text, then a word that does; shorter names first.
  const score = (label: string) => {
    const l = label.toLowerCase();
    return l === typed ? 0 : l.startsWith(typed) ? 1 : l.split(/\s+/).some((w) => w.startsWith(typed)) ? 2 : 3;
  };
  return all
    .filter(({ group, item }) => words.every((w) => `${item.label} ${group}`.toLowerCase().includes(w)))
    .sort((a, b) => score(a.item.label) - score(b.item.label) || a.item.label.length - b.item.label.length || a.item.label.localeCompare(b.item.label))
    .slice(0, 8);
}


/** Something to start from the palette: opens the page that creates it. */
export interface PaletteAction {
  label: string;
  href: string;
  /** The list page it belongs to: offered only when that page is in the person's menu. */
  parent: string;
  /** Needed to create it (a hint; the API checks again). */
  perm: string;
  /** Other words people type for it. */
  words?: string;
}

export const PALETTE_ACTIONS: readonly PaletteAction[] = [
  { label: 'New invoice', href: '/sales/invoices/new', parent: '/sales/invoices', perm: 'sales.manage', words: 'create bill customer sale' },
  { label: 'New quotation', href: '/sales/quotes/new', parent: '/sales/quotes', perm: 'sales.manage', words: 'create quote estimate' },
  { label: 'New sales order', href: '/sales/orders/new', parent: '/sales/orders', perm: 'sales.manage', words: 'create order' },
  { label: 'New contract', href: '/sales/contracts/new', parent: '/sales/contracts', perm: 'sales.manage', words: 'create subscription recurring' },
  { label: 'Record a receipt', href: '/sales/receipts/new', parent: '/sales/receipts', perm: 'sales.manage', words: 'payment received customer money in' },
  { label: 'New deal', href: '/sales/pipeline/new', parent: '/sales/pipeline', perm: 'crm.manage', words: 'create opportunity lead' },
  { label: 'New bill', href: '/purchases/bills/new', parent: '/purchases/bills', perm: 'purchases.manage', words: 'create vendor supplier purchase invoice' },
  { label: 'New purchase order', href: '/purchases/orders/new', parent: '/purchases/orders', perm: 'purchases.manage', words: 'create po' },
  { label: 'Record a payment', href: '/purchases/payments/new', parent: '/purchases/payments', perm: 'purchases.manage', words: 'pay vendor supplier money out' },
  { label: 'New journal entry', href: '/journals/new', parent: '/journals', perm: 'journals.create', words: 'create je adjustment' },
  { label: 'New expense claim', href: '/expenses/new', parent: '/expenses', perm: 'expenses.submit', words: 'create reimbursement receipt' },
  { label: 'Add a fixed asset', href: '/fixed-assets/new', parent: '/fixed-assets', perm: 'assets.manage', words: 'new create equipment' },
  { label: 'Add a loan', href: '/loans/new', parent: '/loans', perm: 'loans.manage', words: 'new create borrowing' },
  { label: 'New automation', href: '/automations/new', parent: '/automations', perm: 'workflows.manage', words: 'create workflow rule' },
];

/**
 * Actions with every word typed (in the name or its other words), that this person can start:
 * the list page is in their menu and their role has the permission. Best first, as for pages.
 */
export function matchActions(groups: { group: string; items: NavItem[] }[], text: string, allowed: (perm: string) => boolean, actions: readonly PaletteAction[] = PALETTE_ACTIONS): PaletteAction[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const menu = new Set(groups.flatMap((g) => g.items.filter((i) => !i.locked).map((i) => i.href)));
  const typed = text.trim().toLowerCase();
  const score = (label: string) => {
    const l = label.toLowerCase();
    return l === typed ? 0 : l.startsWith(typed) ? 1 : l.split(/\s+/).some((w) => w.startsWith(typed)) ? 2 : 3;
  };
  return actions
    .filter((a) => menu.has(a.parent) && allowed(a.perm) && words.every((w) => `${a.label} ${a.words ?? ''}`.toLowerCase().includes(w)))
    .sort((a, b) => score(a.label) - score(b.label) || a.label.length - b.label.length || a.label.localeCompare(b.label))
    .slice(0, 5);
}

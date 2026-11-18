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


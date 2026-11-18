'use client';
import { useQuery } from '@tanstack/react-query';
import { Dialog } from '@talk2tax/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import type { NavItem } from '@/lib/nav';
import { matchPages } from '@/lib/palette';

/** A record the search found (the relationship graph's search). */
interface FoundRecord {
  type: string;
  id: string;
  label: string;
  subtitle: string | null;
  path: string | null;
}

interface Hit {
  key: string;
  label: string;
  hint: string;
  href: string;
}

const KIND: Record<string, string> = {
  CONTACT: 'Contact',
  DOCUMENT: 'Document',
  PAYMENT: 'Payment',
  JOURNAL: 'Journal',
  ACCOUNT: 'Account',
  PROJECT: 'Project',
  DEPARTMENT: 'Department',
  LOAN: 'Loan',
  ASSET: 'Fixed asset',
  ALERT: 'Alert',
};

/**
 * Search everything from the header (Ctrl+K or ⌘K): the pages this person can open, and records
 * (contacts, documents, payments, journals, accounts, projects, departments, loans, fixed assets) when they
 * can read reports. Arrow keys move, Enter opens.
 */
export function CommandPalette({ orgId, groups, searchRecords }: { orgId: string; groups: { group: string; items: NavItem[] }[]; searchRecords: boolean }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [term, setTerm] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const base = `/orgs/${orgId}`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Ask the server only once typing pauses.
  useEffect(() => {
    const id = setTimeout(() => setTerm(text.trim()), 200);
    return () => clearTimeout(id);
  }, [text]);

  const records = useQuery({
    queryKey: ['palette-search', orgId, term],
    queryFn: () => api<FoundRecord[]>(`/v1/orgs/${orgId}/graph/search?q=${encodeURIComponent(term)}`),
    enabled: open && searchRecords && term.length >= 2,
    staleTime: 30_000,
  });

  const pages: Hit[] = useMemo(() => matchPages(groups, text).map(({ group, item }) => ({ key: `page:${item.href}`, label: t(item.label), hint: t(group), href: `${base}${item.href}` })), [groups, text, base, t]);
  const found: Hit[] = (term === text.trim() ? (records.data ?? []) : [])
    .filter((r) => r.path)
    .map((r) => ({ key: `${r.type}:${r.id}`, label: r.label, hint: [t(KIND[r.type] ?? r.type), r.subtitle].filter(Boolean).join(' · '), href: `${base}${r.path}` }));
  const hits = [...pages, ...found];
  const go = (h: Hit) => {
    setOpen(false);
    setText('');
    router.push(h.href);
  };
  useEffect(() => setActive(0), [text]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="hidden items-center gap-2 rounded-[var(--t2t-radius-md)] border border-line bg-surface px-3 py-1.5 text-sm text-fg-muted hover:text-fg md:flex"
        aria-keyshortcuts="Control+K Meta+K"
      >
        {t('Search')}
        <kbd className="rounded border border-line px-1 text-[10px] text-fg-faint">Ctrl K</kbd>
      </button>
      <button type="button" onClick={() => setOpen(true)} className="rounded p-2 text-fg-muted hover:text-fg md:hidden" aria-label={t('Find pages and records')}>
        ⌕
      </button>
      {open ? (
        <Dialog open onOpenChange={(o) => (setOpen(o), o || setText(''))} title="Search" description="Pages and records: customers, invoices, bills, payments, journals, accounts and more.">
          <input
            ref={input}
            autoFocus
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls="palette-results"
            aria-activedescendant={hits[active] ? `palette-${active}` : undefined}
            aria-label={t('Search pages and records')}
            placeholder={t('Type a page, a name or a number')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(a + 1, hits.length - 1)));
              else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
              else if (e.key === 'Enter' && hits[active]) (e.preventDefault(), go(hits[active]!));
            }}
            className="h-10 w-full rounded-[var(--t2t-radius-md)] border border-line bg-surface px-3 text-sm text-fg focus:outline-none focus-visible:outline-2 focus-visible:outline-[var(--t2t-focus)]"
          />
          <ul id="palette-results" role="listbox" aria-label={t('Results')} className="mt-3 max-h-[50vh] overflow-y-auto">
            {hits.map((h, i) => (
              <li
                key={h.key}
                id={`palette-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => (e.preventDefault(), go(h))}
                className={`cursor-pointer rounded-[var(--t2t-radius-md)] px-3 py-2 ${i === active ? 'bg-accent/15' : ''}`}
              >
                <span className="block text-sm text-fg">{h.label}</span>
                <span className="block text-xs text-fg-muted">{h.hint}</span>
              </li>
            ))}
          </ul>
          {text.trim() && !hits.length && !records.isFetching ? <p className="mt-3 text-sm text-fg-muted">{t('Nothing matches')}</p> : null}
          {records.isFetching ? <p className="mt-3 text-xs text-fg-faint">{t('Searching records…')}</p> : null}
          {!searchRecords && text.trim() ? <p className="mt-3 text-xs text-fg-faint">{t('Only pages are searched: finding records needs access to reports.')}</p> : null}
        </Dialog>
      ) : null}
    </>
  );
}

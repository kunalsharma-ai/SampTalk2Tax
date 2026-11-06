'use client';
import { cn, SectionHelpContext } from '@talk2tax/ui';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { helpRoute, pageHelp, sectionHelp, type Help } from '@/lib/help';
import { useT } from '@/lib/i18n';

/**
 * The (i) beside a page title or a section title. Clicking it opens a short panel: what it is for,
 * how to use it, and where it fits. Escape, a click outside or the close button shut it.
 */
export function HelpTip({ help, title, kind = 'section', className }: { help: Help; title: string; kind?: 'page' | 'section'; className?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const rows: [string, string | undefined][] = [
    ['What it is for', help.what],
    ['How to use it', help.how],
    ['Where it fits', help.where],
  ];
  return (
    <span ref={box} className={cn('relative inline-flex', className)}>
      <button
        ref={button}
        type="button"
        aria-label={t(kind === 'page' ? 'About this page' : 'About this section')}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={t('What is this?')}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-full border border-line font-serif italic leading-none text-fg-muted transition-colors hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
          kind === 'page' ? 'h-5 w-5 text-[12px]' : 'h-4 w-4 text-[10px]',
          open && 'border-accent bg-accent/10 text-accent',
        )}
      >
        i
      </button>
      {open ? (
        <span
          id={id}
          role="dialog"
          aria-label={t('About {title}', { title: t(title) })}
          className="absolute left-0 top-full z-40 mt-2 block w-80 max-w-[calc(100vw-2rem)] rounded-[var(--t2t-radius-lg)] border border-line bg-surface p-4 text-left text-sm font-normal not-italic tracking-normal text-fg shadow-lg"
        >
          <span className="flex items-start justify-between gap-3">
            <span className="block font-semibold">{t(title)}</span>
            <button type="button" aria-label={t('Close')} onClick={() => setOpen(false)} className="-mr-1 -mt-1 rounded px-1.5 text-fg-muted hover:bg-surface-hover hover:text-fg">
              ×
            </button>
          </span>
          {rows.map(([label, text]) =>
            text ? (
              <span key={label} className="mt-3 block">
                <span className="block text-[11px] font-semibold uppercase tracking-wide text-fg-faint">{t(label)}</span>
                <span className="mt-0.5 block leading-relaxed text-fg-muted">{t(text)}</span>
              </span>
            ) : null,
          )}
        </span>
      ) : null}
    </span>
  );
}

/** The current page's route key, for looking up its help. */
export function useHelpRoute() {
  return helpRoute(usePathname() ?? '');
}

/** The (i) for the current page, or nothing if it has no help. */
export function PageHelp({ title }: { title: string }) {
  const help = pageHelp(useHelpRoute());
  return help ? <HelpTip help={help} title={title} kind="page" /> : null;
}

/** Gives every section title under it its (i), from the help for the current page. */
export function SectionHelpProvider({ children }: { children: ReactNode }) {
  const route = useHelpRoute();
  const resolve = useCallback(
    (title: string) => {
      const help = sectionHelp(route, title);
      return help ? <HelpTip help={help} title={title} /> : null;
    },
    [route],
  );
  return <SectionHelpContext.Provider value={resolve}>{children}</SectionHelpContext.Provider>;
}

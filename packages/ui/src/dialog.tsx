'use client';
import * as RD from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

export function Dialog({ open, onOpenChange, title, description, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; children: ReactNode }) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
        <RD.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[var(--t2t-radius-lg)] border border-line bg-surface-raised p-6 shadow-2xl focus:outline-none">
          <RD.Title className="text-base font-semibold text-fg">{title}</RD.Title>
          {description ? <RD.Description className="mt-1 text-sm text-fg-muted">{description}</RD.Description> : <RD.Description className="sr-only">{title}</RD.Description>}
          <div className="mt-5">{children}</div>
          <RD.Close className="absolute right-4 top-4 rounded p-1 text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-[var(--t2t-focus)]" aria-label="Close">
            ✕
          </RD.Close>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

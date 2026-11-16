'use client';
import { Badge, cn } from '@talk2tax/ui';
import { dateTime } from '@/lib/format';

interface Message { id: string; side: 'CUSTOMER' | 'SUPPORT'; internal?: boolean; author: { name: string; email?: string }; body: string; createdAt: string }

/** A ticket's messages, oldest first. Support's internal notes are marked and only ever reach support. */
export function Conversation({ messages, mine }: { messages: Message[]; mine: 'CUSTOMER' | 'SUPPORT' }) {
  return (
    <ol aria-label="Conversation" className="space-y-3">
      {messages.map((m) => (
        <li
          key={m.id}
          aria-label={`${m.internal ? 'Internal note' : 'Message'} from ${m.author.name}`}
          className={cn(
            'rounded-[var(--t2t-radius-lg)] border px-4 py-3',
            m.internal ? 'border-warning/40 bg-warning/10' : m.side === mine ? 'ml-8 border-accent/30 bg-accent/5' : 'mr-8 border-line bg-surface',
          )}
        >
          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
            <span className="font-medium text-fg">{m.author.name}</span>
            {m.side === 'SUPPORT' ? <Badge tone="violet">Talk2Tax support</Badge> : null}
            {m.internal ? <Badge tone="warning">Internal note, not shown to the customer</Badge> : null}
            <span className="ml-auto">{dateTime(m.createdAt)}</span>
          </div>
          <p className="whitespace-pre-wrap text-sm">{m.body}</p>
        </li>
      ))}
    </ol>
  );
}

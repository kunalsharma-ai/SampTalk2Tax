import { Badge } from '@talk2tax/ui';
import { dateTime } from '@/lib/format';
import { TARGET, type TicketSummary } from '@/lib/support';

/** First answer and resolution against the promised times for the priority. */
export function Targets({ t }: { t: TicketSummary }) {
  const row = (label: string, x: TicketSummary['targets']['firstResponse']) => (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="w-28 text-fg-muted">{label}</span>
      <Badge tone={TARGET[x.state].tone}>{TARGET[x.state].label}</Badge>
      <span className="text-fg-muted">{x.doneAt ? `at ${dateTime(x.doneAt)}` : `by ${dateTime(x.dueAt)}`}</span>
    </div>
  );
  return (
    <div aria-label="Response times" className="space-y-1.5">
      {row('First answer', t.targets.firstResponse)}
      {row('Resolution', t.targets.resolution)}
    </div>
  );
}

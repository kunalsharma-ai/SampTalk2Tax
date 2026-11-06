import { Badge } from '@talk2tax/ui';
import type { TemplateSchedule } from '@/lib/journal-templates';

export function ScheduleBadge({ schedule }: { schedule: Pick<TemplateSchedule, 'status' | 'postMode'> }) {
  if (schedule.status === 'PAUSED') return <Badge tone="warning">Paused</Badge>;
  if (schedule.status === 'ENDED') return <Badge>Schedule ended</Badge>;
  return <Badge tone="positive">{schedule.postMode === 'POST' ? 'Recurring · posts' : 'Recurring · drafts'}</Badge>;
}

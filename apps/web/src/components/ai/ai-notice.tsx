import { Alert } from '@talk2tax/ui';
import Link from 'next/link';

export type AiNotice = { code: 'AI_OFF' | 'AGENT_OFF' | 'AI_BUDGET_REACHED' | string; message: string } | null | undefined;

const TITLE: Record<string, string> = { AI_OFF: 'AI was stopped', AGENT_OFF: 'This AI agent is turned off', AI_BUDGET_REACHED: 'Monthly AI budget reached' };

/** Why an AI agent cannot run when it was stopped, switched off or is over budget, from the AI control center. */
export function AiNoticeAlert({ notice, orgId, canChange }: { notice: AiNotice; orgId: string; canChange: boolean }) {
  if (!notice) return null;
  return (
    <div className="mb-4">
      <Alert tone={notice.code === 'AI_OFF' ? 'negative' : 'warning'} title={TITLE[notice.code] ?? 'AI cannot run'}>
        {notice.message}{' '}
        {canChange ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/ai-control`}>Open the AI control center.</Link> : null}
      </Alert>
    </div>
  );
}

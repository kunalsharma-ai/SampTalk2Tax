import { Injectable } from '@nestjs/common';
import { AI_AGENTS, type AiAgentId } from '@talk2tax/accounting-engine';
import { DocumentStoreService } from '../common/document-store.service';
import { aiDecisionRecords, type AiDecisionRecordDoc } from '../db/collections/ai-decision-records';
import { users } from '../db/collections/identity';

/**
 * The explainable AI ledger (AUDIT-018, AUDIT-020, AUDIT-021, AUDIT-027, AUDIT-029, AUDIT-030):
 * every call to an AI model, newest first, with the agent, who it acted for, the prompt and tools
 * it ran with, the data it was given, when it ran and its own short explanation. Read-only.
 */
@Injectable()
export class AiDecisionsService {
  constructor(private readonly store: DocumentStoreService) {}

  async list(q: { agent?: AiAgentId; subjectId?: string; outcome?: 'ANSWERED' | 'FAILED'; limit: number; before?: string }) {
    const filter: Record<string, unknown> = {};
    if (q.agent) filter.agent = q.agent;
    if (q.subjectId) filter.subjectId = q.subjectId;
    if (q.outcome) filter.outcome = q.outcome;
    if (q.before) filter.startedAt = { $lt: new Date(q.before) };
    const rows = await this.store.collection(aiDecisionRecords).find(filter, { sort: { startedAt: -1 }, limit: q.limit + 1 });
    const page = rows.slice(0, q.limit);
    const ids = [...new Set(page.map((r) => r.actingForUserId).filter((x): x is string => !!x))];
    const names = new Map((ids.length ? await this.store.collection(users).find({ id: { $in: ids } }) : []).map((u) => [u.id, u.name ?? u.email]));
    return {
      records: page.map((r) => this.view(r, names)),
      next: rows.length > q.limit ? page[page.length - 1]!.startedAt.toISOString() : null,
      agents: Object.entries(AI_AGENTS).map(([id, a]) => ({ id, name: a.name, does: a.does })),
    };
  }

  private view(r: AiDecisionRecordDoc, names: Map<string, string>) {
    const agent = AI_AGENTS[r.agent as AiAgentId] ?? AI_AGENTS.OTHER;
    return {
      id: r.id,
      agent: { id: r.agent, name: agent.name, does: agent.does },
      actingFor: r.actingForUserId ? { id: r.actingForUserId, name: names.get(r.actingForUserId) ?? 'A former member' } : null,
      keySource: r.keySource,
      modelRequested: r.modelRequested,
      servedModel: r.servedModel,
      promptVersion: r.promptVersion,
      toolsVersion: r.toolsVersion,
      toolNames: r.toolNames,
      dataSources: r.dataSources,
      subject: r.subjectType && r.subjectId ? { type: r.subjectType, id: r.subjectId } : null,
      explanation: r.explanation,
      reasoningWithheld: r.reasoningWithheld,
      stopReason: r.stopReason,
      outcome: r.outcome,
      errorName: r.errorName,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      startedAt: r.startedAt.toISOString(),
      completedAt: r.completedAt.toISOString(),
      durationMs: r.durationMs,
    };
  }
}

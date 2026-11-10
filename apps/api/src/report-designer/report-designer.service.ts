import Anthropic from '@anthropic-ai/sdk';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  checkCommentary,
  checkReportLayout,
  COMPARISONS,
  DASHBOARD_METRICS,
  describeLayout,
  layoutWidgets,
  MAX_DASHBOARD_MONTHS,
  MAX_REPORT_SECTIONS,
  reportFacts,
  WIDGET_SIZES,
  WIDGET_TYPES,
  type ReportLayout,
  type WidgetData,
} from '@talk2tax/accounting-engine';
import { Prisma, type ReportDesign, type ReportRun } from '@talk2tax/database';
import { AiControlService } from '../ai-control/ai-control.service';
import { aiProviderError } from '../ai-control/provider-error';
import { AuditService } from '../audit/audit.service';
import type { OrgContext } from '../auth/decorators';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { AppConfig, CONFIG } from '../config';
import type { CopilotRequest, CopilotTool } from '../copilot/copilot.model';
import { DashboardsService } from '../dashboards/dashboards.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { lockRow } from '../db/locks';

type Actor = { id: string };
export type ChatTurn = { role: 'user' | 'assistant'; text: string };
export type DesignInput = { name: string; description?: string | null; layout: unknown };
export interface CommentaryEntry {
  /** Position of the commentary section in the layout. */
  section: number;
  instruction: string;
  text: string;
  source: 'AI' | 'PERSON' | 'NONE';
  /** Why there is no text, or numbers in the text that are not in the report. */
  issues: string[];
}
export const REPORT_PROMPT_VERSION = 'report-designer-1';
const MAX_TOKENS = 6000;

/**
 * The report designer. Reading designs and reports needs reports.read; designing, producing
 * reports, writing commentary and finalising need reports.design. A report freezes its figures
 * when produced; its commentary is written by the AI from those figures only (checked: any number
 * not in the report is rejected) or by a person, and a final report can never change.
 */
@Injectable()
export class ReportDesignerService {
  private readonly log = new Logger('ReportDesigner');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly dashboards: DashboardsService,
    private readonly guard: AiControlService,
    private readonly integrations: IntegrationsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  catalogue() {
    return { ...this.dashboards.catalogue(), sectionLimit: MAX_REPORT_SECTIONS };
  }

  private check(layout: unknown) {
    const { layout: clean, issues } = checkReportLayout(layout);
    if (issues.length) throw new DomainError('INVALID_REPORT', issues.length === 1 ? issues[0]! : `${issues.length} problems in the report layout`, HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    return clean;
  }

  private async names(ids: (string | null)[]) {
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(ids.filter((x): x is string => !!x))] } }, select: { id: true, name: true } });
    return Object.fromEntries(users.map((u) => [u.id, u.name]));
  }

  /** Every widget's figures for the month, and the facts commentary must stick to. */
  private async figures(org: OrgContext, layout: ReportLayout, month?: string) {
    const data = await this.dashboards.data(org, layoutWidgets(layout), month);
    return { ...data, facts: reportFacts(layout, data.widgets, data.month, data.currency) };
  }

  async preview(org: OrgContext, layout: unknown, month?: string) {
    const clean = this.check(layout);
    const f = await this.figures(org, clean, month);
    return { layout: clean, descriptions: describeLayout(clean), currency: f.currency, month: f.month, inProgress: f.inProgress, widgets: f.widgets };
  }

  // ------------------------------------------------------------------ designs

  private designView(d: ReportDesign, people: Record<string, string>) {
    const layout = d.layout as unknown as ReportLayout;
    return {
      id: d.id,
      number: `RD-${String(d.number).padStart(4, '0')}`,
      name: d.name,
      description: d.description,
      layout,
      descriptions: describeLayout(layout),
      version: d.version,
      createdBy: people[d.createdById] ?? 'Former member',
      updatedBy: people[d.updatedById] ?? 'Former member',
      updatedAt: d.updatedAt.toISOString(),
    };
  }

  async listDesigns(orgId: string) {
    const rows = await this.prisma.reportDesign.findMany({ where: { orgId }, orderBy: { number: 'asc' } });
    const people = await this.names(rows.flatMap((d) => [d.createdById, d.updatedById]));
    const counts = await this.prisma.reportRun.groupBy({ by: ['designId'], where: { orgId }, _count: true, _max: { month: true } });
    return { items: rows.map((d) => ({ ...this.designView(d, people), reports: counts.find((c) => c.designId === d.id)?._count ?? 0, lastMonth: counts.find((c) => c.designId === d.id)?._max.month ?? null })) };
  }

  private async findDesign(orgId: string, id: string) {
    const d = await this.prisma.reportDesign.findFirst({ where: { id, orgId } });
    if (!d) throw new DomainError('NOT_FOUND', 'Report design not found', HttpStatus.NOT_FOUND);
    return d;
  }

  async getDesign(orgId: string, id: string) {
    const d = await this.findDesign(orgId, id);
    const runs = await this.prisma.reportRun.findMany({ where: { orgId, designId: id }, orderBy: [{ month: 'desc' }, { number: 'desc' }] });
    const people = await this.names([d.createdById, d.updatedById, ...runs.map((r) => r.updatedById)]);
    return { ...this.designView(d, people), reports: runs.map((r) => this.runSummary(r, people)) };
  }

  private async nameFree(orgId: string, name: string, exceptId?: string) {
    if (await this.prisma.reportDesign.findFirst({ where: { orgId, name, ...(exceptId ? { NOT: { id: exceptId } } : {}) } })) throw new DomainError('DUPLICATE', 'A report design with that name already exists', HttpStatus.CONFLICT);
  }

  async createDesign(orgId: string, actor: Actor, input: DesignInput) {
    const layout = this.check(input.layout);
    await this.nameFree(orgId, input.name.trim());
    const id = await this.prisma.$transaction(async (tx) => {
      const top = await tx.reportDesign.aggregate({ where: { orgId }, _max: { number: true } });
      const d = await tx.reportDesign.create({ data: { orgId, number: (top._max.number ?? 0) + 1, name: input.name.trim(), description: input.description?.trim() || null, layout: layout as unknown as Prisma.InputJsonValue, createdById: actor.id, updatedById: actor.id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'report_design.created', entityType: 'report_design', entityId: d.id, data: { name: d.name, sections: layout.sections.length } });
      return d.id;
    });
    return this.getDesign(orgId, id);
  }

  /** Changes apply to reports produced afterwards; reports already produced keep their layout. */
  async updateDesign(orgId: string, actor: Actor, id: string, input: DesignInput & { baseVersion: number }) {
    const layout = this.check(input.layout);
    await this.nameFree(orgId, input.name.trim(), id);
    await this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'report_designs', id, orgId);
      const d = await tx.reportDesign.findFirst({ where: { id, orgId } });
      if (!d) throw new DomainError('NOT_FOUND', 'Report design not found', HttpStatus.NOT_FOUND);
      if (d.version !== input.baseVersion) throw new DomainError('DESIGN_CHANGED', 'Someone changed this design while you were editing. Reload it and make your change again.', HttpStatus.CONFLICT);
      await tx.reportDesign.update({ where: { id }, data: { name: input.name.trim(), description: input.description?.trim() || null, layout: layout as unknown as Prisma.InputJsonValue, version: d.version + 1, updatedById: actor.id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'report_design.updated', entityType: 'report_design', entityId: id, data: { version: d.version + 1, before: { name: d.name, layout: d.layout }, after: { name: input.name.trim(), layout: layout as unknown as Prisma.InputJsonValue } } });
    });
    return this.getDesign(orgId, id);
  }

  /** Only a design with no reports can be deleted; reports keep their design. */
  async removeDesign(orgId: string, actor: Actor, id: string) {
    const d = await this.findDesign(orgId, id);
    const n = await this.prisma.reportRun.count({ where: { orgId, designId: id } });
    if (n) throw new DomainError('DESIGN_IN_USE', `${n} report${n === 1 ? ' was' : 's were'} produced from this design, so it is kept. Delete the draft reports first; final reports are records.`, HttpStatus.CONFLICT);
    await this.prisma.$transaction(async (tx) => {
      await tx.reportDesign.delete({ where: { id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'report_design.deleted', entityType: 'report_design', entityId: id, data: { name: d.name, layout: d.layout } });
    });
  }

  // ------------------------------------------------------------------ reports

  private runSummary(r: ReportRun, people: Record<string, string>) {
    return { id: r.id, number: `RPT-${String(r.number).padStart(4, '0')}`, month: r.month, title: r.title, status: r.status as 'DRAFT' | 'FINAL', updatedBy: people[r.updatedById] ?? 'Former member', updatedAt: r.updatedAt.toISOString(), finalisedAt: r.finalisedAt?.toISOString() ?? null };
  }

  private async findRun(orgId: string, id: string) {
    const r = await this.prisma.reportRun.findFirst({ where: { id, orgId } });
    if (!r) throw new DomainError('NOT_FOUND', 'Report not found', HttpStatus.NOT_FOUND);
    return r;
  }

  async getRun(orgId: string, id: string) {
    const r = await this.findRun(orgId, id);
    const people = await this.names([r.createdById, r.updatedById, r.finalisedById]);
    const content = r.content as unknown as { layout: ReportLayout; currency: string; inProgress: boolean; widgets: WidgetData[]; facts: string; designName: string; designNumber: string };
    return {
      ...this.runSummary(r, people),
      designId: r.designId,
      designName: content.designName,
      currency: content.currency,
      inProgress: content.inProgress,
      layout: content.layout,
      widgets: content.widgets,
      facts: content.facts,
      commentary: r.commentary as unknown as CommentaryEntry[],
      version: r.version,
      createdBy: people[r.createdById] ?? 'Former member',
      finalisedBy: r.finalisedById ? (people[r.finalisedById] ?? 'Former member') : null,
    };
  }

  /**
   * Produces a report from a design for a month: the figures are worked out and frozen, and if
   * asked (and the AI is available) the AI writes each commentary section from those figures.
   */
  async createRun(org: OrgContext, actor: Actor, designId: string, input: { month?: string; writeCommentary: boolean; title?: string | null }) {
    const d = await this.findDesign(org.id, designId);
    const layout = d.layout as unknown as ReportLayout;
    const f = await this.figures(org, layout, input.month);
    let commentary: CommentaryEntry[] = layout.sections.flatMap((s, i) => (s.type === 'COMMENTARY' ? [{ section: i, instruction: s.instruction, text: '', source: 'NONE' as const, issues: ['Not written yet'] }] : []));
    if (input.writeCommentary && commentary.length) commentary = await this.writeCommentary(org, actor, layout, f.facts, commentary);
    const title = input.title?.trim() || `${d.name}, ${f.month}`;
    const id = await this.prisma.$transaction(async (tx) => {
      const top = await tx.reportRun.aggregate({ where: { orgId: org.id }, _max: { number: true } });
      const r = await tx.reportRun.create({
        data: {
          orgId: org.id,
          designId,
          number: (top._max.number ?? 0) + 1,
          month: f.month,
          title: title.slice(0, 200),
          content: { layout, currency: f.currency, inProgress: f.inProgress, widgets: f.widgets, facts: f.facts, designName: d.name, designNumber: `RD-${String(d.number).padStart(4, '0')}` } as unknown as Prisma.InputJsonValue,
          commentary: commentary as unknown as Prisma.InputJsonValue,
          status: 'DRAFT',
          createdById: actor.id,
          updatedById: actor.id,
        },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'report.produced', entityType: 'report_run', entityId: r.id, data: { design: designId, month: f.month, commentary: commentary.map((c) => c.source) } });
      return r.id;
    });
    return this.getRun(org.id, id);
  }

  private async lockDraft(tx: Prisma.TransactionClient, orgId: string, id: string, baseVersion: number) {
    await lockRow(tx, 'report_runs', id, orgId);
    const r = await tx.reportRun.findFirst({ where: { id, orgId } });
    if (!r) throw new DomainError('NOT_FOUND', 'Report not found', HttpStatus.NOT_FOUND);
    if (r.status === 'FINAL') throw new DomainError('REPORT_FINAL', 'This report is final and cannot be changed', HttpStatus.CONFLICT);
    if (r.version !== baseVersion) throw new DomainError('REPORT_CHANGED', 'Someone changed this report while you were editing. Reload it and make your change again.', HttpStatus.CONFLICT);
    return r;
  }

  /** A person writes or rewrites a commentary section. Numbers not in the report are flagged, not blocked. */
  async editCommentary(orgId: string, actor: Actor, id: string, input: { section: number; text: string; baseVersion: number }) {
    await this.prisma.$transaction(async (tx) => {
      const r = await this.lockDraft(tx, orgId, id, input.baseVersion);
      const list = r.commentary as unknown as CommentaryEntry[];
      const entry = list.find((c) => c.section === input.section);
      if (!entry) throw new DomainError('NOT_FOUND', 'That section is not commentary', HttpStatus.NOT_FOUND);
      const facts = (r.content as { facts: string }).facts;
      const text = input.text.trim();
      const unknown = checkCommentary(text, facts);
      const next = list.map((c) => (c.section === input.section ? { ...c, text, source: text ? ('PERSON' as const) : ('NONE' as const), issues: !text ? ['Not written yet'] : unknown.length ? [`Numbers not in the report's figures: ${unknown.join(', ')}. Check them before finalising.`] : [] } : c));
      await tx.reportRun.update({ where: { id }, data: { commentary: next as unknown as Prisma.InputJsonValue, version: r.version + 1, updatedById: actor.id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'report.commentary_edited', entityType: 'report_run', entityId: id, data: { section: input.section, before: entry.text, after: text } });
    });
    return this.getRun(orgId, id);
  }

  /** The AI writes (again) every commentary section of a draft report. */
  async rewriteCommentary(org: OrgContext, actor: Actor, id: string, baseVersion: number) {
    const r = await this.findRun(org.id, id);
    if (r.status === 'FINAL') throw new DomainError('REPORT_FINAL', 'This report is final and cannot be changed', HttpStatus.CONFLICT);
    if (r.version !== baseVersion) throw new DomainError('REPORT_CHANGED', 'Someone changed this report while you were editing. Reload it and make your change again.', HttpStatus.CONFLICT);
    const content = r.content as unknown as { layout: ReportLayout; facts: string };
    const written = await this.writeCommentary(org, actor, content.layout, content.facts, r.commentary as unknown as CommentaryEntry[]);
    await this.prisma.$transaction(async (tx) => {
      const now = await this.lockDraft(tx, org.id, id, baseVersion);
      await tx.reportRun.update({ where: { id }, data: { commentary: written as unknown as Prisma.InputJsonValue, version: now.version + 1, updatedById: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'report.commentary_written', entityType: 'report_run', entityId: id, data: { commentary: written.map((c) => c.source) } });
    });
    return this.getRun(org.id, id);
  }

  /** Makes the report a record. Every commentary section must be written. */
  async finalise(orgId: string, actor: Actor, id: string, baseVersion: number) {
    await this.prisma.$transaction(async (tx) => {
      const r = await this.lockDraft(tx, orgId, id, baseVersion);
      const missing = (r.commentary as unknown as CommentaryEntry[]).filter((c) => !c.text);
      if (missing.length) throw new DomainError('COMMENTARY_MISSING', `Write the commentary before finalising (${missing.length} section${missing.length === 1 ? '' : 's'} empty)`, HttpStatus.UNPROCESSABLE_ENTITY, { issues: missing.map((c) => `Section ${c.section + 1}: ${c.instruction}`) });
      await tx.reportRun.update({ where: { id }, data: { status: 'FINAL', finalisedById: actor.id, finalisedAt: new Date(), version: r.version + 1, updatedById: actor.id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'report.finalised', entityType: 'report_run', entityId: id, data: { month: r.month } });
    });
    return this.getRun(orgId, id);
  }

  async removeRun(orgId: string, actor: Actor, id: string) {
    const r = await this.findRun(orgId, id);
    if (r.status === 'FINAL') throw new DomainError('REPORT_FINAL', 'A final report is a record and cannot be deleted', HttpStatus.CONFLICT);
    await this.prisma.$transaction(async (tx) => {
      await tx.reportRun.delete({ where: { id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'report.deleted', entityType: 'report_run', entityId: id, data: { month: r.month, title: r.title } });
    });
  }

  // ------------------------------------------------------------------ the AI

  async aiStatus(orgId: string) {
    const ai = await this.integrations.ai(orgId);
    const block = await this.guard.check(orgId, 'COPILOT');
    return { configured: ai.model !== null, model: ai.modelName, available: !block, reason: block?.message ?? null };
  }

  private async call(org: OrgContext, actor: Actor, kind: 'DESIGN' | 'COMMENTARY', asked: string, request: Omit<CopilotRequest, 'model' | 'metadata'>, toolName: string) {
    await this.guard.assert(org.id, 'COPILOT');
    const ai = await this.integrations.ai(org.id);
    if (!ai.model) throw new DomainError('AI_NOT_CONFIGURED', 'AI is not set up. An owner or admin can add a key in Settings → Integrations.', HttpStatus.SERVICE_UNAVAILABLE);
    let res: Anthropic.Beta.Messages.BetaMessage;
    try {
      res = await ai.model.send({ ...request, model: ai.modelName, metadata: { user_id: actor.id } } as CopilotRequest, { signal: AbortSignal.timeout(this.config.COPILOT_TURN_TIMEOUT_SECONDS * 1000) });
    } catch (e) {
      const err = aiProviderError(e, this.log, 'Report designer AI call');
      await this.record(org.id, actor, kind, asked, { status: 'FAILED', errorCode: err.code, errorMessage: err.message, model: ai.modelName });
      throw new DomainError(err.code, err.message, HttpStatus.BAD_GATEWAY);
    }
    const tokens = { inputTokens: res.usage.input_tokens + (res.usage.cache_creation_input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0), outputTokens: res.usage.output_tokens, model: res.model };
    const use = res.content.find((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use' && b.name === toolName);
    if (res.stop_reason === 'refusal' || !use) {
      const code = res.stop_reason === 'refusal' ? 'REFUSED' : 'NO_PROPOSAL';
      const msg = code === 'REFUSED' ? 'The AI model declined this request.' : 'The AI model did not answer in the expected form. Try again.';
      await this.record(org.id, actor, kind, asked, { status: 'FAILED', errorCode: code, errorMessage: msg, ...tokens });
      throw new DomainError(code, msg, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    await this.record(org.id, actor, kind, asked, { status: 'DONE', result: use.input as Prisma.InputJsonValue, ...tokens });
    return { input: use.input as Record<string, unknown>, model: res.model };
  }

  private async record(orgId: string, actor: Actor, kind: 'DESIGN' | 'COMMENTARY', request: string, data: { status: 'DONE' | 'FAILED'; result?: Prisma.InputJsonValue; errorCode?: string; errorMessage?: string; model?: string; inputTokens?: number; outputTokens?: number }) {
    await this.prisma.$transaction(async (tx) => {
      const c = await tx.reportAiCall.create({ data: { orgId, kind, request: request.slice(0, 8000), createdById: actor.id, ...data } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: data.status === 'DONE' ? 'report.ai_called' : 'report.ai_call_failed', entityType: 'report_ai_call', entityId: c.id, data: { kind, promptVersion: REPORT_PROMPT_VERSION, model: data.model ?? null, inputTokens: data.inputTokens ?? 0, outputTokens: data.outputTokens ?? 0, errorCode: data.errorCode ?? null } });
    });
  }

  /**
   * Each commentary section written by the AI from the report's facts. A section quoting any
   * number not in the facts is not used; it says why and stays for a person to write.
   */
  private async writeCommentary(org: OrgContext, actor: Actor, layout: ReportLayout, facts: string, list: CommentaryEntry[]): Promise<CommentaryEntry[]> {
    if (!list.length) return list;
    const block = await this.guard.check(org.id, 'COPILOT');
    if (block) return list.map((c) => ({ ...c, issues: [`Not written by the AI: ${block.message}`] }));
    const outline = describeLayout(layout).map((d, i) => `${i + 1}. ${d}`).join('\n');
    const system = [
      'You write commentary for a monthly management report of a business, for its owners and board. Plain, direct sentences; no headings, lists or markdown; no greetings.',
      'Use only the figures in the facts below. Quote numbers exactly as they appear there (you may write amounts with Indian digit grouping, such as ₹1,50,000.00, or drop .00); never calculate new figures such as percentages or growth rates, never estimate, forecast or round. If something cannot be said from the facts, do not say it.',
      'Each commentary section has an instruction; follow it, and keep each one under 120 words.',
      '',
      'The report, in order:',
      outline,
      '',
      'Facts:',
      facts,
      '',
      'Answer only by calling write_commentary, with one entry for each commentary section.',
    ].join('\n');
    const tool: CopilotTool = {
      name: 'write_commentary',
      description: 'The commentary for each commentary section of the report.',
      input_schema: { type: 'object', properties: { sections: { type: 'array', items: { type: 'object', properties: { section: { type: 'integer', description: '1-based position of the section in the report' }, text: { type: 'string' } }, required: ['section', 'text'] } } }, required: ['sections'] },
    } as CopilotTool;
    const ask = list.map((c) => `Section ${c.section + 1}: ${c.instruction}`).join('\n');
    let out: Record<string, unknown>;
    try {
      ({ input: out } = await this.call(org, actor, 'COMMENTARY', ask, { max_tokens: MAX_TOKENS, system, tools: [tool], tool_choice: { type: 'tool', name: 'write_commentary' }, messages: [{ role: 'user', content: [{ type: 'text', text: `Write the commentary for these sections:\n${ask}` }] }] }, 'write_commentary'));
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      return list.map((c) => ({ ...c, issues: [`Not written by the AI: ${e.message}`] }));
    }
    const given = (Array.isArray(out.sections) ? out.sections : []) as { section?: unknown; text?: unknown }[];
    return list.map((c) => {
      const g = given.find((x) => x.section === c.section + 1);
      const text = typeof g?.text === 'string' ? g.text.trim().slice(0, 4000) : '';
      if (!text) return { ...c, issues: ['The AI did not write this section; write it yourself or ask again'] };
      const unknown = checkCommentary(text, facts);
      if (unknown.length) return { ...c, text: '', source: 'NONE' as const, issues: [`The AI's text quoted numbers not in the report (${unknown.join(', ')}), so it was not used; write it yourself or ask again`] };
      return { ...c, text, source: 'AI' as const, issues: [] };
    });
  }

  /** Drafts a report layout from instructions. Nothing is saved. */
  async draftDesign(org: OrgContext, actor: Actor, input: { request: string; conversation: ChatTurn[]; month?: string }) {
    const metrics = DASHBOARD_METRICS.map((m) => `- ${m.key}: ${m.label} [${m.unit.toLowerCase()}] ${m.formula}`).join('\n');
    const system = [
      'You design monthly management reports for a business using an accounting system. You choose the sections; the system works out every figure from the posted books and writes commentary each month from those figures. Never invent metrics, figures or capabilities.',
      '',
      `Sections (at most ${MAX_REPORT_SECTIONS}): HEADING {text}; TEXT {text} (fixed words, the same every month, such as a purpose or a sign-off; never put figures in it); COMMENTARY {instruction} (what the monthly commentary should cover, for example "Explain how revenue and margins moved"); WIDGET {widget}.`,
      `A widget is one of: STAT {title, metric, compare: ${COMPARISONS.join(' | ')}}; LINE or BAR {title, metrics: 1 to 4 keys with the same unit, months: 3 to ${MAX_DASHBOARD_MONTHS}}; TABLE {title, metrics: 1 to 8 keys, months: 1 to 12}; TOP_CUSTOMERS {title, count: 3 to 10, months: 1 to 12}. Optional size: ${WIDGET_SIZES.join(', ')}.`,
      'Approved metrics (use these keys only):',
      metrics,
      '',
      'Put a commentary section near the figures it discusses. If the instructions ask for something not available (budgets, departments, forecasts, notes to accounts), use the closest approved figures and say what is missing in notes. If something is unclear, make a sensible choice and ask a short question in questions.',
      'Answer only by calling propose_report.',
    ].join('\n');
    const keys = DASHBOARD_METRICS.map((m) => m.key);
    const tool: CopilotTool = {
      name: 'propose_report',
      description: 'Propose a report layout, with notes on anything not available and questions.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          sections: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['HEADING', 'TEXT', 'COMMENTARY', 'WIDGET'] },
                text: { type: 'string' },
                instruction: { type: 'string' },
                widget: { type: 'object', properties: { type: { type: 'string', enum: [...WIDGET_TYPES] }, title: { type: 'string' }, size: { type: 'string', enum: [...WIDGET_SIZES] }, metric: { type: 'string', enum: keys }, metrics: { type: 'array', items: { type: 'string', enum: keys } }, compare: { type: 'string', enum: [...COMPARISONS] }, months: { type: 'integer' }, count: { type: 'integer' } }, required: ['type', 'title'] },
              },
              required: ['type'],
            },
          },
          notes: { type: 'array', items: { type: 'string' } },
          questions: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'description', 'sections', 'notes', 'questions'],
      },
    } as CopilotTool;
    const messages: CopilotRequest['messages'] = [{ role: 'user', content: [{ type: 'text', text: input.request.trim() }] }, ...input.conversation.map((t) => ({ role: t.role, content: [{ type: 'text' as const, text: t.text }] }))];
    if (messages[messages.length - 1]!.role !== 'user') messages.push({ role: 'user', content: [{ type: 'text', text: 'Please propose the report.' }] });
    const asked = [input.request, ...input.conversation.map((t) => `${t.role}: ${t.text}`)].join('\n\n');
    const { input: raw, model } = await this.call(org, actor, 'DESIGN', asked, { max_tokens: MAX_TOKENS, system, tools: [tool], tool_choice: { type: 'tool', name: 'propose_report' }, messages }, 'propose_report');
    const strings = (x: unknown) => (Array.isArray(x) ? x : []).filter((q): q is string => typeof q === 'string').slice(0, 10);
    const sections = (Array.isArray(raw.sections) ? raw.sections : []).slice(0, MAX_REPORT_SECTIONS);
    const { layout, issues } = checkReportLayout({ sections });
    const preview = issues.length ? null : await this.figures(org, layout, input.month);
    return {
      name: typeof raw.name === 'string' ? raw.name.slice(0, 120) : '',
      description: typeof raw.description === 'string' ? raw.description.slice(0, 1000) : '',
      layout: issues.length ? { sections } : layout,
      notes: strings(raw.notes),
      questions: strings(raw.questions),
      issues,
      descriptions: issues.length ? [] : describeLayout(layout),
      preview: preview ? { currency: preview.currency, month: preview.month, inProgress: preview.inProgress, widgets: preview.widgets } : null,
      model,
    };
  }
}

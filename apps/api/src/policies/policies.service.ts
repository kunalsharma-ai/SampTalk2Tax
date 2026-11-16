import Anthropic from '@anthropic-ai/sdk';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  ASSIGNABLE_ROLES,
  checkPolicy,
  CONDITION_OPERATORS,
  describeRule,
  evaluateConditions,
  MAX_POLICY_RULES,
  MAX_POLICY_TESTS,
  runPolicyTests,
  triggerDef,
  WORKFLOW_TRIGGER_DEFS,
  type PolicyRule,
  type PolicyTest,
} from '@talk2tax/accounting-engine';
import { Prisma, type Policy } from '@talk2tax/database';
import { AiControlService } from '../ai-control/ai-control.service';
import { AuditService } from '../audit/audit.service';
import type { OrgContext } from '../auth/decorators';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { AppConfig, CONFIG } from '../config';
import type { CopilotRequest, CopilotTool } from '../copilot/copilot.model';
import { IntegrationsService } from '../integrations/integrations.service';
import { loadEventFacts } from '../workflows/workflow-facts';
import { WorkflowsService } from '../workflows/workflows.service';

type Actor = { id: string };
export type PolicyInput = { name: string; statement: string; rules: PolicyRule[]; tests: PolicyTest[]; note?: string | null };
export type ChatTurn = { role: 'user' | 'assistant'; text: string };

/** How far back a back-test looks, and how many events it reads per rule. */
const BACKTEST_DAYS = 90;
const BACKTEST_LIMIT = 500;
const MAX_DRAFT_TOKENS = 8000;
/** Recorded with every AI draft, so a change to the instructions can be traced. */
export const POLICY_PROMPT_VERSION = 'policy-draft-1';

/**
 * Financial policies. A policy is the policy in words, the workflow rules that enforce it and
 * tests of those rules. Writing needs policies.manage. Approving a policy needs
 * workflows.manage and someone other than its last editor: the approved version's rules then
 * run as workflows (created, or given a new version), and rules dropped from the policy are
 * turned off. Every version is kept and can never be changed. The AI can draft rules from a
 * description; people check, test and approve them.
 */
@Injectable()
export class PoliciesService {
  private readonly log = new Logger('Policies');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly workflows: WorkflowsService,
    private readonly guard: AiControlService,
    private readonly integrations: IntegrationsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  // ------------------------------------------------------------------ reading

  private async names(ids: (string | null)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    const users = await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } });
    return Object.fromEntries(users.map((u) => [u.id, u.name]));
  }

  private async currency(orgId: string) {
    return (await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { functionalCurrency: true } })).functionalCurrency;
  }

  private view(p: Policy, currency: string) {
    const rules = p.rules as unknown as PolicyRule[];
    const tests = p.tests as unknown as PolicyTest[];
    const results = runPolicyTests(rules, tests);
    return {
      id: p.id,
      number: `POL-${String(p.number).padStart(4, '0')}`,
      name: p.name,
      statement: p.statement,
      status: p.status as 'DRAFT' | 'ACTIVE' | 'RETIRED',
      version: p.version,
      activeVersion: p.activeVersion,
      rules: rules.map((r) => ({ ...r, description: describeRule(r, currency) })),
      tests,
      testResults: results,
      testsPassing: results.every((r) => r.passed),
      workflowIds: p.workflowIds,
      createdById: p.createdById,
      updatedById: p.updatedById,
      approvedById: p.approvedById,
      approvedAt: p.approvedAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  }

  private async find(orgId: string, id: string) {
    const p = await this.prisma.policy.findFirst({ where: { id, orgId } });
    if (!p) throw new DomainError('NOT_FOUND', 'Policy not found', HttpStatus.NOT_FOUND);
    return p;
  }

  /** What the rule editor needs: the workflow builder's catalogue, without single members (policy work goes to roles), and the policy limits. */
  async catalogue(orgId: string) {
    const c = await this.workflows.catalogue(orgId);
    return { ...c, members: [], policyLimits: { rules: MAX_POLICY_RULES, tests: MAX_POLICY_TESTS, backtestDays: BACKTEST_DAYS } };
  }

  async list(orgId: string) {
    const [rows, currency] = await Promise.all([this.prisma.policy.findMany({ where: { orgId }, orderBy: { number: 'desc' } }), this.currency(orgId)]);
    const people = await this.names(rows.flatMap((p) => [p.updatedById, p.approvedById]));
    return { items: rows.map((p) => ({ ...this.view(p, currency), people })) };
  }

  async get(orgId: string, id: string) {
    const p = await this.find(orgId, id);
    const currency = await this.currency(orgId);
    const versions = await this.prisma.policyVersion.findMany({ where: { orgId, policyId: id }, orderBy: [{ version: 'desc' }, { createdAt: 'desc' }] });
    const wfs = p.workflowIds.length ? await this.prisma.workflow.findMany({ where: { orgId, id: { in: p.workflowIds } }, select: { id: true, name: true, enabled: true, currentVersion: true } }) : [];
    const people = await this.names([p.createdById, p.updatedById, p.approvedById, ...versions.map((v) => v.createdById)]);
    return {
      ...this.view(p, currency),
      workflows: p.workflowIds.map((wid, i) => ({ rule: i + 1, ...(wfs.find((w) => w.id === wid) ?? { id: wid, name: null, enabled: false, currentVersion: null }) })),
      versions: versions.map((v) => ({ version: v.version, event: v.event, name: v.name, statement: v.statement, rules: v.rules as unknown as PolicyRule[], tests: v.tests as unknown as PolicyTest[], note: v.note, createdById: v.createdById, createdAt: v.createdAt.toISOString() })),
      people,
    };
  }

  // ------------------------------------------------------------------ writing

  private validate(input: PolicyInput) {
    const { rules, issues } = checkPolicy(input, { allowHttp: this.config.WEBHOOK_ALLOW_PRIVATE_NETWORKS });
    // Policies give tasks and send emails to roles and contacts only, so they keep working when people change.
    rules.forEach((r, i) =>
      (r.actions ?? []).forEach((a, j) => {
        if (a.type === 'CREATE_TASK' && 'userId' in a.assignTo) issues.push(`Rule ${i + 1}, action ${j + 1}: give policy tasks to a role, not to one person`);
        if (a.type === 'SEND_EMAIL' && 'userId' in a.to) issues.push(`Rule ${i + 1}, action ${j + 1}: send policy emails to a role or the customer or vendor, not to one person`);
      }),
    );
    if (issues.length) throw new DomainError('INVALID_POLICY', issues.length === 1 ? issues[0]! : `${issues.length} problems in the policy`, HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    return rules;
  }

  /** Checks a policy being edited without saving it: its problems, its rules in words and its test results. */
  async check(orgId: string, input: PolicyInput) {
    const currency = await this.currency(orgId);
    const { rules, issues } = checkPolicy(input, { allowHttp: this.config.WEBHOOK_ALLOW_PRIVATE_NETWORKS });
    return {
      issues,
      descriptions: rules.map((r) => {
        try {
          return describeRule(r, currency);
        } catch {
          return null;
        }
      }),
      testResults: runPolicyTests(rules, input.tests),
    };
  }

  private async nameFree(orgId: string, name: string, exceptId?: string) {
    if (await this.prisma.policy.findFirst({ where: { orgId, name, ...(exceptId ? { NOT: { id: exceptId } } : {}) } })) throw new DomainError('DUPLICATE', 'A policy with that name already exists', HttpStatus.CONFLICT);
  }

  async create(orgId: string, actor: Actor, input: PolicyInput) {
    const rules = this.validate(input);
    await this.nameFree(orgId, input.name.trim());
    const id = await this.prisma.$transaction(async (tx) => {
      const top = await tx.policy.aggregate({ where: { orgId }, _max: { number: true } });
      const p = await tx.policy.create({
        data: { orgId, number: (top._max.number ?? 0) + 1, name: input.name.trim(), statement: input.statement.trim(), status: 'DRAFT', version: 1, rules: rules as unknown as Prisma.InputJsonValue, tests: input.tests as unknown as Prisma.InputJsonValue, workflowIds: [], createdById: actor.id, updatedById: actor.id },
      });
      await tx.policyVersion.create({ data: { orgId, policyId: p.id, version: 1, name: p.name, statement: p.statement, rules: p.rules as Prisma.InputJsonValue, tests: p.tests as Prisma.InputJsonValue, event: 'CREATED', note: input.note?.trim() || null, createdById: actor.id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'policy.created', entityType: 'policy', entityId: p.id, data: { name: p.name, rules: rules.length, tests: input.tests.length } });
      return p.id;
    });
    return this.get(orgId, id);
  }

  /** Any change makes a new version, waiting for approval. The approved version keeps running meanwhile. */
  async update(orgId: string, actor: Actor, id: string, input: PolicyInput & { baseVersion: number }) {
    const rules = this.validate(input);
    await this.nameFree(orgId, input.name.trim(), id);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM policies WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid FOR UPDATE`;
      const p = await tx.policy.findFirst({ where: { id, orgId } });
      if (!p) throw new DomainError('NOT_FOUND', 'Policy not found', HttpStatus.NOT_FOUND);
      if (p.version !== input.baseVersion) throw new DomainError('POLICY_CHANGED', `Someone saved version ${p.version} of this policy while you were editing. Reload it and make your change again.`, HttpStatus.CONFLICT);
      const version = p.version + 1;
      await tx.policy.update({
        where: { id },
        data: { name: input.name.trim(), statement: input.statement.trim(), rules: rules as unknown as Prisma.InputJsonValue, tests: input.tests as unknown as Prisma.InputJsonValue, version, status: p.status === 'RETIRED' ? 'RETIRED' : 'DRAFT', updatedById: actor.id },
      });
      await tx.policyVersion.create({ data: { orgId, policyId: id, version, name: input.name.trim(), statement: input.statement.trim(), rules: rules as unknown as Prisma.InputJsonValue, tests: input.tests as unknown as Prisma.InputJsonValue, event: 'EDITED', note: input.note?.trim() || null, createdById: actor.id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'policy.updated', entityType: 'policy', entityId: id, data: { version, before: { name: p.name, statement: p.statement, rules: p.rules, tests: p.tests }, after: { name: input.name.trim(), statement: input.statement.trim(), rules: rules as unknown as Prisma.InputJsonValue, tests: input.tests as unknown as Prisma.InputJsonValue } } });
    });
    return this.get(orgId, id);
  }

  /**
   * Approves the latest version and puts its rules to work: rule n runs as the policy's n-th
   * workflow (created, or updated to a new version, and turned on). Workflows of rules the
   * policy no longer has are turned off. Needs every test passing and an approver who is not
   * the last editor.
   */
  async approve(org: OrgContext, actor: Actor, id: string, input: { version: number; note?: string | null }) {
    const p = await this.find(org.id, id);
    if (p.version !== input.version) throw new DomainError('POLICY_CHANGED', `Version ${p.version} is the latest; review it before approving.`, HttpStatus.CONFLICT);
    if (p.status === 'ACTIVE') throw new DomainError('POLICY_ACTIVE', 'This version is already approved and running', HttpStatus.CONFLICT);
    if (p.updatedById === actor.id) throw new DomainError('SELF_APPROVAL', 'Someone other than the last person to change a policy must approve it', HttpStatus.FORBIDDEN);
    const rules = p.rules as unknown as PolicyRule[];
    const results = runPolicyTests(rules, p.tests as unknown as PolicyTest[]);
    const failing = results.filter((r) => !r.passed);
    if (failing.length) throw new DomainError('TESTS_FAILING', `${failing.length} test${failing.length === 1 ? '' : 's'} failing; fix the rules or the tests before approving`, HttpStatus.UNPROCESSABLE_ENTITY, { issues: failing.map((t) => `Test ${t.index} (${t.label}): ${t.problem ?? `expected the rule to ${t.expect === 'ACTS' ? 'act' : 'not act'}`}`) });

    const number = `POL-${String(p.number).padStart(4, '0')}`;
    const ids: string[] = [];
    for (const [i, r] of rules.entries()) {
      const input = { name: `${number} · ${r.name}`.slice(0, 120), description: `Rule ${i + 1} of policy ${number} "${p.name}", version ${p.version}. Change it in the policy studio.`, trigger: r.trigger, triggerParams: r.triggerParams ?? {}, conditions: r.conditions, actions: r.actions };
      const existing = p.workflowIds[i];
      const w = existing ? await this.workflows.get(org.id, existing).catch(() => null) : null;
      const saved = w ? await this.workflows.update(org, actor, existing!, { ...input, baseVersion: w.version, note: `Policy ${number} version ${p.version}` }) : await this.workflows.create(org, actor, input);
      if (!saved.enabled) await this.workflows.setEnabled(org, actor, saved.id, true);
      ids.push(saved.id);
    }
    for (const old of p.workflowIds.slice(rules.length)) {
      const w = await this.workflows.get(org.id, old).catch(() => null);
      if (w?.enabled) await this.workflows.setEnabled(org, actor, old, false);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.policy.update({ where: { id }, data: { status: 'ACTIVE', activeVersion: p.version, workflowIds: [...ids, ...p.workflowIds.slice(rules.length)], approvedById: actor.id, approvedAt: new Date() } });
      await tx.policyVersion.create({ data: { orgId: org.id, policyId: id, version: p.version, name: p.name, statement: p.statement, rules: p.rules as Prisma.InputJsonValue, tests: p.tests as Prisma.InputJsonValue, event: 'APPROVED', note: input.note?.trim() || null, createdById: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'policy.approved', entityType: 'policy', entityId: id, data: { version: p.version, workflows: ids, note: input.note?.trim() || null } });
    });
    return this.get(org.id, id);
  }

  /** Stops the policy: every workflow it runs is turned off. Its history stays. */
  async retire(org: OrgContext, actor: Actor, id: string, note: string | null) {
    const p = await this.find(org.id, id);
    if (p.status === 'RETIRED') throw new DomainError('POLICY_RETIRED', 'This policy is already retired', HttpStatus.CONFLICT);
    for (const wid of p.workflowIds) {
      const w = await this.workflows.get(org.id, wid).catch(() => null);
      if (w?.enabled) await this.workflows.setEnabled(org, actor, wid, false);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.policy.update({ where: { id }, data: { status: 'RETIRED', activeVersion: null } });
      await tx.policyVersion.create({ data: { orgId: org.id, policyId: id, version: p.version, name: p.name, statement: p.statement, rules: p.rules as Prisma.InputJsonValue, tests: p.tests as Prisma.InputJsonValue, event: 'RETIRED', note: note?.trim() || null, createdById: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'policy.retired', entityType: 'policy', entityId: id, data: { version: p.version, note: note?.trim() || null } });
    });
    return this.get(org.id, id);
  }

  // ------------------------------------------------------------------ testing against the books

  /**
   * Runs rules (a saved policy's, or ones being edited) against what actually happened in the
   * last 90 days: for each event rule, how many events it would have acted on, with examples.
   * Rules on a schedule or a due date are not back-tested.
   */
  async backtest(orgId: string, rules: PolicyRule[]) {
    const since = new Date(Date.now() - BACKTEST_DAYS * 86_400_000);
    const out = [];
    for (const [i, r] of rules.entries()) {
      let def;
      try {
        def = triggerDef(r.trigger);
      } catch {
        out.push({ rule: i + 1, supported: false, note: 'Unknown trigger', checked: 0, acted: 0, examples: [] });
        continue;
      }
      if (def.kind !== 'event') {
        out.push({ rule: i + 1, supported: false, note: 'Rules on a schedule or a due date are not back-tested; use Test on the workflow once it exists.', checked: 0, acted: 0, examples: [] });
        continue;
      }
      const rows = await this.prisma.auditEvent.findMany({ where: { orgId, action: { in: [...def.auditActions] }, createdAt: { gte: since } }, orderBy: { id: 'desc' }, take: BACKTEST_LIMIT, select: { id: true, action: true, entityType: true, entityId: true, createdAt: true } });
      let checked = 0;
      let acted = 0;
      const examples: { label: string; at: string; facts: Record<string, string | null> }[] = [];
      for (const e of rows) {
        const f = await this.prisma.$transaction((tx) => loadEventFacts(tx, orgId, e));
        if (!f || f.trigger !== r.trigger) continue;
        checked++;
        let matched = false;
        try {
          matched = evaluateConditions(r.trigger, r.conditions ?? [], f.facts).matched;
        } catch {
          matched = false;
        }
        if (!matched) continue;
        acted++;
        if (examples.length < 5) examples.push({ label: f.link?.label ?? e.action, at: e.createdAt.toISOString(), facts: f.facts });
      }
      out.push({ rule: i + 1, supported: true, note: null, checked, acted, examples });
    }
    return { days: BACKTEST_DAYS, rules: out };
  }

  // ------------------------------------------------------------------ drafting with the AI

  /** Whether drafting with the AI is available, and why not. */
  async aiStatus(orgId: string) {
    const ai = await this.integrations.ai(orgId);
    const block = await this.guard.check(orgId, 'COPILOT');
    return { configured: ai.model !== null, model: ai.modelName, available: !block, reason: block?.message ?? null };
  }

  private prompt(currency: string) {
    const triggers = WORKFLOW_TRIGGER_DEFS.map((t) => `- ${t.key} (${t.label}${t.kind === 'schedule' ? '; schedule' : ''}): facts ${t.facts.map((f) => `${f.key} [${f.type}${f.options ? `: ${f.options.map((o) => o.value).join('|')}` : ''}]`).join(', ')}`).join('\n');
    return [
      'You help a finance team turn a financial policy, written in plain words, into automation rules for their accounting system. People will review, test and approve every rule before it runs, so be exact and never invent capabilities.',
      '',
      'Each rule has: a short name; a trigger; triggerParams (SCHEDULE: {frequency: DAILY|WEEKLY|MONTHLY, time: "HH:MM", weekday 1-7 for WEEKLY, dayOfMonth 1-28 for MONTHLY}; INVOICE_OVERDUE: {days 1-365}; BILL_DUE_SOON: {days 0-90}; otherwise {}); conditions that must all hold; and 1 to 5 actions.',
      'Triggers and the facts each offers:',
      triggers,
      '',
      `Condition operators: money ${CONDITION_OPERATORS.money.join(', ')} (value a plain decimal string in ${currency}, such as "500000.00"; 1 lakh = 100000, 1 crore = 10000000); text ${CONDITION_OPERATORS.text.join(', ')}; enum ${CONDITION_OPERATORS.enum.join(', ')} (value a list); date ${CONDITION_OPERATORS.date.join(', ')} (YYYY-MM-DD).`,
      `Actions: CREATE_TASK {title, description?, assignTo: {role}, dueInDays: number or null}; SEND_EMAIL {to: {role} or {contact: true} (only on triggers about a customer or vendor), subject (one line), body}. Roles: ${ASSIGNABLE_ROLES.join(', ')}. Titles, subjects and bodies may use {{fact}} placeholders of the rule's trigger. Never use webhooks or name individual people.`,
      'The system cannot block, hold or reverse a transaction; it can only give someone a task or send an email after something happens. If the policy asks for more (such as stopping a payment), say so in questions and propose the closest honest rule, such as a review task.',
      'Also write tests: for each rule, at least one made-up event where it should act and one where it should not (for example just above and exactly at a threshold), giving only the facts that matter.',
      'If something important is unclear (an amount, who should act, how quickly), make a sensible assumption, use it, and list a short question about it in questions.',
      'Answer only by calling propose_policy.',
    ].join('\n');
  }

  private tool(): CopilotTool {
    const condition = { type: 'object', properties: { fact: { type: 'string' }, op: { type: 'string' }, value: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } }, required: ['fact', 'op'] };
    const action = {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['CREATE_TASK', 'SEND_EMAIL'] },
        title: { type: 'string' },
        description: { type: 'string' },
        assignTo: { type: 'object', properties: { role: { type: 'string', enum: [...ASSIGNABLE_ROLES] } } },
        dueInDays: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        to: { type: 'object', properties: { role: { type: 'string', enum: [...ASSIGNABLE_ROLES] }, contact: { type: 'boolean' } } },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['type'],
    };
    return {
      name: 'propose_policy',
      description: 'Propose the rules and tests that enforce the policy, with any questions for the finance team.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A short name for the policy' },
          summary: { type: 'string', description: 'One or two sentences on what the rules do and any assumptions made' },
          rules: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, trigger: { type: 'string', enum: WORKFLOW_TRIGGER_DEFS.map((t) => t.key) }, triggerParams: { type: 'object' }, conditions: { type: 'array', items: condition }, actions: { type: 'array', items: action } }, required: ['name', 'trigger', 'conditions', 'actions'] } },
          tests: { type: 'array', items: { type: 'object', properties: { rule: { type: 'integer', description: '1-based rule number' }, label: { type: 'string' }, facts: { type: 'object', additionalProperties: { type: 'string' } }, expect: { type: 'string', enum: ['ACTS', 'DOES_NOT_ACT'] } }, required: ['rule', 'label', 'facts', 'expect'] } },
          questions: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'summary', 'rules', 'tests', 'questions'],
      },
    } as CopilotTool;
  }

  /**
   * Drafts a policy's rules and tests from the policy in words (and, to refine a draft, the
   * conversation so far). Nothing is saved as a policy: the draft comes back, checked, for a
   * person to edit and save. Each call is recorded with its tokens.
   */
  async draft(orgId: string, actor: Actor, input: { statement: string; conversation: ChatTurn[] }) {
    await this.guard.assert(orgId, 'COPILOT');
    const ai = await this.integrations.ai(orgId);
    if (!ai.model) throw new DomainError('AI_NOT_CONFIGURED', 'AI is not set up. An owner or admin can add a key in Settings → Integrations.', HttpStatus.SERVICE_UNAVAILABLE);
    const currency = await this.currency(orgId);
    const messages: CopilotRequest['messages'] = [
      { role: 'user', content: [{ type: 'text', text: `Our policy:\n\n${input.statement.trim()}` }] },
      ...input.conversation.map((t) => ({ role: t.role, content: [{ type: 'text' as const, text: t.text }] })),
    ];
    if (messages[messages.length - 1]!.role !== 'user') messages.push({ role: 'user', content: [{ type: 'text', text: 'Please propose the rules.' }] });
    const request: CopilotRequest = { model: ai.modelName, max_tokens: MAX_DRAFT_TOKENS, system: this.prompt(currency), tools: [this.tool()], tool_choice: { type: 'tool', name: 'propose_policy' }, messages, metadata: { user_id: actor.id } };
    const asked = [input.statement, ...input.conversation.map((t) => `${t.role}: ${t.text}`)].join('\n\n').slice(0, 8000);
    let res: Anthropic.Beta.Messages.BetaMessage;
    try {
      res = await ai.model.send(request, { signal: AbortSignal.timeout(this.config.COPILOT_TURN_TIMEOUT_SECONDS * 1000) });
    } catch (e) {
      const err = this.providerError(e);
      await this.record(orgId, actor, asked, { status: 'FAILED', errorCode: err.code, errorMessage: err.message, model: ai.modelName });
      throw new DomainError(err.code, err.message, HttpStatus.BAD_GATEWAY);
    }
    const tokens = { inputTokens: res.usage.input_tokens + (res.usage.cache_creation_input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0), outputTokens: res.usage.output_tokens, model: res.model };
    const call = res.content.find((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use' && b.name === 'propose_policy');
    if (res.stop_reason === 'refusal' || !call) {
      const msg = res.stop_reason === 'refusal' ? 'The AI model declined to draft this policy.' : 'The AI model did not propose any rules. Try describing the policy differently.';
      await this.record(orgId, actor, asked, { status: 'FAILED', errorCode: res.stop_reason === 'refusal' ? 'REFUSED' : 'NO_PROPOSAL', errorMessage: msg, ...tokens });
      throw new DomainError(res.stop_reason === 'refusal' ? 'REFUSED' : 'NO_PROPOSAL', msg, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const raw = call.input as { name?: unknown; summary?: unknown; rules?: unknown; tests?: unknown; questions?: unknown };
    const proposal = {
      name: typeof raw.name === 'string' ? raw.name.slice(0, 120) : '',
      summary: typeof raw.summary === 'string' ? raw.summary.slice(0, 2000) : '',
      rules: (Array.isArray(raw.rules) ? raw.rules : []).slice(0, MAX_POLICY_RULES).map((r) => ({ conditions: [], actions: [], triggerParams: {}, ...(r as object) })) as unknown as PolicyRule[],
      tests: (Array.isArray(raw.tests) ? raw.tests : []).slice(0, MAX_POLICY_TESTS) as PolicyTest[],
      questions: (Array.isArray(raw.questions) ? raw.questions : []).filter((q): q is string => typeof q === 'string').slice(0, 10),
    };
    // The draft is checked like any policy; problems are shown for people to fix, never hidden.
    const { issues } = checkPolicy({ name: proposal.name || 'Draft', statement: input.statement, rules: proposal.rules, tests: proposal.tests }, { allowHttp: false });
    const results = issues.length ? [] : runPolicyTests(proposal.rules, proposal.tests);
    const draft = await this.record(orgId, actor, asked, { status: 'DONE', result: proposal as unknown as Prisma.InputJsonValue, ...tokens });
    return { draftId: draft.id, ...proposal, descriptions: proposal.rules.map((r) => { try { return describeRule(r, currency); } catch { return null; } }), issues, testResults: results, model: res.model };
  }

  private async record(orgId: string, actor: Actor, request: string, data: { status: 'DONE' | 'FAILED'; result?: Prisma.InputJsonValue; errorCode?: string; errorMessage?: string; model?: string; inputTokens?: number; outputTokens?: number }) {
    return this.prisma.$transaction(async (tx) => {
      const d = await tx.policyAiDraft.create({ data: { orgId, request, createdById: actor.id, ...data } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: data.status === 'DONE' ? 'policy.ai_drafted' : 'policy.ai_draft_failed', entityType: 'policy_ai_draft', entityId: d.id, data: { promptVersion: POLICY_PROMPT_VERSION, model: data.model ?? null, inputTokens: data.inputTokens ?? 0, outputTokens: data.outputTokens ?? 0, errorCode: data.errorCode ?? null } });
      return d;
    });
  }

  private providerError(e: unknown): { code: string; message: string } {
    if (e instanceof Anthropic.APIUserAbortError || e instanceof Anthropic.APIConnectionTimeoutError || (e instanceof Error && e.name === 'TimeoutError')) return { code: 'AI_TIMEOUT', message: 'The AI provider took too long. Try again.' };
    if (e instanceof Anthropic.AuthenticationError) return { code: 'AI_KEY_REJECTED', message: 'The AI provider rejected the API key. An owner or admin needs to check the key in Settings → Integrations.' };
    if (e instanceof Anthropic.RateLimitError) return { code: 'AI_RATE_LIMITED', message: 'The AI provider is limiting requests right now. Try again in a minute.' };
    if (e instanceof Anthropic.APIConnectionError) return { code: 'AI_UNREACHABLE', message: 'The AI provider could not be reached. Try again shortly.' };
    if (e instanceof Anthropic.APIError) return { code: e.status === 529 ? 'AI_OVERLOADED' : 'AI_PROVIDER_ERROR', message: 'The AI provider returned an error. Try again shortly.' };
    this.log.error('Policy draft failed', e instanceof Error ? e.stack : String(e));
    return { code: 'INTERNAL', message: 'Something went wrong. Try again.' };
  }
}

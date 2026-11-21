import { describe, expect, it } from 'vitest';
import { agentForRequest, dataSourcesFor, explanationFor, MAX_EXPLANATION, PRIVATE_ANSWER, promptText, reasoningWithheld, toolsText } from '../src';

describe('AI decision records (AUDIT-018, 020, 021, 027, 029, 030)', () => {
  it('names the agent from the caller, the forced tool, or the copilot toolset', () => {
    expect(agentForRequest({}, 'CFO_SUMMARY')).toBe('CFO_SUMMARY');
    expect(agentForRequest({ tool_choice: { type: 'tool', name: 'submit_suggestion' }, tools: [{ name: 'submit_suggestion' }] })).toBe('BANK_MATCHING');
    expect(agentForRequest({ tools: [{ name: 'propose_dashboard' }] })).toBe('DASHBOARD_DRAFTER');
    expect(agentForRequest({ tools: [{ name: 'get_kpis' }, { name: 'get_ageing' }] })).toBe('COPILOT');
    expect(agentForRequest({ system: 'Write a summary' })).toBe('OTHER');
  });

  it('lists the data given: the caller\'s words, then each tool result read, once', () => {
    const req = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Question' }] },
        { role: 'assistant', content: [{ type: 'thinking' }, { type: 'tool_use', id: 'a', name: 'get_kpis', input: {} }, { type: 'tool_use', id: 'b', name: 'get_ageing', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a' }, { type: 'tool_result', tool_use_id: 'b' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'get_kpis', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c' }, { type: 'tool_result', tool_use_id: 'zz' }] },
      ],
    };
    expect(dataSourcesFor(req, ['The question'])).toEqual(['The question', 'Tool: get_kpis', 'Tool: get_ageing', 'Tool: unknown']);
    expect(dataSourcesFor({ messages: [{ role: 'user', content: 'plain text' }] })).toEqual([]);
  });

  it('explains from the tool\'s reason field or the text, never from thinking', () => {
    expect(explanationFor({ content: [{ type: 'thinking', text: 'secret' }, { type: 'tool_use', name: 'submit_suggestion', input: { action: 'MATCH', reason: '  Same amount and   date as invoice INV-7 ' } }] })).toBe('Same amount and date as invoice INV-7');
    expect(explanationFor({ content: [{ type: 'tool_use', name: 'get_kpis', input: { month: null } }] })).toBe('Used get_kpis');
    expect(explanationFor({ content: [{ type: 'thinking', text: 'secret' }, { type: 'text', text: 'Cash is fine.' }, { type: 'text', text: 'Receivables are low.' }] })).toBe('Cash is fine. Receivables are low.');
    expect(explanationFor({ content: [{ type: 'redacted_thinking' }] })).toBeNull();
    expect(explanationFor({ content: [{ type: 'text', text: 'Revenue was 12,000' }] }, { privateText: true })).toBe(PRIVATE_ANSWER);
    expect(explanationFor({ content: [{ type: 'tool_use', name: 'get_kpis', input: {} }] }, { privateText: true })).toBe('Used get_kpis');
    const long = explanationFor({ content: [{ type: 'text', text: 'x'.repeat(2000) }] })!;
    expect(long.length).toBe(MAX_EXPLANATION);
    expect(long.endsWith('…')).toBe(true);
  });

  it('notes hidden reasoning without keeping it, and takes versions from the prompt and tools as sent', () => {
    expect(reasoningWithheld({ content: [{ type: 'thinking' }, { type: 'text', text: 'x' }] })).toBe(true);
    expect(reasoningWithheld({ content: [{ type: 'redacted_thinking' }] })).toBe(true);
    expect(reasoningWithheld({ content: [{ type: 'text', text: 'x' }] })).toBe(false);
    expect(promptText({ system: 'You are' })).toBe('You are');
    expect(promptText({ system: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] })).toBe('A\nB');
    expect(promptText({})).toBe('');
    expect(toolsText({ tools: [{ name: 'a' }] })).toBe('[{"name":"a"}]');
    expect(toolsText({})).toBe('[]');
  });
});

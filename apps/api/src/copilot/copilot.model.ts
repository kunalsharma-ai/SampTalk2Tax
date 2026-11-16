import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig } from '../config';

/** The request the copilot sends for one step of an answer. */
export type CopilotRequest = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type CopilotResponse = Anthropic.Beta.Messages.BetaMessage;
export type CopilotMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
export type CopilotTool = Anthropic.Beta.Messages.BetaTool;

/**
 * The language model behind the copilot. Production uses Anthropic's Claude API
 * (AnthropicCopilotModel). Tests put a scripted stand-in here to drive the tool loop
 * against the real database; nothing a stand-in returns is ever shown outside tests.
 */
export interface CopilotModel {
  readonly provider: string;
  send(request: CopilotRequest, options: { signal: AbortSignal }): Promise<CopilotResponse>;
}

export const COPILOT_MODEL = Symbol('COPILOT_MODEL');

/** Server-side fallback: when the model declines, the API re-runs the request on the model Anthropic recommends for that kind of refusal. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class AnthropicCopilotModel implements CopilotModel {
  readonly provider = 'Anthropic';
  private readonly client: Anthropic;

  constructor(apiKey: string, baseURL?: string) {
    // The SDK retries connection errors, 408, 409, 429 and 5xx with backoff.
    this.client = new Anthropic({ apiKey, maxRetries: 2, ...(baseURL ? { baseURL } : {}) });
  }

  async send(request: CopilotRequest, options: { signal: AbortSignal }): Promise<CopilotResponse> {
    // Streamed so a long answer never runs into an HTTP idle timeout; only the final message is used.
    return this.client.beta.messages.stream(request, { signal: options.signal }).finalMessage();
  }
}

/** The configured model, or null when no API key is set (the copilot then reports that it is not set up). */
export function copilotModelFromConfig(config: AppConfig): CopilotModel | null {
  return config.ANTHROPIC_API_KEY ? new AnthropicCopilotModel(config.ANTHROPIC_API_KEY, config.ANTHROPIC_BASE_URL) : null;
}

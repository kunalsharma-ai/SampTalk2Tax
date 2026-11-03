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

  /** modelName, when given, replaces the model in every request (an organisation's own choice of Claude model). */
  constructor(
    apiKey: string,
    baseURL?: string,
    private readonly modelName?: string,
  ) {
    // The SDK retries connection errors, 408, 409, 429 and 5xx with backoff.
    this.client = new Anthropic({ apiKey, maxRetries: 2, ...(baseURL ? { baseURL } : {}) });
  }

  async send(request: CopilotRequest, options: { signal: AbortSignal }): Promise<CopilotResponse> {
    // Streamed so a long answer never runs into an HTTP idle timeout; only the final message is used.
    const r = this.modelName ? { ...request, model: this.modelName } : request;
    return this.client.beta.messages.stream(r, { signal: options.signal }).finalMessage();
  }
}

/** The server's fallback model from ANTHROPIC_API_KEY, or null. Organisations can set their own key in Settings → Integrations. */
export function copilotModelFromConfig(config: AppConfig): CopilotModel | null {
  return config.ANTHROPIC_API_KEY ? new AnthropicCopilotModel(config.ANTHROPIC_API_KEY, config.ANTHROPIC_BASE_URL) : null;
}

import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from '@nestjs/common';

/** A failed call to the AI provider, in words people can act on. */
export function aiProviderError(e: unknown, log: Logger, what: string): { code: string; message: string } {
  if (e instanceof Anthropic.APIUserAbortError || e instanceof Anthropic.APIConnectionTimeoutError || (e instanceof Error && e.name === 'TimeoutError')) return { code: 'AI_TIMEOUT', message: 'The AI provider took too long. Try again.' };
  if (e instanceof Anthropic.AuthenticationError) return { code: 'AI_KEY_REJECTED', message: 'The AI provider rejected the API key. An owner or admin needs to check the key in Settings → Integrations.' };
  if (e instanceof Anthropic.RateLimitError) return { code: 'AI_RATE_LIMITED', message: 'The AI provider is limiting requests right now. Try again in a minute.' };
  if (e instanceof Anthropic.APIConnectionError) return { code: 'AI_UNREACHABLE', message: 'The AI provider could not be reached. Try again shortly.' };
  if (e instanceof Anthropic.APIError) return { code: e.status === 529 ? 'AI_OVERLOADED' : 'AI_PROVIDER_ERROR', message: 'The AI provider returned an error. Try again shortly.' };
  log.error(`${what} failed`, e instanceof Error ? e.stack : String(e));
  return { code: 'INTERNAL', message: 'Something went wrong. Try again.' };
}

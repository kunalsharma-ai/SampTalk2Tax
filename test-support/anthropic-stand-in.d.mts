export interface StandInStep {
  (body: any, headers: Record<string, string | string[] | undefined>):
    | { content: unknown[]; stop_reason?: string; model?: string; inputTokens?: number; outputTokens?: number }
    | { status: number; type: string; message: string }
    | Promise<{ content: unknown[]; stop_reason?: string; model?: string } | { status: number; type: string; message: string }>;
}
export interface AnthropicStandIn {
  url: string;
  requests: { headers: Record<string, string | string[] | undefined>; body: any }[];
  script: StandInStep[];
  close: () => Promise<void>;
}
export function startAnthropicStandIn(port?: number): Promise<AnthropicStandIn>;

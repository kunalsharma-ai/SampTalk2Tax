export interface WebhookTarget {
  url: string;
  secret: string;
}
export interface PaymentsStandIn {
  url: string;
  keys: { STRIPE: string; RAZORPAY: { keyId: string; secret: string } };
  webhooks: { STRIPE: WebhookTarget | null; RAZORPAY: WebhookTarget | null };
  sessions: Map<string, Record<string, any>>;
  links: Map<string, Record<string, any>>;
  requests: { method: string; path: string; headers: Record<string, string>; body: string }[];
  sent: { provider: string; type: string; status: number | null; body: string }[];
  /** As if the customer paid: marks the checkout paid and (unless webhook is false) sends the signed webhook. */
  pay(ref: string, opts?: { webhook?: boolean; amount?: number }): Promise<{ redirect: string } | null>;
  close(): Promise<void>;
}
export function startPaymentsStandIn(port?: number, opts?: { stripeKey?: string; razorpayKeyId?: string; razorpaySecret?: string; stripeWebhook?: WebhookTarget; razorpayWebhook?: WebhookTarget }): Promise<PaymentsStandIn>;

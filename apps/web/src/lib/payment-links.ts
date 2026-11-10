export type PaymentLinkStatus = 'OPEN' | 'PAID' | 'CANCELLED' | 'EXPIRED';
export type GatewayProvider = 'RAZORPAY' | 'STRIPE';

export const LINK_STATUS_LABEL: Record<PaymentLinkStatus, string> = { OPEN: 'Open', PAID: 'Paid', CANCELLED: 'Cancelled', EXPIRED: 'Expired' };
export const LINK_STATUS_TONE: Record<PaymentLinkStatus, 'accent' | 'positive' | 'neutral' | 'warning'> = { OPEN: 'accent', PAID: 'positive', CANCELLED: 'neutral', EXPIRED: 'warning' };

export interface PaymentLink {
  id: string;
  reference: string;
  documentId: string;
  provider: GatewayProvider;
  url: string;
  currency: string;
  amount: string;
  status: PaymentLinkStatus;
  expiresAt: string | null;
  paidAt: string | null;
  paidAmount: string | null;
  gatewayPaymentId: string | null;
  settledBy: string | null;
  cancelledAt: string | null;
  createdAt: string;
  invoice: { id: string; number: string | null } | null;
  receipt: { id: string; number: string } | null;
}

export interface InvoiceLinks {
  links: PaymentLink[];
  outstanding: string;
  currency: string;
  gateway: { provider: GatewayProvider; name: string; mode: 'TEST' | 'LIVE' } | null;
  can: { manage: boolean; setUp: boolean };
}

export interface OrgGateway {
  provider: GatewayProvider;
  name: string;
  configured: boolean;
  enabled: boolean;
  mode: 'TEST' | 'LIVE';
  currencies: string[];
  keyId: string | null;
  secretHint: string | null;
  webhookHint: string | null;
  depositAccount: { id: string; code: string; name: string } | null;
  needsReentry: boolean;
  lastTest: { at: string; ok: boolean; message: string } | null;
  webhookUrl: string;
  webhookEvents: string[];
  updatedAt: string | null;
}

export interface OrgGateways {
  gateways: OrgGateway[];
  depositAccounts: { id: string; code: string; name: string }[];
  currencies: string[];
  notices: { provider: GatewayProvider; type: string; signatureOk: boolean; outcome: string; receivedAt: string }[];
  can: { manage: boolean };
}

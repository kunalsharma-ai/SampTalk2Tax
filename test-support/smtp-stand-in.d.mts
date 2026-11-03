export interface StandInMessage {
  from: string;
  to: string[];
  raw: string;
  headers: Record<string, string>;
  subject: string;
  text: string;
}
export interface SmtpStandIn {
  url: string;
  port: number;
  messages: StandInMessage[];
  /** An SMTP answer (such as "550 5.1.1 No such mailbox") given when this address is a recipient. Lower case. */
  answers: Map<string, string>;
  /** Logins seen (AUTH PLAIN). */
  logins: { user: string; pass: string }[];
  /** refuseLogins: answer every login with 535. */
  settings: { refuseLogins: boolean };
  close: () => Promise<void>;
}
export function startSmtpStandIn(port?: number): Promise<SmtpStandIn>;

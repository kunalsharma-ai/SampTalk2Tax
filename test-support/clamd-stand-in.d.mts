export const EICAR: string;
export interface ClamdStandIn {
  mode: 'ok' | 'error';
  scanned: number;
  close(): Promise<void>;
}
export function startClamdStandIn(port?: number): Promise<ClamdStandIn>;

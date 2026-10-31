import 'server-only';

export const SESSION_COOKIE = 't2t_session';

export function apiBaseUrl(): string {
  return (process.env.T2T_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
}

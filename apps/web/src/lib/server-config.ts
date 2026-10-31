import 'server-only';

/** Short-lived access token (JWT). */
export const SESSION_COOKIE = 't2t_session';
/** Long-lived, rotating refresh token. Both cookies are httpOnly. */
export const REFRESH_COOKIE = 't2t_refresh';

export function apiBaseUrl(): string {
  return (process.env.T2T_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
}

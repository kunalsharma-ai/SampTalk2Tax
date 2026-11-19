import 'server-only';

/** Short-lived access token (JWT). */
export const SESSION_COOKIE = 't2t_session';
/** Long-lived, rotating refresh token. Both cookies are httpOnly. */
export const REFRESH_COOKIE = 't2t_refresh';
/** The sign-in waiting for a two-step code (five minutes; httpOnly, so page scripts never see it). */
export const MFA_CHALLENGE_COOKIE = 't2t_mfa';
/** A random key naming this browser, so the API knows a new device from one seen before (httpOnly, 400 days). */
export const DEVICE_COOKIE = 't2t_device';
/** A random value binding a single sign-on to the browser that started it (ten minutes; httpOnly). */
export const SSO_BINDING_COOKIE = 't2t_sso';

export function apiBaseUrl(): string {
  return (process.env.T2T_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
}

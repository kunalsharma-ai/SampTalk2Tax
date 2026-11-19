/**
 * security.txt (RFC 9116) for SEC-026: only when SECURITY_CONTACT holds a mailto: or https: address.
 */
const DAY = 24 * 60 * 60 * 1000;

export function securityTxt(env: NodeJS.ProcessEnv, origin: string, now = new Date()): string | null {
  const contacts = (env.SECURITY_CONTACT ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => /^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/i.test(c));
  if (!contacts.length) return null;
  // At most a year ahead, as the RFC asks; 180 days unless the server says otherwise.
  const days = Math.min(Math.max(Number(env.SECURITY_TXT_EXPIRES_DAYS) || 180, 1), 365);
  const lines = [
    ...contacts.map((c) => `Contact: ${c}`),
    `Expires: ${new Date(now.getTime() + days * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
    ...(env.SECURITY_POLICY_URL && /^https:\/\//i.test(env.SECURITY_POLICY_URL) ? [`Policy: ${env.SECURITY_POLICY_URL}`] : []),
    'Preferred-Languages: en, hi',
    `Canonical: ${origin}/.well-known/security.txt`,
  ];
  return `${lines.join('\n')}\n`;
}


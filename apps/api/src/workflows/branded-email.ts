import { EMAIL_LOGO_PNG, EMAIL_LOGO_SIZE } from '../common/brand-assets';

/** Content id of the logo inside the email, so it shows without loading anything from the web. */
export const EMAIL_LOGO_CID = 'talk2tax-logo@talk2tax';

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Escapes one line and turns http(s) links in it into anchors. */
function lineHtml(line: string): string {
  const parts = line.split(/(https?:\/\/[^\s<>"]+)/g);
  return parts
    .map((p, i) => {
      if (i % 2 === 0) return escapeHtml(p);
      // A sentence's closing punctuation is not part of the link.
      const m = /^(.*?)([.,;:!?)]*)$/.exec(p)!;
      const href = escapeHtml(m[1]);
      return `<a href="${href}" style="color:#0369a1;text-decoration:underline">${href}</a>${escapeHtml(m[2])}`;
    })
    .join('');
}

/**
 * The HTML version of an email Talk2Tax sends in its own name (support replies, subscription
 * reminders): the plain text, unchanged in meaning, under the Talk2Tax logo. Emails an
 * organisation sends to its own customers or staff (collections, automations) are never branded.
 * Inline styles and a table layout, because many mail apps drop <style> blocks.
 */
export function brandedEmailHtml(text: string, subject: string): string {
  const paragraphs = text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${p.split('\n').map(lineHtml).join('<br>')}</p>`)
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
<tr><td style="height:4px;background:#0ea5e9;background-image:linear-gradient(90deg,#5eead4,#0ea5e9,#1d4ed8)"></td></tr>
<tr><td style="padding:24px 28px 8px"><img src="cid:${EMAIL_LOGO_CID}" width="${EMAIL_LOGO_SIZE.width}" height="${EMAIL_LOGO_SIZE.height}" alt="Talk2Tax by Sampledge" style="display:block;border:0"></td></tr>
<tr><td style="padding:12px 28px 12px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#0f172a">
${paragraphs}
</td></tr>
<tr><td style="padding:14px 28px 22px;border-top:1px solid #e2e8f0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:#64748b">Talk2Tax by Sampledge &middot; Talk. File. Relax.</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

/** The logo as an inline attachment for nodemailer, referenced by the HTML above. */
export const brandedEmailAttachments = () => [{ filename: 'talk2tax.png', content: EMAIL_LOGO_PNG, contentType: 'image/png', cid: EMAIL_LOGO_CID, contentDisposition: 'inline' as const }];

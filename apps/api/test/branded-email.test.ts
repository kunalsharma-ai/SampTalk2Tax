import { describe, expect, it } from 'vitest';
import { EMAIL_LOGO_PNG, PDF_ICON_PNG } from '../src/common/brand-assets';
import { brandedEmailAttachments, brandedEmailHtml, EMAIL_LOGO_CID } from '../src/workflows/branded-email';

describe('branded email', () => {
  it('keeps the text, escapes it, links URLs and shows the inline logo', () => {
    const html = brandedEmailHtml('Hello <Asha> & team,\n\nPay or change plan: https://app.talk2tax.test/orgs/o1/settings/subscription.\nThanks', 'Payment due: <Acme>');
    expect(html).toContain('<title>Payment due: &lt;Acme&gt;</title>');
    expect(html).toContain('<p style="margin:0 0 14px">Hello &lt;Asha&gt; &amp; team,</p>');
    // The full stop after the link stays outside it.
    expect(html).toContain('<a href="https://app.talk2tax.test/orgs/o1/settings/subscription" style="color:#0369a1;text-decoration:underline">https://app.talk2tax.test/orgs/o1/settings/subscription</a>.<br>Thanks');
    expect(html).toContain(`src="cid:${EMAIL_LOGO_CID}"`);
    expect(html).toContain('alt="Talk2Tax by Sampledge"');
    expect(html).not.toContain('<Asha>');
  });

  it('never lets text become markup or a script link', () => {
    const html = brandedEmailHtml('javascript:alert(1) "><img src=x onerror=alert(1)> http://x.test/"onmouseover=1', 's');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('href="javascript');
    // A quote ends the link; the rest stays text.
    expect(html).toContain('>http://x.test/</a>&quot;onmouseover=1');
  });

  it('attaches the logo as an inline PNG', () => {
    const [a] = brandedEmailAttachments();
    expect(a).toMatchObject({ cid: EMAIL_LOGO_CID, contentType: 'image/png', contentDisposition: 'inline' });
    for (const png of [EMAIL_LOGO_PNG, PDF_ICON_PNG]) expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  });
});

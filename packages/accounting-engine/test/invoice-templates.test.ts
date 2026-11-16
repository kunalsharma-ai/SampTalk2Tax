import { describe, expect, it } from 'vitest';
import {
  COUNTRY_PRESETS,
  InvoiceTemplateError,
  amountInWords,
  buildInvoiceView,
  canonicalInvoiceContent,
  checkHtmlTemplate,
  compileTemplate,
  contrastRatio,
  formatAmount,
  formatDate,
  layoutFromPreset,
  layoutWarnings,
  normaliseLayout,
  presetForCountry,
  renderInvoiceDocument,
  renderPlaceholders,
  sampleInvoiceSource,
  sniffImageType,
  starterHtml,
} from '../src/invoice-templates';

describe('amount in words', () => {
  it('uses lakh and crore for rupees', () => {
    expect(amountInWords('120050.50', 'INR')).toBe('Rupees One Lakh Twenty Thousand Fifty and Fifty Paise Only');
    expect(amountInWords('25000000', 'INR')).toBe('Rupees Two Crore Fifty Lakh Only');
    expect(amountInWords('1234567890', 'INR')).toBe(
      'Rupees One Hundred Twenty-Three Crore Forty-Five Lakh Sixty-Seven Thousand Eight Hundred Ninety Only',
    );
  });
  it('uses thousands and millions elsewhere', () => {
    expect(amountInWords('1205.05', 'USD')).toBe('US Dollars One Thousand Two Hundred Five and Five Cents Only');
    expect(amountInWords('2500000', 'AED')).toBe('UAE Dirhams Two Million Five Hundred Thousand Only');
    expect(amountInWords('0', 'GBP')).toBe('Pounds Sterling Zero Only');
    expect(amountInWords('-12.10', 'EUR')).toBe('Minus Euros Twelve and Ten Cents Only');
  });
  it('handles zero-decimal currencies and rounding', () => {
    expect(amountInWords('1500', 'JPY')).toBe('Yen One Thousand Five Hundred Only');
    expect(amountInWords('99.995', 'USD')).toBe('US Dollars One Hundred Only');
  });
});

describe('formatting', () => {
  it('groups digits the Indian or international way', () => {
    expect(formatAmount('1234567.5', 'INR', 'INDIAN')).toBe('12,34,567.50');
    expect(formatAmount('1234567.5', 'INR', 'INTERNATIONAL')).toBe('1,234,567.50');
    expect(formatAmount('-999.999', 'USD', 'INTERNATIONAL')).toBe('-1,000.00');
    expect(formatAmount('500', 'INR', 'INDIAN')).toBe('500.00');
  });
  it('formats dates in three styles', () => {
    expect(formatDate('2026-11-02', 'DMY')).toBe('02 Nov 2026');
    expect(formatDate('2026-11-02', 'MDY')).toBe('Nov 2, 2026');
    expect(formatDate('2026-11-02', 'ISO')).toBe('2026-11-02');
  });
});

describe('placeholders', () => {
  const view = {
    seller: { name: 'A & B <Traders>' },
    lines: [{ description: 'One' }, { description: 'Two' }],
    empty: [],
    flag: true,
  };
  it('escapes every value', () => {
    expect(renderPlaceholders('Hi {{seller.name}}', view)).toBe('Hi A &amp; B &lt;Traders&gt;');
  });
  it('repeats lists and shows inverted sections when empty', () => {
    expect(renderPlaceholders('{{#lines}}[{{description}}|{{seller.name}}]{{/lines}}', { ...view, seller: { name: 'S' } })).toBe(
      '[One|S][Two|S]',
    );
    expect(renderPlaceholders('{{#empty}}x{{/empty}}{{^empty}}none{{/empty}}', view)).toBe('none');
    expect(renderPlaceholders('{{#flag}}yes{{/flag}}{{! a comment }}', view)).toBe('yes');
  });
  it('turns new lines into breaks when asked', () => {
    expect(renderPlaceholders('{{a}}', { a: 'x\ny' }, { newlines: true })).toBe('x<br>y');
  });
  it('refuses unescaped and broken placeholders', () => {
    expect(() => compileTemplate('{{{logo}}}')).toThrow(/unescaped/);
    expect(() => compileTemplate('{{&logo}}')).toThrow(/unescaped/);
    expect(() => compileTemplate('{{#lines}}x')).toThrow(/never closed/);
    expect(() => compileTemplate('{{#a}}{{/b}}')).toThrow(/does not close/);
    expect(() => compileTemplate('{{ a b }}')).toThrow(/not a valid placeholder/);
  });
  it('does not read inherited properties', () => {
    expect(renderPlaceholders('{{constructor}}{{seller.toString}}', view)).toBe('');
  });
});

describe('HTML template checks', () => {
  it('accepts the starter for every preset and knows its placeholders', () => {
    for (const p of COUNTRY_PRESETS) {
      const check = checkHtmlTemplate(starterHtml(p.id));
      expect(check.errors, p.id).toEqual([]);
      expect(check.unknownPlaceholders, p.id).toEqual([]);
    }
  });
  it('refuses scripts, handlers, javascript: links, frames, forms and page shells', () => {
    const bad = [
      ['<script>alert(1)</script>', /<script>/],
      ['<img src="data:image/png;base64,AA" onerror="x()">', /onerror/],
      ['<a href="javascript:alert(1)">x</a>', /javascript:/],
      ['<iframe srcdoc="x"></iframe>', /<iframe>/],
      ['<form><input></form>', /<form>/],
      ['<html><body>x</body></html>', /Write only the page body/],
      ['<meta http-equiv="refresh" content="0">', /<meta>/],
      ['<svg><foreignObject></foreignObject></svg>', /<foreignobject>/],
    ] as const;
    for (const [html, re] of bad) {
      const check = checkHtmlTemplate(html);
      expect(check.ok, html).toBe(false);
      expect(check.errors.join(' '), html).toMatch(re);
    }
  });
  it('refuses anything that loads from the network', () => {
    for (const html of [
      '<img src="https://evil.example/p.png">',
      '<img src="//evil.example/p.png">',
      '<div style="background:url(https://x.example/a)"></div>',
      '<style>@import "x.css";</style>',
    ]) {
      expect(checkHtmlTemplate(html).ok, html).toBe(false);
    }
    expect(checkHtmlTemplate('<img src="{{logo}}"><img src="data:image/png;base64,AAAA">').ok).toBe(true);
  });
  it('reports placeholder errors with the line and lists unknown names', () => {
    const check = checkHtmlTemplate('<p>\n{{#lines}}\n</p>');
    expect(check.errors[0]).toMatch(/line 2 is never closed/);
    const unknown = checkHtmlTemplate('{{doc.number}} {{doc.nmuber}} {{#lines}}{{amount}}{{qty}}{{/lines}}');
    expect(unknown.unknownPlaceholders.sort()).toEqual(['doc.nmuber', 'qty']);
  });
});

describe('layouts and presets', () => {
  it('builds a layout for every preset that passes its own checks', () => {
    for (const p of COUNTRY_PRESETS) {
      const layout = layoutFromPreset(p.id);
      expect(normaliseLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
      expect(layoutWarnings(layout, p.id), p.id).toEqual([]);
    }
  });
  it('picks the preset for a country', () => {
    expect(presetForCountry('IN').id).toBe('IN_GST');
    expect(presetForCountry('de').id).toBe('EU_VAT');
    expect(presetForCountry('BR').id).toBe('GENERIC');
  });
  it('warns when a country rule is no longer met or colours are hard to read', () => {
    const layout = layoutFromPreset('IN_GST');
    layout.title = 'Bill';
    layout.sections.find((s) => s.key === 'LINES')!.columns!.find((c) => c.key === 'HSN')!.visible = false;
    layout.sections.find((s) => s.key === 'SIGNATURE')!.visible = false;
    layout.palette.text = '#eeeeee';
    const warnings = layoutWarnings(layout, 'IN_GST');
    expect(warnings).toHaveLength(4);
    expect(warnings.join(' ')).toMatch(/Tax Invoice/);
    expect(warnings.join(' ')).toMatch(/HSN/);
    expect(warnings.join(' ')).toMatch(/signature/);
    expect(warnings.join(' ')).toMatch(/hard to read/);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });
  it('keeps the section order given and fills in missing sections hidden', () => {
    const layout = layoutFromPreset('GENERIC');
    const raw = JSON.parse(JSON.stringify(layout));
    raw.sections = [raw.sections[4], raw.sections[0]];
    const clean = normaliseLayout(raw);
    expect(clean.sections.slice(0, 2).map((s) => s.key)).toEqual(['LINES', 'HEADER']);
    expect(clean.sections).toHaveLength(13);
    expect(clean.sections.find((s) => s.key === 'TOTALS')!.visible).toBe(false);
  });
  it('refuses bad colours, duplicate sections, a hidden description and broken text', () => {
    const base = () => JSON.parse(JSON.stringify(layoutFromPreset('GENERIC')));
    const a = base();
    a.palette.primary = 'red';
    expect(() => normaliseLayout(a)).toThrow(/hex colour/);
    const b = base();
    b.sections.push(b.sections[0]);
    expect(() => normaliseLayout(b)).toThrow(/appears twice/);
    const c = base();
    c.sections.find((s: { key: string }) => s.key === 'LINES').columns[1].visible = false;
    expect(() => normaliseLayout(c)).toThrow(/Description/);
    const d = base();
    d.sections[0].text = '{{#x}}';
    expect(() => normaliseLayout(d)).toThrow(InvoiceTemplateError);
  });
});

describe('rendering', () => {
  it('builds the India view with tax by head and lakh words', () => {
    const src = sampleInvoiceSource('IN_GST');
    const view = buildInvoiceView(src, layoutFromPreset('IN_GST'));
    expect(view.hasGst).toBe(true);
    expect(view.taxes).toEqual([
      { rate: '18%', taxable: '1,64,000.00', cgst: '14,760.00', sgst: '14,760.00', igst: '0.00', amount: '29,520.00' },
    ]);
    expect(view.totals.total).toBe('1,93,520.00');
    expect(view.amountInWords).toBe('Rupees One Lakh Ninety-Three Thousand Five Hundred Twenty Only');
    expect(view.doc.placeOfSupply).toBe('27 Maharashtra');
  });
  it('renders every preset and theme as a page with no script and a strict policy', () => {
    for (const p of COUNTRY_PRESETS) {
      for (const theme of ['CLASSIC', 'MODERN', 'MINIMAL', 'BOLD', 'ELEGANT'] as const) {
        const layout = { ...layoutFromPreset(p.id), theme };
        const html = renderInvoiceDocument({ engine: 'LAYOUT', layout }, sampleInvoiceSource(p.id));
        expect(html).toContain("default-src 'none'");
        expect(html).not.toMatch(/<script/i);
        expect(html).toContain('INV-000123');
        expect(html).toContain(layout.title.split(' |')[0]!);
      }
    }
  });
  it('escapes invoice data and section text in layouts', () => {
    const layout = layoutFromPreset('GENERIC');
    layout.sections.find((s) => s.key === 'FOOTER')!.text = 'Thanks {{buyer.name}}\nSee you';
    const src = { ...sampleInvoiceSource('GENERIC'), buyer: { ...sampleInvoiceSource('GENERIC').buyer, name: '<img src=x onerror=alert(1)>' } };
    const html = renderInvoiceDocument({ engine: 'LAYOUT', layout }, src);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('Thanks &lt;img src=x onerror=alert(1)&gt;<br>See you');
  });
  it('hides sections, orders them and pairs half-width ones', () => {
    const layout = layoutFromPreset('GENERIC');
    layout.sections.find((s) => s.key === 'TERMS')!.visible = false;
    layout.sections.find((s) => s.key === 'TERMS')!.text = 'SECRET TERMS';
    const lines = layout.sections.find((s) => s.key === 'LINES')!;
    lines.columns!.find((c) => c.key === 'UNIT_PRICE')!.label = 'Price each';
    const html = renderInvoiceDocument({ engine: 'LAYOUT', layout }, sampleInvoiceSource('GENERIC'));
    expect(html).not.toContain('SECRET TERMS');
    expect(html).toContain('Price each');
    expect(html).toMatch(/<div class="row"><div class="sec s-meta[^"]*">.*?<\/div><div class="sec s-parties/);
  });
  it('marks drafts and voids and shows the signature once signed', () => {
    const src = sampleInvoiceSource('IN_GST');
    const layout = layoutFromPreset('IN_GST');
    expect(renderInvoiceDocument({ engine: 'LAYOUT', layout }, { ...src, status: 'DRAFT' })).toContain('class="stamp">DRAFT');
    const signed = renderInvoiceDocument(
      { engine: 'LAYOUT', layout },
      {
        ...src,
        signature: {
          imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
          signerName: 'Asha Rao',
          designation: 'Director',
          signedAt: '2026-11-02T10:15:00.000Z',
          contentHash: 'ab'.repeat(32),
        },
      },
    );
    expect(signed).toContain('Asha Rao, Director');
    expect(signed).toContain('E-signed 02 Nov 2026, 10:15 UTC');
    expect(signed).toContain('Content hash abababababababab');
  });
  it('renders HTML templates with escaped values and refuses unsafe ones', () => {
    const layout = layoutFromPreset('US_SALES');
    const html = renderInvoiceDocument({ engine: 'HTML', layout, html: starterHtml('US_SALES') }, sampleInvoiceSource('US_SALES'));
    expect(html).toContain('Implementation services, October');
    expect(html).toContain('size: letter');
    expect(() => renderInvoiceDocument({ engine: 'HTML', layout, html: '<script></script>' }, sampleInvoiceSource('US_SALES'))).toThrow(
      /<script>/,
    );
  });
});

describe('signatures and images', () => {
  const base = {
    documentId: 'd1',
    orgId: 'o1',
    kind: 'INVOICE',
    number: 'INV-1',
    issueDate: '2026-11-02',
    dueDate: '2026-12-02',
    currency: 'INR',
    contactName: 'Acme',
    contactTaxId: null,
    lines: [{ description: 'A', quantity: '1', unitPrice: '100', taxRate: '18', netAmount: '100', taxAmount: '18' }],
    subtotal: '100',
    taxTotal: '18',
    total: '118',
  };
  it('gives the same content for equal amounts written differently, and different content for changes', () => {
    expect(canonicalInvoiceContent(base)).toBe(canonicalInvoiceContent({ ...base, total: '118.000000', issueDate: '2026-11-02T00:00:00Z' }));
    expect(canonicalInvoiceContent(base)).not.toBe(canonicalInvoiceContent({ ...base, total: '119' }));
    expect(canonicalInvoiceContent(base)).not.toBe(canonicalInvoiceContent({ ...base, contactName: 'Acme Ltd' }));
  });
  it('recognises PNG, JPEG and WebP and refuses SVG', () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
  });
});

describe('section text is plain text', () => {
  it('escapes HTML typed into a section', () => {
    const layout = layoutFromPreset('GENERIC');
    layout.sections.find((s) => s.key === 'TERMS')!.text = '<b onclick="x()">Pay</b> {{doc.number}}';
    const html = renderInvoiceDocument({ engine: 'LAYOUT', layout }, sampleInvoiceSource('GENERIC'));
    expect(html).toContain('&lt;b onclick=&quot;x()&quot;&gt;Pay&lt;/b&gt; INV-000123');
    expect(html).not.toContain('<b onclick');
  });
});

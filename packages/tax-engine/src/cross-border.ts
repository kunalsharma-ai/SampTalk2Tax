import { D } from '@talk2tax/accounting-engine';

/**
 * Cross-border tax reporting (TAX-038): sales to and purchases from businesses in other countries,
 * by country, from the countries on contacts. For an EU business it lists intra-EU supplies by
 * customer VAT ID (the recapitulative statement or EC Sales List), and for everyone it flags what
 * usually needs a second look: tax charged on an export, a purchase from abroad without the reverse
 * charge, an intra-EU zero-rated supply without the customer's VAT ID and foreign documents whose
 * contact has no country. Deterministic; the treatment notes are general and need an adviser's review.
 */

const COUNTRY_LIST =
  "AD Andorra|AE United Arab Emirates|AF Afghanistan|AG Antigua and Barbuda|AL Albania|AM Armenia|AO Angola|AR Argentina|AT Austria|AU Australia|AZ Azerbaijan|BA Bosnia and Herzegovina|BB Barbados|BD Bangladesh|BE Belgium|BF Burkina Faso|BG Bulgaria|BH Bahrain|BI Burundi|BJ Benin|BN Brunei|BO Bolivia|BR Brazil|BS Bahamas|BT Bhutan|BW Botswana|BY Belarus|BZ Belize|CA Canada|CD Democratic Republic of the Congo|CF Central African Republic|CG Republic of the Congo|CH Switzerland|CI Côte d'Ivoire|CL Chile|CM Cameroon|CN China|CO Colombia|CR Costa Rica|CU Cuba|CV Cabo Verde|CY Cyprus|CZ Czechia|DE Germany|DJ Djibouti|DK Denmark|DM Dominica|DO Dominican Republic|DZ Algeria|EC Ecuador|EE Estonia|EG Egypt|ER Eritrea|ES Spain|ET Ethiopia|FI Finland|FJ Fiji|FR France|GA Gabon|GB United Kingdom|GD Grenada|GE Georgia|GH Ghana|GM Gambia|GN Guinea|GQ Equatorial Guinea|GR Greece|GT Guatemala|GW Guinea-Bissau|GY Guyana|HK Hong Kong|HN Honduras|HR Croatia|HT Haiti|HU Hungary|ID Indonesia|IE Ireland|IL Israel|IN India|IQ Iraq|IR Iran|IS Iceland|IT Italy|JM Jamaica|JO Jordan|JP Japan|KE Kenya|KG Kyrgyzstan|KH Cambodia|KM Comoros|KN Saint Kitts and Nevis|KR South Korea|KW Kuwait|KZ Kazakhstan|LA Laos|LB Lebanon|LC Saint Lucia|LI Liechtenstein|LK Sri Lanka|LR Liberia|LS Lesotho|LT Lithuania|LU Luxembourg|LV Latvia|LY Libya|MA Morocco|MC Monaco|MD Moldova|ME Montenegro|MG Madagascar|MK North Macedonia|ML Mali|MM Myanmar|MN Mongolia|MO Macao|MR Mauritania|MT Malta|MU Mauritius|MV Maldives|MW Malawi|MX Mexico|MY Malaysia|MZ Mozambique|NA Namibia|NE Niger|NG Nigeria|NI Nicaragua|NL Netherlands|NO Norway|NP Nepal|NZ New Zealand|OM Oman|PA Panama|PE Peru|PG Papua New Guinea|PH Philippines|PK Pakistan|PL Poland|PT Portugal|PY Paraguay|QA Qatar|RO Romania|RS Serbia|RU Russia|RW Rwanda|SA Saudi Arabia|SC Seychelles|SD Sudan|SE Sweden|SG Singapore|SI Slovenia|SK Slovakia|SL Sierra Leone|SM San Marino|SN Senegal|SO Somalia|SR Suriname|SV El Salvador|SY Syria|SZ Eswatini|TD Chad|TG Togo|TH Thailand|TJ Tajikistan|TL Timor-Leste|TM Turkmenistan|TN Tunisia|TR Türkiye|TT Trinidad and Tobago|TW Taiwan|TZ Tanzania|UA Ukraine|UG Uganda|US United States|UY Uruguay|UZ Uzbekistan|VE Venezuela|VN Vietnam|YE Yemen|ZA South Africa|ZM Zambia|ZW Zimbabwe";

/** ISO 3166-1 alpha-2 codes and names. */
export const COUNTRY_NAMES: Readonly<Record<string, string>> = Object.fromEntries(COUNTRY_LIST.split('|').map((x) => [x.slice(0, 2), x.slice(3)]));

export function countryName(code: string): string {
  return COUNTRY_NAMES[code.toUpperCase()] ?? code.toUpperCase();
}

export function isCountryCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(COUNTRY_NAMES, code);
}

/** EU member states (27). */
export const EU_MEMBER_STATES: readonly string[] = [
  'AT',
  'BE',
  'BG',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'HU',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
];
const EU = new Set(EU_MEMBER_STATES);

export type CrossBorderKind = 'INVOICE' | 'CREDIT_NOTE' | 'BILL' | 'VENDOR_CREDIT';

export interface CrossBorderDocument {
  id: string;
  kind: CrossBorderKind;
  number: string | null;
  issueDate: string;
  contactId: string;
  contactName: string;
  contactCountry: string | null;
  contactTaxId: string | null;
  currency: string;
  /** Before tax and tax, in the books' currency, as positive amounts. */
  netLocal: string;
  taxLocal: string;
  reverseCharge: boolean;
  /** India: place of supply 96 means a supply to or from outside India. */
  placeOfSupply: string | null;
}

export type CrossBorderCheckKind = 'EXPORT_TAXED' | 'IMPORT_NO_REVERSE_CHARGE' | 'INTRA_EU_NO_VAT_ID' | 'COUNTRY_MISSING';

export const CROSS_BORDER_CHECK_LABEL: Readonly<Record<CrossBorderCheckKind, string>> = {
  EXPORT_TAXED: 'Tax charged on a sale abroad',
  IMPORT_NO_REVERSE_CHARGE: 'Purchase from abroad without the reverse charge',
  INTRA_EU_NO_VAT_ID: "Intra-EU supply without the customer's VAT ID",
  COUNTRY_MISSING: 'Foreign document whose contact has no country',
};

export interface CrossBorderCheck {
  kind: CrossBorderCheckKind;
  label: string;
  message: string;
  documentId: string;
  documentKind: CrossBorderKind;
  number: string | null;
  issueDate: string;
  contactId: string;
  contactName: string;
}

const sideOf = (k: CrossBorderKind) => (k === 'INVOICE' || k === 'CREDIT_NOTE' ? 'SALES' : 'PURCHASES');
const signOf = (k: CrossBorderKind) => (k === 'CREDIT_NOTE' || k === 'VENDOR_CREDIT' ? -1 : 1);

export function crossBorderReport(input: { orgCountry: string; documents: CrossBorderDocument[]; functionalCurrency: string }) {
  const home = input.orgCountry.toUpperCase();
  const homeInEu = EU.has(home);
  type Sums = { net: InstanceType<typeof D>; tax: InstanceType<typeof D>; documents: number };
  const zero = (): Sums => ({ net: new D(0), tax: new D(0), documents: 0 });
  const countries = new Map<string, { sales: Sums; purchases: Sums; currencies: Set<string> }>();
  const ecsl = new Map<string, { contactId: string; contactName: string; country: string; vatId: string | null; net: InstanceType<typeof D>; documents: number }>();
  const checks: CrossBorderCheck[] = [];
  const totals = { sales: zero(), purchases: zero(), reverseCharge: zero() };
  const add = (s: Sums, d: CrossBorderDocument) => {
    const sign = signOf(d.kind);
    s.net = s.net.plus(new D(d.netLocal).times(sign));
    s.tax = s.tax.plus(new D(d.taxLocal).times(sign));
    s.documents++;
  };
  const check = (kind: CrossBorderCheckKind, d: CrossBorderDocument, message: string) =>
    checks.push({
      kind,
      label: CROSS_BORDER_CHECK_LABEL[kind],
      message,
      documentId: d.id,
      documentKind: d.kind,
      number: d.number,
      issueDate: d.issueDate,
      contactId: d.contactId,
      contactName: d.contactName,
    });

  let considered = 0;
  for (const d of input.documents) {
    const country = d.contactCountry?.toUpperCase() ?? null;
    if (!country) {
      const abroad = d.placeOfSupply === '96' || d.currency !== input.functionalCurrency;
      if (abroad)
        check(
          'COUNTRY_MISSING',
          d,
          d.placeOfSupply === '96'
            ? 'The place of supply is outside India but the contact has no country: add it so the document is reported under its country.'
            : `The document is in ${d.currency} but the contact has no country: add it if the contact is abroad.`,
        );
      continue;
    }
    if (country === home) continue;
    considered++;
    const side = sideOf(d.kind);
    const row = countries.get(country) ?? { sales: zero(), purchases: zero(), currencies: new Set<string>() };
    countries.set(country, row);
    row.currencies.add(d.currency);
    const taxed = !new D(d.taxLocal).isZero();
    if (side === 'SALES') {
      add(row.sales, d);
      add(totals.sales, d);
      const intraEu = homeInEu && EU.has(country);
      if (intraEu && !taxed) {
        const key = d.contactId;
        const e = ecsl.get(key) ?? { contactId: d.contactId, contactName: d.contactName, country, vatId: d.contactTaxId?.trim() || null, net: new D(0), documents: 0 };
        e.net = e.net.plus(new D(d.netLocal).times(signOf(d.kind)));
        e.documents++;
        ecsl.set(key, e);
        if (!e.vatId && e.documents === 1)
          check(
            'INTRA_EU_NO_VAT_ID',
            d,
            "A zero-rated supply to a business in another EU state needs the customer's VAT ID on the invoice and on the recapitulative statement; without it the sale is normally taxed at home.",
          );
      }
      if (taxed && signOf(d.kind) === 1)
        check(
          'EXPORT_TAXED',
          d,
          intraEu
            ? `Tax was charged on a sale to ${countryName(country)}. Supplies to businesses in other EU states are usually zero-rated; sales to consumers may fall under the destination rules (OSS). Check the rate.`
            : `Tax was charged on a sale to ${countryName(country)}. Exports of goods and many services to customers abroad are zero-rated or outside the scope; check the rate.`,
        );
    } else {
      add(row.purchases, d);
      add(totals.purchases, d);
      if (d.reverseCharge) add(totals.reverseCharge, d);
      else if (!taxed && signOf(d.kind) === 1)
        check(
          'IMPORT_NO_REVERSE_CHARGE',
          d,
          `Nothing was charged on a purchase from ${countryName(country)} and no reverse charge is recorded on it. Services bought from abroad are usually taxed under the reverse charge (accounted for on your own return); imported goods are usually taxed at the border.`,
        );
    }
  }

  const money = (v: InstanceType<typeof D>) => v.toDecimalPlaces(2).toFixed(2);
  const out = (s: Sums) => ({ net: money(s.net), tax: money(s.tax), documents: s.documents });
  return {
    home,
    homeInEu,
    considered,
    totals: { sales: out(totals.sales), purchases: out(totals.purchases), reverseCharge: out(totals.reverseCharge) },
    byCountry: [...countries.entries()]
      .map(([country, r]) => ({ country, countryName: countryName(country), euMember: EU.has(country), sales: out(r.sales), purchases: out(r.purchases), currencies: [...r.currencies].sort() }))
      .sort((a, b) => new D(b.sales.net).plus(b.purchases.net).cmp(new D(a.sales.net).plus(a.purchases.net)) || a.country.localeCompare(b.country)),
    ecSalesList: homeInEu
      ? [...ecsl.values()]
          .map((e) => ({ contactId: e.contactId, contactName: e.contactName, country: e.country, countryName: countryName(e.country), vatId: e.vatId, net: money(e.net), documents: e.documents }))
          .sort((a, b) => a.country.localeCompare(b.country) || a.contactName.localeCompare(b.contactName))
      : null,
    checks: checks.sort((a, b) => a.issueDate.localeCompare(b.issueDate)),
  };
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function crossBorderCsv(report: ReturnType<typeof crossBorderReport>, currency: string): string {
  const rows = [['Country', 'Code', 'EU', `Sales net (${currency})`, 'Sales tax', 'Sales documents', `Purchases net (${currency})`, 'Purchases tax', 'Purchase documents', 'Currencies']];
  for (const r of report.byCountry)
    rows.push([
      r.countryName,
      r.country,
      r.euMember ? 'Yes' : 'No',
      r.sales.net,
      r.sales.tax,
      String(r.sales.documents),
      r.purchases.net,
      r.purchases.tax,
      String(r.purchases.documents),
      r.currencies.join(' '),
    ]);
  if (report.ecSalesList) {
    rows.push([]);
    rows.push(['Recapitulative statement', 'Country', 'Customer VAT ID', `Net (${currency})`, 'Documents']);
    for (const e of report.ecSalesList) rows.push([e.contactName, e.country, e.vatId ?? 'MISSING', e.net, String(e.documents)]);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

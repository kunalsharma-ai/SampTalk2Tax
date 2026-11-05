# Languages and regional formats (M8, slice 1)

Each person chooses the language of the interface and how numbers, dates and times are shown to them. Each organisation has a time zone. These are **display choices only**:

* amounts stay exact decimal strings;
* dates stay calendar dates;
* tax and legal behaviour follows the organisation's country and settings, never the interface language.

Tax terms and the names of returns and documents (GST, TDS, GSTR-3B, e-way bill) are written as the law writes them, in every language.

* **Engine:** `packages/accounting-engine/src/locale.ts`.
  * Holds the lists of languages, number formats, date formats and common time zones.
  * Formats exact decimal strings (`displayMoney`, `displayNumber`), dates (`displayDate`) and moments (`displayDateTime`).
  * Also has `timeZoneLabel`, `isTimeZone` and `checkPreferences`.
* **API:**
  * `GET /v1/auth/me` returns `preferences`.
  * `PUT /v1/auth/me/preferences` saves them.
  * `PUT /v1/orgs/:orgId/time-zone` sets the organisation's zone.
* **Web:**
  * `lib/i18n.tsx` holds the translation layer and the provider. `lib/messages/hi.ts` is the Hindi catalogue.
  * `lib/format.ts` holds the shared formatters, which follow the preferences.
  * **Account and preferences** (the "Account" link in the header) has the **Language and formats** card and the **Organisation time zone** card.

## Choices

| Choice | Options | Default |
|---|---|---|
| Language | English, हिन्दी (Hindi) | English |
| Number format | Follow the currency (Indian grouping for INR, international otherwise); Indian 12,34,567.89; international 1,234,567.89; European 1.234.567,89; spaces 1 234 567,89 | Follow the currency |
| Date format | 06 Nov 2026; 06/11/2026; 11/06/2026; 2026-11-06. Month names follow the language. | 06 Nov 2026 |
| My time zone | The organisation's, or any IANA zone (common ones are listed) | The organisation's |
| Organisation time zone | Any IANA zone; owners and admins change it (`org.manage`) | Asia/Kolkata |

* **Where the choices apply.** Amounts, dates and moments shown through the shared formatters (`Money`, `money`, `date`, `dateTime`) follow the choices, which covers most of the app. The page previews a sample amount, date and time before saving.
* **Saving** redraws the app in the new language and formats.
* **Time zones.** A time zone changes how *moments* are shown: when something was created, signed, sent or checked. **Business dates** stay in India time for every organisation for now: "today", due dates, overdue counts and periods.

## How translation works

* **English text is the key.** A catalogue maps English text to another language.
* **Missing text falls back to English.** Any text a catalogue lacks is shown in English, so a page is never blank or broken by a missing translation.
* **Placeholders** such as `{zone}` are filled in after translating.
* **Language and direction.** The page's `lang` and `dir` attributes follow the language. Direction comes from the language's metadata, so a right-to-left language can be added later.
* **Adding a language** takes three changes:
  1. a catalogue in `apps/web/src/lib/messages/`;
  2. its code in the engine's `LANGUAGES`;
  3. its code in the `users_language_check` constraint.

## What is translated

The Hindi catalogue covers:

* the navigation;
* the header (organisation, account, sign out);
* role names;
* the **Account and preferences** page.

Other pages are still in English. The Hindi has **not yet been reviewed by a professional translator**.

## Database

* **`users`:** `language`, `number_format`, `date_format` and `time_zone` (null means the organisation's zone), each with a CHECK constraint.
* **`organizations`:** `time_zone`, default `Asia/Kolkata`, with a CHECK constraint.
* **Audit:** changing the organisation's zone is audited as `org.time_zone_changed`, with before and after. A person's own display preferences are not audited, because they change nothing anyone else sees.

## Not supported yet (do not rely on these)

* **Hindi coverage:** Hindi covers the shell and the preferences page only; page content is in English.
* **No other languages.** No language other than English and Hindi, and no right-to-left layout.
* **Business dates** ("today", due dates, periods) are in India time for every organisation; only the display of moments follows the time zone.
* **Not every format follows the choices.** A few pages format some values themselves:
  * the alert dialog's times;
  * some chart axes;
  * printed and PDF documents, which use the invoice template's own date style.
* **Server output is not translated:** emails, exports and AI answers.

## Tests

* `packages/accounting-engine/test/locale.test.ts` (4 tests):
  * every number format, with 17 significant digits kept;
  * every date format, in English and Hindi;
  * moments across midnight in different zones;
  * refused time zones and preferences.
* `apps/api/test/display-preferences.e2e.test.ts` (4 tests):
  * defaults;
  * saving for oneself only;
  * refused values at the API and in the database;
  * sign-in required;
  * the organisation zone's permission, check and audit.
* `apps/web/test/format.test.ts` and `apps/web/test/i18n.test.ts` (4 tests here):
  * the formatters follow the person's choices and zone over the organisation's;
  * every navigation label has Hindi;
  * no two labels share a translation;
  * placeholders are kept.
* `apps/web/e2e/display-preferences-flow.test.mjs` (1 test), in the browser:
  * switching to Hindi with international numbers, ISO dates and London time;
  * the navigation, header and invoice list changing;
  * the organisation zone being set;
  * switching back to English.

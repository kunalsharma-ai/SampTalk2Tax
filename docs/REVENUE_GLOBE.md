# Revenue globe (DASH-025)

Reports → **Revenue globe** shows where sales revenue comes from as bubbles on a globe. There is one bubble per country, and one per state in the organisation's own country. A bubble's area is in proportion to the revenue earned there.

## What it shows

- **From month** and **To month** choose up to 24 months; the default is the last 12.
- The summary gives the sales revenue, the share earned abroad, the number of places, countries and customers, and the largest place.
- Drag the globe to turn it, or focus it and use the arrow keys (Shift for bigger steps). Bubbles on the far side are hidden.
- **Zoom to home country** turns to the organisation's own country and zooms in, with a finer grid, so its states can be told apart. **Whole world** zooms back out.
- **Play months** shows one month at a time. The **Choose a month** slider picks one month, and **All months** adds them up again.
- The **Revenue by place** table lists every place for the months shown, with its kind, customers, revenue and share. Choosing a place turns the globe to it and picks out its bubble. Places without a known position (a country not in the drawing table, a state code with no centre, or an export whose country is not recorded) are listed in the table only.

Customers are never named, on the globe or in the response.

## How places are worked out

Revenue is the revenue lines of posted invoices and credit notes, in the functional currency, by entry month. Other income accounts and journals that are not invoices are left out, as in customer revenue on the KPI pages. A voided invoice nets to nothing through its void entry.

For each invoice or credit note:

1. **Country.** This is the customer's country. If none is recorded, it is the organisation's own country. An Indian export (place of supply `96`) to a customer without a foreign country goes to "Abroad, country not recorded".
2. **State, at home only.** In India this is the invoice's GST place of supply, else the customer's state. Sales at home without a state go to "India, state not recorded".

`revenueGlobe` in `packages/accounting-engine/src/revenue-globe.ts` adds up the places and works out the shares (four decimals), customers and month totals. Amounts are decimals throughout.

Positions are approximate centres of countries and of Indian states and union territories (`COUNTRY_CENTRES`, `INDIA_STATE_CENTRES`). They are for drawing only and are never used for tax. The globe has a latitude and longitude grid, not coastlines.

## API

`GET /v1/orgs/:orgId/reports/revenue-globe?from=YYYY-MM&to=YYYY-MM` needs `reports.read`. It returns:

- `places`, each with key, kind (`COUNTRY`, `STATE` or `UNPLACED`), name, latitude and longitude, amount, share, customers and one amount per month;
- `months`, `monthTotals` and `total`;
- `home`, `abroad` and `abroadShare`;
- `countries` and `customers`.

Nothing is stored and no AI model is used.

## Evidence

- `packages/accounting-engine/test/revenue-globe.test.ts`: states at home, countries abroad, credit notes, months outside the range, places without a position, exports without a country, empty books and country names.
- `apps/api/test/revenue-globe.e2e.test.ts`: invoices to Maharashtra, Karnataka and a US customer plus a credit note through the real API and database. It also covers drafts and plain journals left out, no customer names, months checked, reports.read and isolation.
- `apps/web/test/globe.test.ts`: the projection, hidden far side, zoom, grid and bubble sizes.
- `apps/web/e2e/revenue-globe-flow.test.mjs`: the menu link, the summary and table, turning with the keyboard, zooming to India, picking a state, playing and pausing, and All months.

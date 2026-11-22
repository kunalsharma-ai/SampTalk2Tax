# Bank cash forecast (BANK-022)

Banking → Bank cash forecast shows each bank account's balance week by week for the next 30, 60
or 90 days, from what its imported statements show. It complements the Cash-flow forecast under
Planning, which works from open invoices, bills and planned items. Nothing changes the books and no
AI model is used; the logic is in `packages/accounting-engine/src/cash-movements.ts`, and the API is
`GET /v1/orgs/:orgId/banking/cash-movements?accountId=&days=30|60|90` (banking permission).

Statement lines of the year before are used; excluded lines are left out. Without an account, every
active bank account with imported statements is forecast.

## Repeating movements

Lines with the same narration (case, numbers and punctuation ignored, so "RENT 06" and "RENT 07"
are one) and the same direction count as one movement when there are at least 3 of them, every 5 to
9 days (weekly), 25 to 35 (monthly) or 85 to 97 (quarterly), each within 25% of their median amount.

A movement still runs while its last line is no older than one and a half of its periods; one that
stopped is listed but not projected. A running one is projected from its last line at its median
amount: weekly every 7 days, monthly and quarterly on the same day of the month. An occurrence that
is due but not on a statement yet is put on the first day of the forecast.

## Everything else

The other lines of the last 13 weeks are summed week by week. Each week ahead adds the average week
of money in and money out; a part week at the end takes its share. The range adds the 25th and 75th
percentile week instead, or the average week when it lies outside them. The range shows how the
weeks have varied; it is not a statistical confidence interval. With less than 13 weeks of
statements the page says the other movements are a rough guide.

## Balance

The forecast starts from the account's balance in the books today and shows, for each week, the
repeating money in and out, the other money in and out, the balance at the end of the week and the
range, with the end balance and the lowest week-end balance ahead.

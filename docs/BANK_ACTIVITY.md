# Unusual bank activity (BANK-019, BANK-023)

Banking → Unusual bank activity lists lines on imported bank statements that carry warning signs,
and the alert check **Unusual bank activity** (`UNUSUAL_BANK_ACTIVITY`, Alerts → Settings) raises an
alert for each serious or medium one. Statement lines show every movement on the account, including
ones nobody has booked, which is why the checks run on them. Talk2Tax has no live bank feed, so the
checks are only as fresh as the latest imported statement. Nothing changes the books and no AI model
is used; the logic is in `packages/accounting-engine/src/bank-activity.ts`.

Each line in the period (30 days on the page by default) is compared with the year before on the
same account. Excluded lines are left out.

| Sign | Level | Raised when |
| --- | --- | --- |
| Possible duplicate | High | Another line with the same amount and narration (ignoring numbers and punctuation) within 3 days |
| Just under the threshold | High | One of 3 or more movements the same way within 7 days, each between 90% and 100% of the threshold (50,000 unless set) |
| Straight in and out | High | Money out within 2 days of a credit of 1 lakh or more, at 95% to 100% of it |
| Unusually large | Medium | Over 3 times the largest movement the same way in the 90 days before, with at least 5 to compare |
| Large payment to a new payee | Medium | 1 lakh or more out to a narration not seen on the account in the 180 days before, with at least 10 lines to compare |
| Not in the books | Medium | Money out more than 14 days ago still not matched |
| Large round amount | Low | 1 lakh or more in whole thousands |

A line takes the level of its most serious sign. Lines are listed most serious first, then newest.

## Alerts

The check looks back 14 days by default (7 to 90) and uses the same threshold setting (50,000 by
default). High lines raise critical alerts and medium lines warnings; low lines raise none. An
alert clears by itself once its line no longer shows a serious or medium sign, for example after it
is matched or excluded with a reason.

## API

`GET /v1/orgs/:orgId/banking/unusual-activity?days=30&threshold=50000` (needs `banking.read`; days 7
to 365): `summary` (lines, by level, accounts, by sign) and `items`, each with the account, date,
amount, narration, reference, whether it is matched, its level and its signs with the detail each
was raised on.

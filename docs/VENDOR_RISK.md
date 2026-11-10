# Vendor risk monitoring (AP-024)

Each active vendor's risk, worked out from what the books already hold, with people's reviews of
it. Nothing is scored by an AI model, and no outside credit, sanctions or news data is bought in;
every factor says what it was raised on.

Where: **Purchases → Vendor risk** (the register: vendors waiting for a review first, or every
medium/high risk, or all) and the **Vendor risk** card on each vendor's page. The **Vendor risk
needs a review** check in **Alerts** raises the same vendors.

## Factors

| Factor | Level | Raised when |
| --- | --- | --- |
| Bank account shared with another vendor | High | Another active vendor has the same account number and IFSC (or SWIFT), ignoring spaces and dashes. |
| Bank details changed and not verified | High with money owed, else Medium | The bank details changed in the last 30 days and nobody has verified them (verification is AP-027, by someone other than who changed them). |
| Bank details not verified | Medium | Money is owed and the bank details have never been verified. |
| Bank details changed recently | Low | Changed in the last 30 days and verified since. |
| Tax problems | High or Medium | Supplier tax checks (AP-019) found a serious or medium problem. |
| Performance grade | Medium (D), Low (C) | The vendor performance grade (AP-021) for the last twelve months. |
| Large share of purchases | Medium | 25% or more of posted bills (before tax, functional currency) in the last twelve months. |
| New vendor with large purchases | Medium | Added in the last 90 days and already 10% or more of purchases. |
| Onboarding not approved | Medium | Vendor onboarding (AP-002) is required, the vendor's is not approved, and they are being billed. |
| Paying late | Low | Bills more than 60 days past due are still open. |

The vendor's level is its worst factor. The rules and thresholds are in
`packages/accounting-engine/src/vendor-risk.ts` and are unit tested.

## Reviews

A medium or high risk waits for a review. Someone with `purchases.manage` records one: the decision
(risk accepted, keep buying; keep buying, watch closely; stop new orders), a note of at least five
characters, the review date (not in the future) and when to look again (after the review and within
365 days; suggested 30 days for high, 90 for medium, 180 for low). The level and factors at the
time are stored with it.

Another review is asked for when a factor appears that the last review did not see, the level rises
to medium or high above what was reviewed, or the next review date comes.

Reviews are kept as recorded: a database trigger refuses any update or delete, and each is written
to the audit trail (`vendor_risk.reviewed`).

"Stop new orders" is a recorded decision; it does not yet block purchase orders or bills.

## Alert

The `VENDOR_RISK` alert check runs with the other checks. It opens one alert per vendor waiting for
a review: critical for high risk, warning for medium, information for a low risk whose review date
came. It clears on the next run after a review is recorded.

## API

- `GET /v1/orgs/:orgId/purchases/vendor-risk` (purchases.read): the register.
- `GET /v1/orgs/:orgId/purchases/vendor-risk/:contactId` (purchases.read): one vendor, with every review.
- `POST /v1/orgs/:orgId/purchases/vendor-risk/:contactId/reviews` (purchases.manage): record a review.

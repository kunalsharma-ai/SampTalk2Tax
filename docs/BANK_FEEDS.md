# Bank feeds (BANK-004)

A bank feed lets something outside Talk2Tax send one bank account's transactions as they happen:
a bank's host-to-host channel, an account aggregator partner, a treasury system or a script.
Talk2Tax has no built-in connection to any particular bank or aggregator; the sender posts to the
feed with a secret token. Lines arrive unmatched on the account and are matched and reconciled
like an imported statement.

## Setting one up

Banking → Bank feeds. Owners and admins (`org.manage`) set up a feed for a bank account, name the
sender, choose what it sends and how often something is expected (every hour to every week). The
token (`t2tf_` and 40 characters) is shown once; only its SHA-256 is stored, and the audit trail
names it by its first 8 characters. An account has at most one live (active or paused) feed, so
two feeds never add the same money.

| Action | Who |
| --- | --- |
| See feeds and deliveries | `banking.read` |
| Rename, change the expected interval, pause, resume | `banking.manage` |
| Set up, replace the token, disconnect | `org.manage` (owners, admins) |

Replacing the token stops the old one at once. Disconnecting is for good: the token stops working,
the lines already added stay, and the account can have a new feed.

## What the sender posts

On the app's own address (forwarded to the API's `/v1/bank-feed/...`), with
`Authorization: Bearer t2tf_...`:

* `GET /api/bank-feed/me`: checks the token; returns the organisation, account and feed state.
* `POST /api/bank-feed/transactions` (feeds of kind TRANSACTIONS): `{"transactions": [...]}`, 1 to
  1,000 at a time. Each has `id` (the sender's own, up to 100 characters), `date` (YYYY-MM-DD, not
  after tomorrow), `amount` as a string (signed, negative is money out; or unsigned with
  `direction` CREDIT or DEBIT), `description`, optional `reference` and `currency` (must be the
  account's). JSON numbers are refused for amounts, since they can lose pennies.
* `POST /api/bank-feed/statement` (feeds of kind STATEMENT_FILE): `{"fileName": "...", "content": "..."}`
  holding an OFX, QIF or MT940 file under 2 MB.

## Never twice, and what is refused

* A transaction whose id was already sent on the account is skipped as already there.
* Statement-file lines are keyed like uploaded files (date, amount, narration, reference and how
  many times that repeats), so a file sent twice, or a file already uploaded by hand, adds nothing.
* A line dated on or before the account's last completed reconciliation is refused: the sender
  cannot undo a reconciliation.
* Invalid transactions are refused one by one with their reasons; the rest of the delivery is added.

Every delivery is recorded (received, added, already there, refused with the first 50 reasons, or
why an unreadable file failed). The response to the sender carries the same.

## Health

* **Waiting**: nothing has arrived yet, within the expected interval.
* **Healthy**: something was accepted within the expected interval.
* **Late**: nothing accepted for longer than the expected interval.
* **Failing**: the last delivery was refused or unreadable.
* **Paused** / **Disconnected**: as set.

## Where it lives

* Engine: `packages/accounting-engine/src/bank-feeds.ts` (checking transactions, tokens, outcome, health).
* API: `apps/api/src/bank-feeds/` (connections, deliveries, sender endpoints);
  `BankingService.importFedLines` adds the lines in one transaction with the account locked.
* Collections: `bank_feed_connections`, `bank_feed_deliveries` (migration `20270226100000_bank_feeds`).
  Both are kept as a record; a delivery never changes.
* Web: `/banking/feeds`, `/banking/feeds/[feedId]`; the sender proxy is `apps/web/src/app/api/bank-feed/[action]/route.ts`.
* Tests: `packages/accounting-engine/test/bank-feeds.test.ts`, `apps/api/test/bank-feeds.e2e.test.ts`,
  `apps/web/e2e/bank-feeds-flow.test.mjs`.

No AI model is used.

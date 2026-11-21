# Ledger replay (AUDIT-017)

Governance → Ledger replay shows the books as they stood at a past moment, beside the books now, and lists every entry that explains the difference.

## What you choose

* **Replay moment.** A past date and time. The replay counts only posted entries whose posting time is at or before this moment. It cannot be in the future.
* **Entries dated up to.** A cut-off date. Both sides count only entries dated on or before it, so a later period does not blur the comparison.

## What you see

* **Balances then and now.** For each account that has entries dated up to the cut-off: the balance as it stood at the replay moment, the balance now, and the change. Accounts that changed come first, then the rest by account code. A balance is debits less credits.
* **Summary.** Accounts compared, accounts that changed, and the net change. The net change is the sum of the absolute changes divided by two. Because every entry balances, this is the amount moved by the entries posted since.
* **Entries posted since.** Each posted entry dated up to the cut-off but posted after the replay moment, oldest first: number, date, posting time, who posted it, source, memo, amount, the accounts it touched, and the entry it reverses, if any. Up to 200 are listed; the count shows them all.

## How it works

* Posted entries cannot be changed or deleted, and corrections are made with new entries (reversals or adjustments). So the posting time on each entry is enough to rebuild the ledger at any past moment exactly. No snapshots are kept.
* Money is summed as decimals, never as floating point.
* The replay only reads. Each replay is recorded in the audit log (`ledger.replayed`) with the moment, the cut-off and the number of entries posted since.
* Needs the `audit.read` permission.

## API

`GET /orgs/:orgId/ledger-replay?asOf=<ISO date-time with offset>&through=<YYYY-MM-DD>`

A bad or future moment, or a bad date, returns `422 INVALID_REPLAY`.

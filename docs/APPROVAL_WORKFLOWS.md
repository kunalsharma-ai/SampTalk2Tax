# Approval workflows (WFLOW-006)

Drafts that need someone's approval before they post, how many approvals, and what happens
when nobody decides.

## What needs approval

| Record | Rule | Where |
|---|---|---|
| Invoices, credit notes, bills, vendor credits | By type, from an amount (functional currency, tax included) | Settings → Approval rules |
| Manual journals | From an amount ([JOURNAL_APPROVALS.md](JOURNAL_APPROVALS.md)) | Settings → Approval rules |
| Expense claims | Every submitted claim | Expenses |

## Two-level approvals (documents)

A document rule can set **Two approvals from**: at or above that total, two different people
must approve, one after the other. The rule can require the second approval to come from an
owner or admin. How many approvals a request needs is fixed when it is submitted.

- The first approval is recorded with its note (`approval.first_approved` in the audit trail);
  the request stays pending and the document cannot post.
- The same person cannot give both approvals. With *someone other than the preparer* on, the
  preparer and submitter cannot give either.
- The second approval completes the request (`approval.approved`) and can post the document.
- A rejection at either step ends the request; editing the draft cancels it.

The database guards hold the same rules for any writer: approvals only accumulate, from
different people, while the request is pending, and a two-approval request cannot become
approved with fewer than two.

## Escalation

The alert check **Approval waiting too long** (`APPROVAL_WAITING`, Alerts → Settings) raises an
alert for a document or manual journal request pending longer than the set days (3 by
default), critical after three times as long. Alerts reach the people set in alert
notifications (owners, by default). The alert clears when the request is decided or withdrawn.

## Not covered

Chains longer than two steps, approvers named per rule (any Approver, Admin or Owner may
approve), delegation, and approvals for payments.

# Locations and financial tags (GL-028, GL-031)

Besides departments and projects, a journal line can carry **financial tags**: a key such as
`location` and a value code such as `PUNE`. The organisation defines the tags it reports by and
their values, picks them on journal lines, and splits the profit and loss by any of them.

**Accounting → Locations and tags** (`/v1/orgs/:orgId/financial-tags`). `accounts.read` sees the
tags; `accounts.manage` adds and changes them. Every change is audited (`financial_tag.created`,
`financial_tag.updated`).

## A tag

* Key: lower case letters, digits and `_`, starting with a letter (up to 32), unique in the
  organisation. It is what lines store, so it never changes.
* Name: what people see, such as Location or Site (up to 60 characters). It can be renamed.
* Values: a code (capital letters, digits, `-` and `_`, up to 20; typed codes are upper-cased)
  and a name. Codes are unique within the tag.
* Presets: Location, Business unit, Profit centre and Sales channel. Any other tag can be named.

Values are **switched off, never removed**, and a tag is never deleted (only switched off), so
lines tagged in the past keep a readable name in reports. The database guards refuse a change of
key, a removed value and a delete.

## Lines

Journal lines send tags in `dimensions` (`{ "location": "PUNE" }`), as before. When a key is a
defined tag, the value must be one of its values that is in use, and the tag itself must be in
use; otherwise the journal is refused with 422 `INVALID_TAG` and the issues, such as
`Line 2: DEL is not a Location` or `Line 1: Site MUM is inactive`. Keys nobody defined stay free
text, as they were. Reversals and reposts keep the tags already accepted.

The journal form shows a picker per tag in use under each line's account, and the journal page
shows the value names on each line.

## Profit by tag

`GET /v1/orgs/:orgId/reports/profit-by-tag?key=location&from=…&to=…` (`reports.read`), also a tab
per tag on **Reports → Profit by department, project or tag**:

* Posted entries in the period, closing entries left out, revenue and expense accounts only.
* One column per value with postings (defined values in their order, then codes nobody defined),
  then **Not tagged** for lines without the tag, so the columns add up to the profit and loss.
* Per account and per column, plus revenue, expenses and net profit per column and in total.

## Storage

MongoDB collection `financial_tags` (`orgId`, `key`, `label`, `isActive`, `values[]`), unique on
`orgId + key`, migration `20261225100000_financial_tags`. Rules in
`packages/accounting-engine/src/financial-tags.ts` (`financialTagIssues`, `lineTagIssues`).

## Not yet

* Tags on invoice and bill lines (journals only for now), budgets by tag, and an export of the
  profit-by-tag report.

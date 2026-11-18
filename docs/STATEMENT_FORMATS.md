# Bank statement file formats (BANK-003)

**Banking → an account → Import a statement** takes CSV, OFX/QFX, QIF and MT940 files. The
format is recognised from the file's content; only CSV needs its columns mapped.

| Format | Read from | Notes |
|---|---|---|
| CSV | Mapped columns: date, description, reference, amount (one column or money in/out), running balance | Five date formats; comma, semicolon or tab |
| OFX / QFX | `<STMTTRN>`: `DTPOSTED`, `TRNAMT`, `NAME` + `MEMO`, `CHECKNUM`/`REFNUM`/`FITID` | OFX 1.x (SGML) and 2.x (XML); closing balance from `LEDGERBAL` |
| QIF | `D` date, `T`/`U` amount, `P` payee + `M` memo, `N` number | Day-first or month-first dates, chosen on screen; 2-digit years and `'` separators; split lines ignored |
| MT940 | `:61:` lines with their `:86:` details; `:60F:` opening and `:62F:` closing balance | `RC`/`RD` reversals; when opening plus the lines is not the closing balance the preview says so |

Every format goes through the same import: duplicates are skipped by fingerprint, lines on or
before the last completed reconciliation are refused, and lines are matched the same way.
API: `POST /v1/orgs/:orgId/banking/accounts/:accountId/imports` with `format` (`CSV` by
default), the file text in `csv`, `mapping` for CSV and `dateFormat` for QIF. A file that is not
the format named is refused.

Not covered: PDF statements, CAMT.053 XML and Excel files (save as CSV).

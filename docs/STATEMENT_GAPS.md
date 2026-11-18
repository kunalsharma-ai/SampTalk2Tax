# Missing statement lines (BANK-021)

When a bank statement file has a running balance column, Talk2Tax checks every line against
it on import: each line's balance must equal the balance before it plus the line's amount.

- **Where it breaks**, lines are missing from the file (or the bank listed one twice) between
  the two rows. The preview names both rows and dates, the balance it expected, the balance
  the statement shows and the gap: the money that came in or went out without a line.
- Banks list lines oldest first or newest first; the order in which the balances follow with
  fewer breaks is used.
- The check needs two or more lines with a balance. Lines without a balance are skipped.
- Each line's balance is stored with it (`bank_statement_lines.balance`), and the breaks are
  kept with the import (`bank_statement_imports.balanceBreaks`, shown by
  `GET /v1/orgs/:orgId/banking/accounts/:accountId/imports`). The import still goes ahead,
  so the lines that are there can be matched; fetch the missing ones from the bank or add them
  by hand.

Without a balance column, a missing or doubled line still shows at reconciliation, where the
imported lines do not add up to the statement balance.

Not covered: gaps between two separate files (only lines within a file are chained).

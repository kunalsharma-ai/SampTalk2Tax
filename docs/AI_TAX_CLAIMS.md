# AI never invents tax rates or legal requirements (TAX-054)

The AI copilot explains and assists. It must not present a tax rate, threshold, section, rule or
legal requirement that Talk2Tax did not give it as if it were fact.

## What Talk2Tax does

1. **Instructions.** The copilot's instructions say: never state a tax rate, threshold, section,
   rule or legal requirement from memory, only ones a tool result in the conversation shows. When a
   question needs one the tools do not give, the copilot says Talk2Tax does not hold it and suggests
   the adviser.
2. **A check on every answer.** After the model answers, `checkTaxClaims`
   (`packages/tax-engine/src/ai-tax-claims.ts`) finds:
   - every percentage in a sentence about tax (GST, TDS, TCS, VAT, cess, duty, rate, slab and so on),
     and
   - every legal reference written as "section", "sec.", "u/s", "rule" or "article" followed by a code
     such as 194Q or 40A(3).

   A rate is supported when the same number appears in what the model was given in that conversation
   (the questions and every tool result, after redaction) or in the organisation's own tax rates. A
   reference is supported when the same code appears in what the model was given, as a whole code.
3. **What the member sees.** Unsupported claims are stored on the answer (`safety.taxClaims`) and
   shown under it as "Check these tax details": each claim, whether it is a rate or a legal
   reference, and the sentence it came from, with a note to confirm it with a tax adviser.
4. **Audit.** The `copilot.answered` audit event records how many claims were unsupported.

## Limits

- The check is a text match. It shows a claim was not found in Talk2Tax; it cannot tell whether a
  rate that was found is the right rate for the situation.
- It errs towards flagging: a rate the member typed into the question counts as given, but a rate
  written in words ("eighteen per cent") or a reference without the words above is not found.
- Thresholds written as amounts are not checked as rates; the instructions cover them.

## Tests

- `packages/tax-engine/test/ai-tax-claims.test.ts`: the check itself.
- `apps/api/test/ai-data-safety.e2e.test.ts`: a scripted model answers with an own rate, an unknown
  rate and an unknown section; only the last two are flagged and audited.
- `apps/web/e2e/ai-tax-claims-flow.test.mjs`: the warning under the answer in the browser.

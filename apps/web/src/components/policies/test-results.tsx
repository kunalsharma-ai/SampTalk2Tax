'use client';
import { Badge, Table, Td, Th, Tr } from '@talk2tax/ui';
import type { Backtest, TestResult } from '@/lib/policies';
import { dateTime } from '@/lib/format';

const word = (e: TestResult['expect'] | null) => (e === 'ACTS' ? 'Acts' : e === 'DOES_NOT_ACT' ? 'Does not act' : '—');

/** Each test with what it expected, what the rule did, and every condition's actual value. */
export function TestResults({ results }: { results: TestResult[] }) {
  if (!results.length) return <p className="px-5 pb-5 text-sm text-fg-muted">No tests yet. Add a few cases the rules should and should not act on; a policy can only be approved when every test passes.</p>;
  const passed = results.filter((r) => r.passed).length;
  return (
    <>
      <p className="px-5 pb-3 text-sm" data-testid="test-summary">
        {passed === results.length ? `All ${results.length} test${results.length === 1 ? '' : 's'} pass.` : `${results.length - passed} of ${results.length} tests fail.`}
      </p>
      <Table aria-label="Test results">
        <thead>
          <tr>
            <Th>Test</Th>
            <Th>Rule</Th>
            <Th>Expected</Th>
            <Th>Rule did</Th>
            <Th>Conditions</Th>
            <Th>Result</Th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <Tr key={r.index}>
              <Td>
                <span className="font-medium">{r.index}. {r.label}</span>
              </Td>
              <Td>Rule {r.rule}</Td>
              <Td>{word(r.expect)}</Td>
              <Td>{word(r.actual)}</Td>
              <Td>
                {r.problem ? (
                  <span className="text-sm text-negative">{r.problem}</span>
                ) : r.conditions.length ? (
                  <ul className="text-xs">
                    {r.conditions.map((c, i) => (
                      <li key={i} className={c.passed ? 'text-positive' : 'text-fg-muted'}>
                        {c.passed ? '✓' : '✗'} {c.label} <span className="text-fg-muted">(is {c.actual ?? 'empty'})</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="text-xs text-fg-muted">No conditions: acts every time</span>
                )}
              </Td>
              <Td>
                <Badge tone={r.passed ? 'positive' : 'negative'}>{r.passed ? 'Pass' : 'Fail'}</Badge>
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}

/** What each rule would have done over the last days of real events. */
export function BacktestResults({ b, ruleNames }: { b: Backtest; ruleNames: string[] }) {
  return (
    <div className="flex flex-col gap-3 px-5 pb-5" data-testid="backtest">
      {b.rules.map((r) => (
        <div key={r.rule} className="rounded-[var(--t2t-radius-md)] border border-line p-3">
          <p className="text-sm font-medium">
            Rule {r.rule}: {ruleNames[r.rule - 1] || 'Untitled'}
          </p>
          {!r.supported ? (
            <p className="text-sm text-fg-muted">{r.note}</p>
          ) : (
            <>
              <p className="text-sm">
                Would have acted on <strong>{r.acted}</strong> of {r.checked} event{r.checked === 1 ? '' : 's'} in the last {b.days} days.
              </p>
              {r.examples.length ? (
                <ul className="mt-1 text-xs text-fg-muted">
                  {r.examples.map((e, i) => (
                    <li key={i}>
                      {e.label}, {dateTime(e.at)}
                      {e.facts.total ? ` · total ${e.facts.total}` : ''}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

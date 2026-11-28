# Accessible, interactive and fast visuals (DASH-008, DASH-009, DASH-010, DASH-041)

The dashboards and visuals are held to four checks, each backed by a test that runs in CI.

## Accessible (DASH-009)

`apps/web/e2e/visual-accessibility.test.mjs` opens the visual screens with a month of real books, in light and dark colours:

- Financial visuals, Financial landscape, Revenue globe, Cash-flow network, Financial timeline and Risk monitor.

On each screen it checks the following:

- **axe-core** finds no serious or critical WCAG 2.1 A or AA violation.
- **Every chart has a name that says where its figures are** ("… in the table below"), and the screen has that table. A chart is never the only way to read a number.
- **A chart that holds controls is a group, not an image.** The cash-flow network's nodes and the timeline's clickable bars sit inside an element with `role="group"` and `aria-roledescription="chart"`. An image cannot contain controls, which was a nested-interactive violation.
- **Visible words start the accessible name.** A cell button in the landscape table reads "6200 Rent, Nov 26: ₹30,000.00". A network node reads its label as shown, with the full name as its description when the label is shortened.

The app-wide audit, `apps/web/e2e/accessibility.test.mjs` (QA-018), covers 23 other screens, at phone width too.

What the visual test found and fixed:

- The landscape table's buttons were named without their amount.
- The cash-flow network and the financial timeline were images holding controls.
- A shortened node label did not match its name.
- The overall risk gauge did not say where its figures were.

## Interactive (DASH-010)

Every interactive picture can be reached and worked with the keyboard, with visible focus:

- the financial landscape and the revenue globe turn with the arrow keys (Shift for bigger steps);
- the cash-flow network's nodes are buttons;
- every chart's figures are in a table, and the table's buttons pick out the same item in the picture.

The visual test turns the landscape and the globe by keyboard and checks that the drawing changes. Each screen's own browser test covers its interactions: playing months, choosing a month or a place, and opening the ledger.

## Respects reduced motion (DASH-041)

See [MOTION.md](MOTION.md). On a device that asks for reduced motion, the visual test checks that no animation keeps looping on any of these screens. `apps/web/e2e/motion-flow.test.mjs` checks the person's own choice both ways.

## Fast (DASH-008)

Opening the dashboard until its balances and monthly chart show has a budget of 2 seconds at the 95th percentile (PERF-015, `perf/budgets.json`), measured by `apps/web/e2e/dashboard-performance.test.mjs` in CI. The report reads behind the visuals have their own budgets (PERF-002 and PERF-004), set out in [PERFORMANCE_BUDGETS.md](PERFORMANCE_BUDGETS.md). The visual test does not time pages; it makes no speed claim beyond those budgets.

Automated checks find only part of what makes a screen accessible. A review with a screen reader is still worth doing before a major release.

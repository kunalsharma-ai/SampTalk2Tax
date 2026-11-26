# Scenario surface (DASH-027, DASH-039)

Planning → Digital twin → **Scenario surface** tries two changes together across a range, for example price against payroll. It shows one outcome at every combination as a 3D surface that builds up month by month.

## Using it

1. **Choose what to measure:**
   - net profit so far;
   - EBITDA so far;
   - cash at month end;
   - the lowest cash so far.
2. **Choose the time span:** the months ahead (1 to 24) and the actual months to start from (the last 3, 6 or 12).
3. **Choose the two changes**, one across and one back, each with a range and 3 to 11 points:

   | Change | Allowed range |
   | --- | --- |
   | Price | −50% to +50% |
   | Sales growth | −20% to +20% a month |
   | Customers lost | 0 to 20% a month |
   | Cost of sales | −50% to +50% |
   | Payroll | −50% to +50% |
   | Operating costs | −50% to +50% |
   | Days to collect | −60 to +60 days, whole steps |
   | Days to pay | −60 to +60 days, whole steps |

4. **Draw it.** Every point is a full re-run of the digital twin (`runTwin`), so a 9 × 9 surface is 81 runs. The results are hypothetical: nothing is saved or posted.

The page then shows:

- the value with neither change (when 0 is in both ranges);
- the best and worst points;
- how many points run out of cash in some month;
- the surface itself, coloured green above zero and red below.

You can work the surface in these ways:

- Drag it to turn it, or focus it and use the arrow keys (hold Shift for bigger steps). **View from above** gives a heat-map view and **Reset view** returns to the start.
- Play the months, or move the month slider. Each month shows the measure up to then. All months share one height scale, so the surface visibly rises or falls.
- Choose any value in the **Surface values** table to mark that point on the surface. The table has every value drawn.

## "4D" (DASH-039)

When someone asks for a "4D" view, Talk2Tax gives them this: a 3D surface (two changes and one outcome) that changes over time (the projected months). It is not a claim to render four spatial dimensions. The page and its help say exactly what each axis and each month mean.

## How it is drawn

`apps/web/src/lib/surface-3d.ts` places the grid in a unit cube. It turns the cube (yaw around the vertical, pitch towards the viewer) and projects it straight onto the screen with no perspective. It then paints the cells from far to near. No 3D library is used. The drawing is a labelled image, and the exact figures are always in the table. Turning and playing never animate on their own: playing steps once a second only after you press Play.

## API

`POST /v1/orgs/:orgId/twin/surface` needs `reports.read`. The request body is:

```json
{
  "baselineMonths": 6,
  "horizonMonths": 12,
  "measure": "NET_PROFIT",
  "x": { "axis": "PRICE", "min": -20, "max": 20, "steps": 9 },
  "y": { "axis": "PAYROLL", "min": -20, "max": 20, "steps": 9 },
  "drivers": []
}
```

`drivers` is optional: up to 20 twin changes applied under every point.

The response has:

- the axis values;
- one frame per projected month (`values[y][x]`, with the frame's minimum and maximum);
- the value with no change, and the best and worst points;
- the number of points where cash goes below zero;
- the number of runs.

Problems come back as 422 `SCENARIO_INVALID` with a list of what to fix, for example "Choose two different changes".

## Evidence

- `packages/accounting-engine/test/scenario-surface.test.ts`: axis steps, profit at every point and month, the lowest cash never rising, the no-change point, and the issues in words.
- `apps/api/test/scenario-surface.e2e.test.ts`: the twin baseline from posted journals, values at each point, nothing posted, other changes underneath, 422 and 400 responses, reports.read and isolation.
- `apps/web/test/surface-3d.test.ts`: projection, height, painting order and colours.
- `apps/web/e2e/scenario-surface-flow.test.mjs`: drawing the surface, best and worst points, turning it with the keyboard, the first month, play and pause, marking a value, and the same-change error.

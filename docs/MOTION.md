# Motion and animated transitions (DASH-038)

Talk2Tax animates its transitions and its interactive visuals, and each person chooses how much the interface moves.

## What moves

- **Pages** fade in when you open them, over 0.24 seconds (`.t2t-page-enter` on the page area in `apps/web/src/app/globals.css`). Only opacity changes, so nothing shifts under the pointer.
- **Charts** grow into place: bars, lines, the cash-flow network's moving dashes and widths, and the timeline and risk charts.
- **3D views glide** to where you send them, instead of jumping:
  - Financial landscape: **Reset view** and **View from the front**.
  - Revenue globe: **Zoom to home country**, **Whole world**, and choosing a place in the table.

  The camera eases in and out over 0.6 to 0.7 seconds and turns the short way round (`tween` and `shortestTurn` in `apps/web/src/lib/motion.ts`).
- **The globe coasts.** A globe let go while still being dragged keeps turning at that speed and slows to a stop (`coast`). A new drag, an arrow key or a button stops it.

## Who decides

Account → Language and formats → **Motion**:

| Choice | Effect |
| --- | --- |
| Follow this device (default) | Animates unless the device's reduced-motion setting is on. |
| Animate | Animates even when the device asks for reduced motion. |
| Keep still | Nothing moves. Every change happens at once, and nothing glides, coasts or loops. |

The choice is the person's own. It is saved on their user record, kept across sign-ins and devices, and applies in every organisation. Older clients that do not send it leave it unchanged.

`motionReduced(choice, deviceReduces)` in `packages/accounting-engine/src/locale.ts` decides. The web app writes the answer to `<html data-motion="full|reduced">`, and follows the device setting as it changes. Every animation reads this one attribute:

- The stylesheet ends all animations and transitions at once under `data-motion="reduced"`.
- The device's reduced-motion rules in the design tokens step aside under `data-motion="full"`.
- Chart libraries are told not to animate (`isMotionReduced()`).
- `tween` jumps straight to the end, and `coast` does nothing.

## API

`PUT /v1/auth/me/preferences` takes an optional `motion` of `SYSTEM`, `FULL` or `REDUCED`. Anything else, including null, is refused with 400. `GET /v1/auth/me` returns `preferences.motion`, which is `SYSTEM` when the person has never chosen. The users collection's validator checks the value (migration `20270320100000_motion_preference`).

## Evidence

- `packages/accounting-engine/test/motion.test.ts`: the device is followed unless the person chose otherwise.
- `apps/web/test/motion.test.ts`: easing, the short way round, a glide through frames against a jump when reduced, and coasting that slows and stops (none when reduced).
- `apps/api/test/motion-preference.e2e.test.ts`: the default, saving it for one person only, clients that leave it out, bad values refused by the API and the database, and sign-in required.
- `apps/web/e2e/motion-flow.test.mjs`, with a device that asks for reduced motion:
  - the app follows the device, so pages appear at once and the globe jumps;
  - after choosing Animate, pages fade in and the globe glides through in-between views, and this survives a reload;
  - with Keep still on a device that allows motion, it is still again;
  - with Follow this device on a device that allows motion, it animates.

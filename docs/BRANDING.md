# Branding

Talk2Tax is a Sampledge product. Its logo is the speech-bubble mark with a percent sign, the
wordmark "Talk2Tax", the tagline "Talk. File. Relax." and "by Sampledge".

## Source files

The brand files as supplied live in `packages/design-system/brand`:

| File | Use |
| --- | --- |
| `icon.svg` | The mark alone, animated |
| `logo-dark.svg` | Full logo for dark backgrounds (the app), animated |
| `logo-light.svg` | Full logo for white backgrounds (paper, email), animated |
| `icon-512.png`, `logo-dark@6x.png`, `logo-light@6x.png` | Raster copies for slides, stores and the marketing site |

Each SVG carries its own animation and turns it off under `prefers-reduced-motion: reduce`.
All text in them is outlined, so they look the same without any font installed.

## Generated files

`node scripts/brand-assets.mjs` builds everything the apps use from those three SVGs. Run it
whenever a brand file changes and commit the result. It needs Playwright's Chromium, which
`apps/web` already has for its browser tests.

| Output | Where it shows |
| --- | --- |
| `apps/web/public/brand/logo-{dark,light}.svg` | Sign-in, register, first organisation, invitation pages (animated) |
| `apps/web/public/brand/logo-{dark,light}-still.svg` | App and admin sidebars, printed subscription invoices (no motion) |
| `apps/web/public/brand/icon{,-still}.svg` | `LogoMark` component |
| `apps/web/src/app/icon.svg` | Browser tab icon (still, cropped to the mark) |
| `apps/web/src/app/apple-icon.png` | iPhone and iPad home screen (180 px, on the app's navy) |
| `apps/web/public/brand/icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | Web app manifest (`apps/web/src/app/manifest.ts`) |
| `apps/api/src/common/brand-assets.ts` | Logo PNGs for email and PDF, as base64 so the API needs no files at run time |

The web middleware lets `/brand/*`, the icons and the manifest through without a session,
because the sign-in page shows them.

## In the code

- `Logo` (`apps/web/src/components/brand.tsx`): `size` sm, md, lg or xl; `animated` for the
  sign-in and first-run pages only, so nothing moves beside people's work; `tone="light"` on white.
- Colours (`packages/design-system/src/tokens.css`): `--t2t-brand-teal` #5EEAD4,
  `--t2t-brand-sky` #0EA5E9, `--t2t-brand-blue` #1D4ED8. The accent is the teal, the strong
  accent the sky, and `--t2t-gradient-brand` runs through all three. Primary buttons use
  `--t2t-gradient-action` (teal to sky), which keeps their dark label at 4.5:1 or better; the
  design-system tests check it.
- Email (`apps/api/src/workflows/branded-email.ts`): emails Talk2Tax sends in its own name
  (support replies, subscription reminders, the mail server test) carry an HTML version under
  the logo, attached inline so it shows without loading images from the web. The plain-text
  version is unchanged. Emails an organisation sends in its own name (collections reminders,
  automations) are never branded with Talk2Tax.
- PDF exports (`apps/api/src/report-exports/pdf.ts`) put the mark beside "Exported … from
  Talk2Tax" in the footer. Customer invoices keep the organisation's own branding from its
  invoice template.

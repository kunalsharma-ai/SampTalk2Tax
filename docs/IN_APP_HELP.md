# In-app help: the (i) icons and the feature guide

Every page and every titled section in Talk2Tax has a small **(i)** beside its title. Clicking it
opens a short panel with three parts:

- **What it is for**: the purpose of the page or section in one or two sentences.
- **How to use it**: the steps or the way to read it.
- **Where it fits**: where it sits in the menu and what it feeds or depends on (pages always have
  this; sections may leave it to their page).

The panel closes with Escape (focus returns to the icon), a click outside, or its × button.

**Feature guide** (Governance > Feature guide, and in the Help group for staff who only claim
expenses) lists every page of the menu the person can see, with the same three parts, grouped as in
the menu, with a search box. Pages a plan does not include are marked "Not in your plan".

## Where the text lives

All help text is in one place, in English, under `apps/web/src/lib/help/`:

| File | What it holds |
| --- | --- |
| `pages.ts` | `PAGE_HELP`: one entry per page, keyed by its route inside an organisation (`sales/contracts`, `sales/contracts/[id]`, `reports/management/[month]`); platform pages start with `admin/`. |
| `sections.ts` | `SECTION_HELP`: one entry per section title (`'Saved forecasts'`). Where a title means something different on one page, an entry keyed `'<route> > <title>'` (`'journals/new > Lines'`) wins there. |
| `index.ts` | `helpRoute(pathname)` (drops `/orgs/<id>`, turns ids into `[id]` and `2026-10` into `[month]`), `pageHelp`, `sectionHelp`. |

To change what a page or section says, edit its entry. To give a detail page its own text, add an
entry for its route; until then it uses the nearest page above it (`sales/contracts/[id]/edit` →
`sales/contracts`).

## How it is wired

- `PageHeader` (`components/shell.tsx`) shows the page's (i) from the current route. The sign-in,
  registration, onboarding and invitation pages show it beside their own titles.
- `CardHeader` in `@talk2tax/ui` shows a section's (i) for any text title, through
  `SectionHelpContext`. The organisation and platform layouts provide the resolver
  (`SectionHelpProvider` in `components/help.tsx`). A card can pass `help={null}` to show none, or
  its own `help` node.
- The (i) sits beside the heading, not inside it, so headings keep their names for screen readers
  and tests. It is a button named "About this page" or "About this section", with
  `aria-expanded`; the panel is a labelled dialog.

## Languages

The panel's headings, the icon's label and the feature guide's own words are in the Hindi
catalogue. The help texts themselves go through the same translation (English text is the key), so
a catalogue entry translates them; none are translated yet, so in Hindi they show in English.

## Checks

- `apps/web/test/help.test.ts`: every page of the app has help (its own or a page above it), every
  menu item has its own, no entry describes a page that does not exist, every section title written
  in the source has help, and page-specific entries win.
- `apps/web/e2e/help-flow.test.mjs`: the (i) on registration, onboarding, the dashboard, a section
  of the revenue forecast and a page-specific section; Escape, outside click and close; the feature
  guide and its search; Hindi headings.

A test fails when someone adds a page, a menu item or a section title without help, so the help
stays complete as the product grows.

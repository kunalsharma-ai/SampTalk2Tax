# Demonstration organisations (DEMO-001 to DEMO-021)

Anyone signed in can turn one of six made-up companies into an organisation they own, with six
months of synthetic books, to try Talk2Tax before (or alongside) their own books.

## The companies

| Profile | Country, currency | What it shows |
| --- | --- | --- |
| Indian consulting SME (Kestrel Advisory Partners) | India, INR | Service invoices with GST 18% to customers in three states, co-working rent, freelancers (non-GST), payroll with payslips, GST returns marked filed |
| US professional services company (Juniper Ridge Consulting LLC) | United States, USD | Hourly consulting fees, subcontractors as cost of sales, no sales tax charged on professional services |
| UK trading business (Harbourside Trading Ltd) | United Kingdom, GBP | Stock bought into inventory, sales with 20% VAT, an EU customer zero-rated, cost of sales moved from inventory, VAT return settings |
| UAE multinational subsidiary (Falconcrest Gulf FZ-LLC) | United Arab Emirates, AED | Services with 5% VAT, a monthly management fee from its made-up UK parent, an Omani customer zero-rated, VAT 201 settings (Dubai) |
| Global manufacturing group (Brennholz Precision Group GmbH) | Germany, EUR | Steel and components into inventory, sales at 19% USt at home and 0% to customers in the US, France and Japan, three departments |
| Market research agency (Lumen Insights Research) | India, INR | Research studies per project, respondent incentives and field partners as cost of sales, payroll |

## What is posted

Everything goes through the ordinary services (the same validation, posting and audit trail as
the API), in date order:

- **Customers and vendors** (DEMO-008, DEMO-009), with payment terms; Indian ones with made-up GSTINs.
- **Invoices** (DEMO-011) to every customer each month (one occasional customer every other month),
  tagged with the customer's **project** (DEMO-015). Each is paid on its due date if that date has come;
  one slow payer pays half, so receivables show an overdue balance.
- **Bills** (DEMO-012) from every vendor each month, paid on the due date if it has come.
- **Journal entries** (DEMO-013): share capital, monthly overheads by **department**, cost of goods sold
  for the goods businesses, and salaries by department outside India.
- **Employees** (DEMO-010): in the two Indian profiles, employees with salary structures and a posted
  pay run for each past month, net pay and dues paid when due. Payroll is India-only in Talk2Tax, so
  elsewhere the staff appear as salary journals by department; the demonstration page says so.
- **Bank transactions** (DEMO-014): a synthetic statement for the last 45 days built from the bank lines
  in the books (the latest not yet cleared) plus interest and a fee, imported and matched automatically.
- **Tax records** (DEMO-017): GST registration and rates with GSTR returns marked filed (India; the
  latest left open), or the country's starter VAT rates and VAT return settings with a made-up
  registration number (UK, UAE, Germany). The US profile charges no sales tax.
- **Budgets** (DEMO-016): this fiscal year's plan from the run rate, 8% higher, submitted for a second
  person to approve.
- **Financial reports** (DEMO-018): the books feed every report; KPI targets and a draft management
  commentary for last month are added.
- **AI recommendations** (DEMO-019): the demonstration page shows the CFO assessment's top
  recommendations, worked out deterministically from these books, and links to the full assessment.
  The checks run once, so Alerts has something to show.

## Labelled synthetic (DEMO-020, DEMO-021)

- The organisation is flagged `isDemo` (shown as **Synthetic demo data** on every page, linking to the
  demonstration page) and named "… (SYNTHETIC DATA)", with the legal name "Synthetic demonstration
  company — not a real business".
- Every customer, vendor, project, department, employee and document line says "(synthetic)".
  `demoLabelIssues` (engine) refuses a profile where one does not, and the API checks it before building.
- PANs start with ZZZ; GSTINs, VAT numbers and the TRN are made up and pass only the format check.
- A demonstration organisation is complimentary (no trial), so one person may create at most three.

## Where it lives

- Engine: `packages/accounting-engine/src/demo-profiles.ts` (profiles, `demoPlan`, `demoLabelIssues`).
- API: `apps/api/src/demo-organisations/`. `GET /v1/demo-organisations/profiles`,
  `POST /v1/demo-organisations {profile}` (signed in; about 10 seconds), and
  `GET /v1/orgs/:orgId/demo-organisation` (org.read; recommendations need reports.read).
  Collection `demo_organisations` (migration `20270321100000_demo_organisations`) records the profile,
  who asked, status (BUILDING, READY or FAILED with the reason) and what was made.
- Web: `/onboarding/demo` (from onboarding and the organisation switcher) and `/orgs/:orgId/demo`.
- Tests: `packages/accounting-engine/test/demo-profiles.test.ts`, `apps/api/test/demo-organisations.e2e.test.ts`
  (all six build with balanced trial balances), `apps/web/e2e/demo-organisations-flow.test.mjs`.

## Limits

- Tax set-up is for demonstration only and needs adviser review before anyone relies on it: the
  SAC codes, the non-GST rate for an unregistered freelancer, zero-rating of exports and the UAE
  parent's management fee left untaxed (reverse charge is not modelled) are simplifications.
- No group consolidation is built for the manufacturing group: it is one German company with
  export customers. Foreign customers are invoiced in the home currency.
- If a build stops part-way, what was posted is kept and the demonstration page says why.

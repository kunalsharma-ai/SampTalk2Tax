import type { Migration } from '@talk2tax/document-db';
import foundation from './20261109090000_foundation';
import identity from './20261109100000_identity';
import tenancy from './20261109110000_tenancy';
import chart from './20261109120000_chart';
import ledger from './20261109130000_ledger';
import sales from './20261110090000_sales';
import mirrored from './20261110100000_mirrored';
import usageBilling from './20261211100000_usage_billing';
import revenueRecognition from './20261212100000_revenue_recognition';
import customerPortal from './20261213100000_customer_portal';
import supplierTaxChecks from './20261214100000_supplier_tax_checks';
import vendorRisk from './20261215100000_vendor_risk';
import unbilledRevenue from './20261216100000_unbilled_revenue';
import vendorPortal from './20261217100000_vendor_portal';

/** In order. Never edit a migration that has been applied anywhere; add a new one. */
export const MIGRATIONS: readonly Migration[] = [foundation, identity, tenancy, chart, ledger, sales, mirrored, usageBilling, revenueRecognition, customerPortal, supplierTaxChecks, vendorRisk, unbilledRevenue, vendorPortal];

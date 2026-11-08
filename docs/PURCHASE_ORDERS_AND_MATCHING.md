# Purchase orders, goods receipts and bill matching

Registry: **AP-015 Purchase order matching**, **AP-016 Goods receipt matching**, **AP-017 Three-way matching**.

A purchase order records what was ordered from a vendor and at what price. Goods receipts record
what arrived. A bill made from the order is checked against it before it posts, so the business
pays only for what it ordered (two-way) and what it actually received (three-way).

## Purchase orders

**Purchases → Purchase orders → New purchase order.** The lines and totals are worked out by the
same code as a bill: tax rates, and under India GST the vendor's state, the place of supply (your
state by default) and the CGST/SGST or IGST split, on the order date. An order also has:

* an **expected delivery** date (an issued order with goods still to come after that date shows as
  **Late**);
* the vendor's quotation or reference, terms for the vendor and an internal memo;
* how its bills are **matched**: **three-way** (bill against order and goods received; for goods)
  or **two-way** (bill against order only; for services, where nothing is received);
* a **price tolerance** (how far above the order price a bill may be) and a **quantity tolerance**
  (how much more than ordered may be received or billed), both in percent, 0 by default.

It is saved as a draft numbered **PO-0001**. **Issue to vendor** fixes it: its vendor, date, lines,
figures, matching and tolerances cannot change afterwards (a database trigger enforces this on the
order and its lines).

| State | Meaning |
| --- | --- |
| Draft | Can be edited or deleted. |
| Issued | Sent to the vendor; nothing received yet (or two-way, not fully billed). |
| Partly received | Some goods received (three-way). |
| Received | Every line received in full (three-way). |
| Billed | Every line billed in full. |
| Closed | Nothing more expected (short-closed with a reason). What was received and billed stays. |
| Cancelled | Withdrawn with a reason; only possible when nothing was received or billed. |

An order with a draft bill waiting cannot be closed until the draft is posted or deleted.

## Goods receipts

**Record goods received…** on an issued three-way order records a goods receipt (**GRN-0001**): the
date (not before the order date, not in the future), the vendor's delivery note or challan, and per
line the quantity accepted and any quantity rejected with a note. Receiving more than ordered is
refused beyond the order's quantity tolerance.

Receipts are never edited or deleted. One entered by mistake is **cancelled** with a reason; it is
kept, and its quantities no longer count as received. A receipt cannot be cancelled when bills
(other than void ones) already bill the quantity it received.

## Making the bill

**Make bill…** creates a **draft bill** for what is left to bill on each line: what was received
(three-way) or ordered (two-way), less what other bills (drafts included, void ones not) already
bill, at the order's prices and tax rates. It carries the vendor's invoice number, which is checked
for duplicates as on any bill. Each bill line remembers the order line it bills, also when the bill
is edited; a bill can also be entered by hand against an order through the API with
`purchaseOrderId` and `purchaseOrderLineId` on its lines.

## Matching (AP-017)

A bill matched to an order shows **Purchase order match** on its page, line by line: quantity
billed, ordered, received, billed on other bills, and the price against the order price. A line is
an exception when:

| Check | Exception |
| --- | --- |
| Price | The bill price is above the order price plus the price tolerance (a lower price is fine). |
| Quantity ordered | This bill and other bills together bill more than ordered plus the quantity tolerance. |
| Quantity received (three-way) | They bill more than received plus the quantity tolerance. |
| Not on the order | A bill line that is not for an order line (freight, for example). |
| Order not open | The order is closed or cancelled. |

Several bill lines for one order line add up. **A bill with exceptions does not post**: posting is
refused with the differences listed. The bill can be corrected to the vendor's invoice, the goods
received recorded, or someone who can **decide approvals** (owners, admins and approvers, not
accountants) can **Accept differences…** with a reason. The acceptance applies to exactly the
differences it was given for: if the bill or the receipts change and the differences with them, it
no longer applies and earlier acceptances are listed as such. Acceptances are kept with the bill
(they can never be changed) and in the audit trail, and are removed only with a deleted draft bill.

A bill that matches, or whose differences are accepted, posts like any bill (approval rules, TDS
and GST included). Voiding a posted bill frees what it billed.

## Not yet covered

* Orders in another currency (orders are in the functional currency).
* Stock: goods receipts record quantities against orders but do not move inventory; inventory is a
  separate module.
* Printing or emailing a purchase order to the vendor.

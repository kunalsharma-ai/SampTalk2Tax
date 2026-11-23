# Company cards (EXP-011 corporate cards, EXP-012 virtual cards)

Company cards work with any card provider. Talk2Tax keeps the cards, the controls finance sets and the
spending; the provider issues the cards, enforces the controls and sends the spending.

## How it fits together

- **Card programme**: one card provider's account with the organisation, paid through one liability
  account (by default 2150 Credit Card Payable). An owner or admin sets it up and gets a token
  (`t2tc_…`) shown once; only its SHA-256 is kept. The token can be replaced, and a programme can be
  disconnected for good.
- **Cards**: a corporate card someone already holds is added by its last four digits and is active at
  once. A virtual card is asked for and stays *waiting for the provider* until the provider confirms
  it with its own reference, last four digits and expiry. Finance can freeze, unfreeze or cancel a
  card and set a monthly limit. Full card numbers never reach Talk2Tax.
- **Spending**: the provider sends transactions. Cardholders say which account each belongs to and
  why; finance posts settled spending to the books (debit the account, credit the programme's
  liability account; a refund the other way), or excludes it with a reason. Spending that the same
  person also put on an expense claim (same amount, within three days; void, rejected and draft claims
  left out) is shown as possibly claimed twice.

## The provider's side

All calls send `Authorization: Bearer t2tc_…`, to the API at `/v1/card-feed/...` or the web app at
`/api/card-feed/...` (no sign-in cookie is used there).

| Call | What it does |
| --- | --- |
| `GET me` | The programme, organisation and how many cards wait to be issued. |
| `GET cards` | Every card with its holder, status (REQUESTED, ACTIVE, FROZEN, CANCELLED), monthly limit, spending this month, last four digits and the provider's reference. Refuse spending on frozen or cancelled cards and above the limit. |
| `POST cards/{cardId}/issued` | `{"providerRef":"vc_1","last4":"1234","expires":"2029-12"}` confirms a virtual card. |
| `POST transactions` | `{"transactions":[{"id":"tx_1","card":"vc_1","date":"2026-11-20","amount":"1180.00","merchant":"Airline","mcc":"4511","state":"SETTLED"}]}`, up to 1,000 at a time. |

Transactions name their card by the provider's reference, the card's id, or its last four digits when
only one issued card has them. Amounts are strings in the programme's currency (the provider converts
foreign spending), positive for spending and negative for a refund, with no more decimals than the
currency has. `state` is AUTHORISED or SETTLED (the default). Sending an id again never adds it twice;
a SETTLED transaction with the id of an AUTHORISED one replaces it (amount, date, merchant), as long as
it is not posted. Only settled spending can be posted. Each refused transaction comes back with its
position and reasons.

## Permissions

| Who | Can |
| --- | --- |
| Everyone | See the cards they hold and their own spending, and explain it. |
| expenses.read | See every card and all spending. |
| banking.manage | Add cards, freeze, unfreeze, cancel, change limits, explain anyone's spending, exclude spending. |
| journals.post (with expenses.read) | Post spending to the books. |
| org.manage | Set up card programmes, replace their tokens and disconnect them. |

Everything is audited (`card_program.*`, `company_card.*`, `card_transaction.*`); tokens never appear in
the audit trail.

## Connecting a real provider

Connecting a real card provider needs that provider's own credentials and a small adapter on its side
(or a webhook relay) that calls the card feed above. Talk2Tax itself holds no provider credentials.

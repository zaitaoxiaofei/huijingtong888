# Daily finance accruals

Verified on 2026-10-26 using read-only responses from the official Seller API. No production database writes were part of the contract investigation.

## Confirmed source and limits of the evidence

- The old `/v3/finance/transaction/list` path returns HTTP 404 in the current integration. Do not change only its URL: the replacement has a different identity, paging and monetary model.
- `POST /v1/finance/accrual/types` with `{}` returned `accrual_types: [{id, name, description}]`. Resolve fee semantics through the returned name, never a guessed numeric ID.
- `POST /v1/finance/accrual/by-day` with `{date: "YYYY-MM-DD", last_id: ""}` returned `{accruals, last_id}`. An explicit empty response `last_id` ended the observed page. Missing cursors, repeated cursors and unsupported response shapes must not be treated as a successfully completed import.
- `/v1/finance/accrual/postings` returned HTTP 429 in the read-only probe. It was not retried. No complete contract or delivery/acquiring coverage was established for that method.
- The confirmed daily response has `accrual_id`, `date`, `total_amount: {amount, currency}`, `unit_number`, `accrued_category`, and optional `posting`, `item_fees`, `non_item_fee`, `container_fees`.
- `date` supplies day precision. Do not present a database midnight used to represent that day as the exact official event time.

The public [daily-accrual question](https://dev.ozon.ru/community/2218-Utochnenie-formata-otveta-metoda-Poluchit-nachisleniia-za-den/?__rr=1) contains a request example. The [delivery-cost question](https://dev.ozon.ru/community/2319-Poluchenie-stoimosti-dostavki/) shows why posting accruals alone cannot be assumed to contain every cost. These are developer reports on the official community, not a substitute for the observed official response or a complete API specification.

## Monetary model

`total_amount` is the official signed net. The observed posting product commission object includes `sale_amount`, `sale_commission`, `commission`, `seller_price`, `sale_price`, `coinvestment`, and `bonus`, with explicit money objects. Item and non-item fees expose `type_id` and `accrued: {amount, currency}`.

- `sale_amount` supplies gross seller accrual. It is already an amount; do not multiply it by product quantity again.
- Equal `sale_commission` and `commission` in the same owner are aliases and count once. Contradictory aliases require review.
- Seller and buyer price/funding references are retained but are not additional revenue on top of `sale_amount`.
- A synthetic example: gross 100 plus commission -12 equals net 88. Store an income row of +100 and one fee row of -12. Do not store an additional +88 net row.
- Gross is carried only by the income anchor's `accruals_for_sale`; other rows carry zero gross. Their signed amounts sum to the official net.
- Each namespaced accrual ID is an independent signed fact. Across several events for one posting, sum the unique income anchors with their signs; an additional income event adds revenue and a negative income event reduces it. Do not apply legacy `MAX(ABS(gross))` to this source. Mixed legacy/new facts require review to avoid double counting; the frozen V1 source retains its old rule.
- Distinct parent and child accrual IDs remain distinct even when their service identities match. Allocate a parent's independent event instead of dropping it merely because the child already has that fee type or another income event. A single accrual ID inconsistently spanning parent and child scopes requires review.
- Residual = official net minus gross minus explicit fees. Keep a nonzero residual with its raw evidence and mark the operation unreconciled. Unknown fee types, unidentified money objects, unsupported/mixed currencies, and unclassified positive adjustments also require review; they cannot finalize order profit.
- CNY amounts stay CNY. RUB amounts require an explicit archived rate. A reviewed currency rule for the old transaction endpoint does not establish currency for the new endpoint.

Confirmed type names include `Acquiring`, `SaleCommission`, `RfbsGlobalDelivery`, `RfbsGlobalIntermediaryService`, and `RfbsGlobalPlatformConnectionService`. Keep the full returned dictionary as source evidence; do not use a substring such as `Commission` to classify unrelated names such as `BrandCommission`.

## Identity, ownership and application

- Internal operation IDs use `accrual_by_day:<accrual_id>` to avoid collisions with legacy transactions.
- Stable row identity uses the source group, official fee type and SKU, not array position or amount. A monetary correction retains the same service identity.
- The observed `ITEM` units can be parent order numbers; `POSTING` and `NON_ITEM` units can identify individual postings. Preserve the literal unit and its scope. Unknown/container units remain unallocated. Do not invent a child order or lose the parent unit.
- Every stored operation belongs to an authorized shop and enterprise. Resolve parent allocation using frozen original seller prices, the fixed order-day allocation rate and scoped sibling records; do not use current listing prices or equal-share guesses.
- The original API accrual is retained in `raw_json` with `_source_endpoint` and `_normalization.reconciliation`.
- Replacement writes must be transactional and scoped to the shop plus namespaced operation. Retain IDs for unchanged service identities and refuse revisions that would invalidate linked financial vouchers.
- Restoring the raw feed does not authorize recalculating legacy V1 order profits at new daily rates. V2 final profit still requires signature evidence, frozen archives, complete cost categories and reconciled source operations.

Implementation boundaries: `ozon-finance-accrual-client.js` fetches pages, `ozon-finance-accruals.js` normalizes original monetary facts, `order-finance-accrual-write.js` stores operation-day ledger rows, and the separate V2 order-finance path applies the frozen order/signature policy. Platform ledger cash flow and signed-day order profit are different reporting bases.

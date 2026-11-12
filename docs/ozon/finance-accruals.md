# Daily finance accruals

## Source migration (2026-11-04)

Raw finance collection always uses `/v1/finance/accrual/types` and `/v1/finance/accrual/by-day`, independently of the profit FX policy. Missing or invalid profit-policy configuration cannot select the retired transaction endpoint. Explicit legacy-source requests and missing real shop credentials fail before HTTP; no empty-success or legacy fallback is supplied.

Existing legacy transactions are retained. Because their identities cannot safely be matched to daily accrual IDs, collection starts after the shop's latest legacy operation date when the requested range overlaps it. Responses expose `source_endpoint`, `warnings`, and per-shop `source_from`, `legacy_through`, `note`, and `status` (`ok`, `skipped_legacy_range`, or `error`). This is a conservative overlap boundary, not proof that earlier days are complete; gaps and corrections there need separate reconciliation. The raw sync log records the warning.

Each provider request and stored operation rechecks the current enterprise permission, active shop and unchanged credentials. Rotation or revocation interrupts collection. Repeated daily imports retain stable identities. Existing writers still require archived FX and reconciled signed money; missing evidence is not replaced by a guessed rate.

Collecting new bills does not activate a profit policy. V1 and V3 orders cannot consume the daily accrual monetary model or be recalculated by its arrival. Existing V2/V4 paths keep their dedicated settlement prerequisites. A completed date range does not establish that every future fee for an order has arrived. No historical deletion, production schema change or bulk profit recalculation is part of this migration.

Validation: mocked provider unit tests plus isolated MySQL tests cover absent/malformed policy, repeat ingestion, legacy overlap, original currency, historical profit, enterprise isolation and key rotation. These are not live-shop acceptance results.

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
- `commission` and `sale_commission` are not assumed to be aliases. A further five de-identified official daily responses on 2026-10-26 contained different values; in each response `sale_amount + commission` exactly matched `total_amount`, while using `sale_commission` did not. Normalize the explicit `commission` as the sole commission amount and retain `sale_commission` as a monetary reference. Use `sale_commission` only when `commission` is absent or null, never because it happens to match the net better. An explicit zero is present, not missing.
- This precedence is based on the observed official responses, not a claim that the complete business meaning of both fields has been established by the published schema. Validate every present commission candidate's money shape and currency, preserve the complete original response, and still require the entire operation's signed components to equal the official net exactly. Invalid candidates, unsupported/mixed currencies or a nonzero residual remain pending review. Do not derive the commission from `commission_ratio` or silently balance a discrepancy into a finalized fee.
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

## 2026-11-12: historical backfill completeness (local, not released)

The outer backfill previously dropped `warnings` and per-shop source boundaries from raw ingestion. A range excluded by the legacy-overlap guard could return `ok: true` and write an `ok` backfill log without reading Ozon. Partial source errors could also be absent from the outer error list.

Backfill now exposes per-range `source_endpoint`, `source_shops`, `warnings` and status. A protected legacy range returns `needs_reconciliation`, warnings are retained in the aggregate and sync log, and aggregate `ok` is false. Partial source errors propagate as `partial_error`. A genuinely successful empty read remains `ok`; dry-run coverage is explicitly `audit_only` and does not contact Ozon or write logs.

This is a completeness-reporting fix, not an automatic historical repair: legacy/accrual identities remain separate, protected dates are not recollected, and no fee classification, order-profit formula or existing application rule changes. `/v1/finance/accrual/postings` still requires its own verified contract and reconciliation work. Official migration notice: https://dev.ozon.ru/news/783-Izmeneniia-v-metodakh-dlia-raboty-s-finansovymi-otchetami-v-Seller-API/

Validation: 36 focused unit/contract tests and 5 isolated MySQL tests passed without skips. The MySQL check confirms an excluded legacy range makes no provider request, preserves legacy/foreign rows, and records `needs_reconciliation`; existing V1/V2 pipeline tests continue to pass. No production change is included in this local batch.

# Official promotion enrollment migration

Reviewed 2026-11-07. The official enrollment/save path uses `POST /v1/actions/products/update` instead of the retired `activate` method. Candidate and joined-product pages use v2 directly. Seller-created promotions keep their separate API. No live promotion writes were performed during this change.

## Request and confirmation

`POST /api/ozon/actions/products/add` accepts the existing shop/action/product selection, with explicit `currency` (`CNY` or `RUB`) for scalar `action_price`, or an `action_price: {amount, currency}` Money object. Official requests require `confirmSharedPrice: true`; the UI explains that the shared promotion limit may affect other activities for the same product. The confirmation does not authorize an unrelated product or tenant.

The whole batch is rejected before provider HTTP for invalid action/product IDs, duplicate products, more than 1000 rows, missing/unsupported currency, nonpositive prices, more than two decimal places or invalid stock. Rows are never silently filtered or truncated. CNY/RUB is this project's tested compatibility boundary, not an official claim that Money supports no other currencies. Missing currency must be corrected by refreshing the official product list; RUB is not guessed.

Before a mutation, the backend rereads the current shop's action catalog and selected product evidence through v2 candidates and, when necessary, joined products. It compares the submitted Money currency against current official Money and requires the submitted limit to be at most `max_action_price` and at least an available `min_seller_price`. A stale or ineligible row becomes a per-product failure; other verified rows can proceed. It never silently changes the operator's 100 price to 95 merely because the admission ceiling is 95, or submits an enrollment price above the ceiling that would accidentally trigger an exit.

Activity stock is distinct from FBS warehouse stock. The update schema permits optional `stock`, serialized as a nonnegative integer string. This project exposes it only for voucher promotions after checking the current official catalog. The public migration article explicitly restricts stock for scheduled auto-add; it does not provide the same detailed immediate-update stock semantics. This conservative UI/backend policy must not be described as an officially confirmed prohibition for every immediate non-voucher update. Actual warehouse quantities are changed through the separate batch-stock workflow.

## Half-price calculation

The v2 product-page adapter returns numeric display fields together with `currency`, `price_money_verified` and `enrollment_base_price`. The base is only the official product `price` Money; it is never the shared `action_price`, discounted `marketplace_seller_price`, or a buyer-facing website price. Conflicting currencies, malformed Money or an unavailable base clear the verified flag and base instead of guessing.

The operator's 200 product price therefore produces a 100 submitted limit. A previously saved 100 action limit does not become a new base and cause a second half-price operation to submit 50. Ozon's article distinguishes product price from shared action limit; it does not guarantee that the product price remains frozen after unrelated future retail repricing. Always refresh the current list before a new operation. A 100 limit is eligible only when the current admission ceiling allows 100 and other Ozon constraints pass.

## Receipt and verification

Official responses expose `success`, `count`, `confirmedProductIds`, `failures: [{product_id, reason}]`, `warnings`, `apiVersion: "update"`, and the original provider `result`. A product counts as confirmed only when explicitly active, neither rejected nor deactivated, and found by a complete v2 joined-product read with the requested price and currency. Missing/contradictory receipts, incomplete pagination, read failures and delayed participation remain unconfirmed. Future enrollment is not claimed successful solely because HTTP returned 200.

The UI retains per-product failures and warnings. A timeout instructs the operator to refresh before deciding whether to retry. It does not automatically retry the write or fall back to `activate`. Switching shops/modes/actions clears the result and ignores a late response from the previous scope. Single-row enrollment also obtains shared-price confirmation.

Read-back verifies membership and activity price, not a guarantee of future eligibility, stock consumption or every downstream effect on other promotions. Eventual consistency can leave an accepted operation unconfirmed; operators should refresh, not repeatedly submit it.

## Evidence and remaining acceptance

Official sources successfully reread on 2026-11-07:

- [Promotion API migration guide](https://dev.ozon.ru/start/563-Obnovlenie-metodov-raboty-s-aktsiiami-v-Seller-API-v2/), published 2026-09-17 and updated 2026-10-14: retirement moved to 2026-10-19, v2 Money pages, update receipts, threshold-based admission/exit and voucher forced removal.
- [Shared promotion limit warning](https://dev.ozon.ru/news/840-Seller-API-napominanie-o-edinoi-predelnoi-tsene/), published 2026-10-22: shared limits propagate across price/promotion sections and repeated percentages of the current limit can repeatedly reduce it.
- [ActionsProductsUpdate operation](https://docs.ozon.ru/api/seller/#operation/ActionsProductsUpdate) remains the canonical detailed reference. Its dynamic page returned no readable operation content; the exact schema retained in `promotions-contracts-reference.json` is a historical mirrored snapshot, not a fresh official swagger verification.

Pure/VM tests exercise Money, batch validation, partial/contradictory receipts and the actual Vue submit functions. Isolated MySQL tests exercise current enterprise membership, foreign shop denial, permission revocation, original outbound payload and 429 handling with provider responses mocked. Existing manual removal, cleanup and enterprise route tests remain required. Real-shop acceptance must check a small explicitly approved product selection, both currencies where used, scheduled promotions and shared-price effects before a wider rollout. This change does not deploy or restart production.

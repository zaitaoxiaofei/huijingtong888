# Official promotion enrollment migration

The official enrollment/save path now uses `POST /v1/actions/products/update` instead of the retired `activate` method. Seller-created promotions keep their separate API. No live promotion writes were performed during this change.

## Request and confirmation

`POST /api/ozon/actions/products/add` accepts the existing shop/action/product selection, with explicit `currency` (`CNY` or `RUB`) for scalar `action_price`, or an `action_price: {amount, currency}` Money object. Official requests require `confirmSharedPrice: true`; the UI explains that the shared promotion limit may affect other activities for the same product. The confirmation does not authorize an unrelated product or tenant.

The whole batch is rejected before provider HTTP for invalid action/product IDs, duplicate products, more than 1000 rows, missing/unsupported currency, nonpositive prices, more than two decimal places or invalid stock. Rows are never silently filtered or truncated. Stock, when present, is serialized as a nonnegative integer string. Missing currency must be corrected by refreshing the official product list; RUB is not guessed.

## Receipt and verification

Official responses expose `success`, `count`, `confirmedProductIds`, `failures: [{product_id, reason}]`, `warnings`, `apiVersion: "update"`, and the original provider `result`. A product counts as confirmed only when explicitly active, neither rejected nor deactivated, and found by a complete v2 joined-product read with the requested price and currency. Missing/contradictory receipts, incomplete pagination, read failures and delayed participation remain unconfirmed. Future enrollment is not claimed successful solely because HTTP returned 200.

The UI retains per-product failures and warnings. A timeout instructs the operator to refresh before deciding whether to retry. It does not automatically retry the write or fall back to `activate`. Switching shops/modes/actions clears the result and ignores a late response from the previous scope. Single-row enrollment also obtains shared-price confirmation.

Read-back verifies membership and activity price, not a guarantee of future eligibility, stock consumption or every downstream effect on other promotions. Eventual consistency can leave an accepted operation unconfirmed; operators should refresh, not repeatedly submit it.

## Evidence and remaining acceptance

Based on the official Seller documentation snapshot captured during the 2026-11-03 audit (`ActionsProductsUpdate`) and its Money example; the 2026-11-04 browser attempt timed out. This is not a fresh successful documentation fetch or a live-shop acceptance claim. Source: https://docs.ozon.ru/api/seller/#operation/ActionsProductsUpdate

Pure/VM tests exercise Money, batch validation, partial/contradictory receipts and the actual Vue submit functions. Isolated MySQL tests exercise current enterprise membership, foreign shop denial, permission revocation, original outbound payload and 429 handling with provider responses mocked. Existing manual removal, cleanup and enterprise route tests remain required. Real-shop acceptance must check a small explicitly approved product selection, both currencies where used, scheduled promotions and shared-price effects before a wider rollout. This change does not deploy or restart production.

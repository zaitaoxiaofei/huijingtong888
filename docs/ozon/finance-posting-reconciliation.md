# Read-only finance accruals by posting

## Verified contract and current evidence

Verified against the official Swagger loaded by the [Seller API documentation](https://docs.ozon.ru/api/seller/#operation/GetFinanceAccrualPostings) on 2026-11-12 (`operationId: GetFinanceAccrualPostings`, tag `BetaMethod`). The local audit extraction is `work/ozon-finance-postings-official-spec-20261112.json` outside this task checkout.

- `POST /v1/finance/accrual/postings` takes `{posting_numbers: string[]}` with 1–200 entries.
- Response: `{posting_accruals: [{posting_number, accruals: [{accrual_date, type_id, accrued, seller_price?, sku?, quantity?}]}]}`.
- `accrual_date` is a day. `accrued` and optional `seller_price` carry original decimal-string `amount` and `currency`. SKU and quantity can be null. Type names come from `/v1/finance/accrual/types`.
- The official row has no `accrual_id` or `operation_id`. Identical fee rows are preserved: they cannot be collapsed or assigned invented ledger identities. No sum or currency conversion is computed.
- Missing postings remain `not_returned` with null details, distinct from `returned_empty`. Unknown fee types remain explicit. No response is presented as proving full order-level financial coverage; parent/unallocated charges still require daily-accrual reconciliation.

Two bounded read-only probes of one already-known order in the authorized Z shop both returned HTTP 429 at the postings endpoint (`Retry-After: 1`), with a several-minute gap. Type dictionary lookup succeeded. No fee response or monetary coverage was verified, and probing stopped. No financial rows, order profits, production configuration or services were changed. A new adapter must not be described as live-accepted until a real fee response is checked.

## Local implementation, not deployed

`POST /api/finance-center/ozon-posting-accruals` accepts `{shop_id, order_ids}` (1–200 known local orders). Only a current active enterprise owner/admin can use this exact route. Tenant, membership, shop, credentials and selected order ownership are rechecked before/after reads and retries. Default-enterprise NULL shop ownership is admitted only in the real default enterprise; forged tenant hints, other-platform shops and missing credentials cannot send requests.

The source reads share the deployed financial Client-Id queue with types/by-day, including bounded 429 retries, Retry-After and cancellation. The service exposes original fees and coverage limitations only; it does not write the ledger, recompute profits, change historical boundaries, create sync logs or persist the report. Explicit write/apply flags are rejected. No new table or plugin update is required. This is a backend read capability; no new operator UI has been added.

Validation: 74 unit/contract/authority tests and 16 isolated MySQL tests pass (90 total, no skips). The real DB route tests include an identical-payload quota retry, unchanged ledger/profit/log rows, shared-name A/B enterprises, default NULL ownership, revoked membership/subscription, key rotation, order transfer, WB rejection and no partial result after access changes. Existing daily-source, scheduled-warning and frozen V1/V2 finance pipelines pass. UTF-8, SQL bindings and syntax checks pass. All automated provider responses are synthetic; the two real probes remain rate-limited. This batch is local only and separate from the unpublished price-pagination repair `8780a3f`.

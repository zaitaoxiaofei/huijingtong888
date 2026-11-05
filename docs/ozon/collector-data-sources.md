# Storefront collector data sources

Reviewed: 2026-11-05 (Asia/Shanghai).

## Evidence boundaries

The storefront monthly-sales endpoint below is verified from the project's browser bridge and ECS client. It is a Seller website endpoint, not a documented public Seller API contract. Its availability, response meaning, account permissions, and period boundaries must be verified independently; do not infer that `monthly` always means a calendar month or exactly 30 days.

Official references checked:

- [Seller API documentation](https://docs.ozon.ru/api/seller/) (dynamic page had no readable body in the fetch tool).
- [Official Seller API FAQ](https://dev.ozon.ru/start/257-FAQ-spravochnik-oshibok-i-sposoby-ikh-resheniia): public Seller API examples use `api-seller.ozon.ru` with `Client-Id` and `Api-Key`.
- [Official analytics limit update, 2026-09-16](https://dev.ozon.ru/news/797-Izmenenie-limitov-na-metod-v1-analytics-data/): `/v1/analytics/data` retains a limit of one request per minute, with 50 daily requests for sellers without a subscription. These documented limits apply to that public endpoint; they must not be copied onto the website endpoint below without evidence.

## Current monthly-sales request

```http
POST https://seller.ozon.ru/api/site/seller-analytics/what_to_sell/data/v3
Content-Type: application/json
X-O3-Company-Id: <verified company ID>
X-O3-Language: zh-Hans
Cookie: <authorized Seller session; never log this value>
```

```json
{
  "limit": "50",
  "offset": "0",
  "filter": { "stock": "any_stock", "period": "monthly", "categories": [], "sku": "<SKU>" },
  "sort": { "key": "sum_gmv_desc" }
}
```

The browser bridge uses `credentials: 'include'`. The ECS pool sends its encrypted-at-rest saved session explicitly. Public Seller API keys are not used by this request path.

`items[0].soldCount` supplies the displayed monthly quantity. `items[0].soldSum` is preserved and aliased to `soldSumRub`; the revenue display prefers `soldSumRub`, then `soldSum`, then `gmvSum`, and formats the numeric value in rubles. This display path does not estimate revenue by multiplying the visible price and quantity.

## Other requests in the collection chain

| Endpoint | Purpose |
| --- | --- |
| Storefront `GET /api/entrypoint-api.bx/page/json/v2?url=...` | Product title, price, images and other base information. |
| Seller `POST /api/v1/search` | SKU base information and variant identification. |
| Seller `POST /api/site/seller-prototype/create-bundle-by-variant-id` | Variant details. |
| Seller `POST /api/v1/search-variant-model` | Legacy variant fallback. |
| Public `https://api-seller.ozon.ru/...` | Separate ERP integration authenticated by `Client-Id` and `Api-Key`; do not assume it has identical marketplace SKU metrics. |

## Multiple-shop dispatch

All shop workers call the same endpoint URL. The worker's identity is its verified company, session, permitted context headers, tenant, and source shop, rather than a different API URL for every shop.

The legacy ECS pool loads saved bindings, distributes SKU indexes modulo binding count, and allows at most six concurrent SKU jobs per batch. Read-only production probes of six active saved bindings on 2026-11-05 succeeded zero times: three ended with 403 and challenge-shaped JSON after 307, and three ended with 401 after 307. Replaying the newest saved cookie in its original order still returned the challenge. An independent service with the same plain HTTP request does not establish a working browser session. A separate official Seller API product-list control succeeded; these are different authentication paths.

The pending 1.4.39 implementation adds an embedded coordinator at `/api/local-plugin/collector-browser-pool` and workers in the product collector plugin. It does not require a separate server, database migration, or new production port. The coordinator receives worker identity and normalized results; browser cookies stay in the browser. Actual Ozon requests use the existing logged-in Seller tab with `credentials: 'include'`.

Each worker identity includes a persistent installation UUID, cookie store, and live company ID. The page company and Chrome cookie-store company must match before registration and throughout execution. The server resolves the source shop from the verified enterprise and active shop ownership, never a submitted shop ID. Multiple tabs for the same company share one server lock. Multiple Chrome tabs in one cookie store are not independent shop sessions; use genuinely separate logged-in profiles, stores, or computers to supply distinct healthy companies.

The coordinator rotates work among live companies, limits an enterprise to six active tasks, and keeps a company to one active SKU across overlapping batches. A SKU's sales, base, and variant requests stay on one worker attempt. Failed or expired leases can move the SKU to another worker with a fresh lease and source identity. HTTP 401/403/429 cools down that company. Sales can arrive as a partial result before other fields, but only complete results enter the five-minute cache. Worker result submission receives a small acknowledgement; clients read incremental results with a revision cursor.

This preview queue is bounded and in-process. Requests for the queue must reach the same application process; separate processes do not share workers, locks, or jobs. Read-only production inspection found one normal Nginx upstream and one explicitly marked backup, rather than round-robin routing. Normal requests therefore reach one coordinator. Failover or restart can drop or separate pending previews; the client reports an unavailable state and retains completed results instead of silently repeating an unknown active job. A future load-balanced multi-replica deployment needs shared queue state or explicit affinity before enabling this path. Old servers or no available workers retain the existing verified fallback. Accepted batches are not replayed through fallback on an unknown polling/network failure.

Keep all requests for one SKU on one worker. On a worker failure, restart that SKU on the next usable worker and retain source identity. Specific-shop orders, profits and operational analytics must continue to use that shop; they are not interchangeable selection-pool data. An independent service does not by itself repair a rejected session. Verify at least two distinct usable sessions before claiming concurrent multi-shop operation.

## Relevant source and verification

- `ozon-erp-collector-plugin/seller-bridge-content.js`: browser request construction and session use.
- `ozon-erp-collector-plugin/background.js`: raw sales mapping and pool/browser routing.
- `ozon-erp-collector-plugin/field-registry.js` and `content.js`: card field selection and formatting.
- `src/services/collector-seller-pool.js`: ECS request credentials, binding loading and worker dispatch.
- `ozon-erp-collector-plugin/collector-browser-worker.js`: verified browser workers and incremental previews.
- `src/services/collector-browser-pool.js`: bounded coordinator, leases, cross-batch locks and cache.
- `src/services/collector-browser-pool-access.js`: active enterprise/shop ownership checks.
- `src/server/collector-browser-pool-route.js`: authenticated coordinator HTTP endpoints.
- Verify same SKU across two authorized workers, compare account-sensitive fields, simulate 401/403/429 and overlapping batches, and ensure tenants and source shop identities stay separate. Any local service verification must use port 8788; production rollout requires fresh approval.

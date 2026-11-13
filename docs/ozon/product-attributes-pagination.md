# Product attributes v4 pagination

Verified: 2026-11-12 against the current official Seller API Swagger.

Official reference: [ProductAPI_GetProductAttributesV4](https://docs.ozon.ru/api/seller/#operation/ProductAPI_GetProductAttributesV4).

## Problem and affected reads

`fetchOzonProductInfoAttributes` previously read one page with a default limit of 100, then returned it as the result. An HTTP failure triggered an additional request to `/v3/products/info/attributes`, which is absent from the current official specification. That alternate request could replace an authorization or rate-limit error and add latency.

The helper is used by online-product editing, draft/template enrichment, publish-record refresh and product-information recovery. A multi-product request could therefore omit later products even when Ozon supplied a continuation cursor. Single-product reads remain supported.

## Contract and correction

- Use only `POST /v4/product/info/attributes`. The current response has an array in `result`, a string `last_id`, and an optional decimal-string `total`. Preserve the existing nested `items` response compatibility without probing the old endpoint.
- Send `last_id` starting with the empty string, then carry the provider's cursor. Use the documented lowercase `sort_dir: asc` and the existing page-size limit of 1–1000.
- Read short intermediate pages when a continuation cursor remains. Stop at the verified total or at an empty cursor when no known total remains outstanding. Retain a previously supplied total if a later page omits it.
- Invalid structures, changing totals, incomplete totals, duplicate identities, repeated/cyclic cursors and empty intermediate pages fail explicitly. Never return an incomplete prefix as a successful list. Limit the read to 1000 pages.
- Preserve the existing bounded v4 transport retry policy and original provider status. Run optional authorization hooks around every page; cancellation and post-response scope revocation stop further reads and prevent returning the collected prefix.
- This change reads attributes only. It does not publish or edit products, change image precedence, save historical payloads, modify database schemas or require a plugin update.

## Validation and rollout

145 focused tests passed, including the new provider-contract cases, existing credential behavior, template health, record editor and draft creation checks. UTF-8, SQL binding and diff checks passed. Provider responses were mocked; no live product mutation or production deployment was performed.

This local change starts from remote release `b6c647c6436a7dae6f35080f44c3e014f2e28572`. It is separate from the pending posting-SKU correction `c7f9e55`; merging both later requires combined validation against the then-current release head. Public publication and ECS rollout require explicit approval for this batch.


## Combined release preparation — 2026-11-13

The approved attributes correction and posting-SKU correction have been integrated onto release baseline `b6fe8fcf73c4f0b79e71d14e480a63c956328df5`. An older FBS pagination fixture now supplies a real `sku` distinct from its catalog `product_id`, consistent with the official posting schema. The combined validation passed 171 unit/contract/listing checks and 57 isolated MySQL checks, with no skips, plus the frontend build, UTF-8 and SQL binding checks. Production acceptance will read a real posting and a small paginated attribute sample only; no real shipment, split, product edit or historical recalculation will be submitted.

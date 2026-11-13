# Remaining Seller API contract audit — 2026-11-12

Compared literal versioned paths in `src/**/*.js` with the Swagger served by the [official Seller API documentation](https://docs.ozon.ru/api/seller/). This static inventory does not establish runtime reachability or real-shop acceptance.

The extraction found 86 unique candidate strings: 84 literal paths and two dynamic/prefix strings. Of the literals, 67 appear in the current specification and 17 do not. Eight of the absent paths belong to FBO supply compatibility, excluded by the user's scope. The remaining nine absent paths are listed below. Absence is a compatibility risk, not independent proof of a provider retirement date.

| Area | Unlisted paths | Current observation / next step |
| --- | --- | --- |
| Product attributes | `/v3/products/info/attributes` | Local correction removes this failure fallback and completes v4 pagination. See `product-attributes-pagination.md`. |
| Product upload quota | `/v3/product/info/limit` | Current v4 is documented, but any v4 failure currently tries v3. Next inspect quota parsing, failure propagation and publishing blockers before removing the fallback. |
| Legacy categories | `/v3/category/attribute` | Current description-category/type method exists. Some callers may still have only an old category ID. Identify those callers and require explicit category/type resolution; do not guess a mapping. |
| Chat list | `/v2/chat/list`, `/v1/chat/list` | Current v3 exists. Check active users, pagination and fallback admission before changing the implementation. |
| Chat history | `/v2/chat/history`, `/v1/chat/history`, `/v2/chat/messages`, `/v1/chat/messages` | Current v3 history exists. Verify its cursor/message-ID semantics and failure behavior before replacing compatibility paths. |

Other observations:

- `/v1/actions/products` and `/v1/actions/candidates` are marked deprecated by the current specification. Here the matched source occurrence is a queue compatibility set, while the active promotion reader uses v2. A textual match alone is not an active deprecated request.
- `/v1/review/list` is marked deprecated; review synchronization remains excluded by user scope.
- The order SKU/catalog-ID correction is ready locally as `c7f9e55`, with 90 focused tests. It remains separate from production.
- Price pagination and read-only posting-fee inspection were deployed as `df8265e`, version `2026.11.12-price-posting-df8265e`. Real acceptance read one matching price row and one returned posting-fee row; the fee response had no unknown types. Write flags were rejected with HTTP 400. The acceptance submitted no business writes; the shop ledger count and maximum ID stayed unchanged.
- This inventory covers Seller paths only. Performance advertising endpoints use a separate specification; their bid/minimum/keyword-preservation acceptance remains a separate task and must not perform an unapproved real bid update.

Suggested local sequence: finish the attributes correction, validate quota reading, resolve legacy category inputs, then inspect chat compatibility. FBO supply and reviews stay outside this plan.

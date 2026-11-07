# Advertising bid update contract

The existing settings writer incorrectly sent PUT, then POST on HTTP 405, to the GET-only `/api/client/campaign/{campaignId}/v2/products` resource with a `products` body. It now sends one PUT to `/api/client/campaign/{campaignId}/products` with `bids`, without alternate-method retry.

## Before the write

The authenticated enterprise owns the active shop and has the existing analytics permission. Validate numeric uint64 campaign/SKU IDs, positive finite values with at most four decimals (matching stored metadata), and a target CIR of 10–100 inclusive. Bid serialization preserves the existing millionths-of-RUB convention with exact decimal-to-integer arithmetic, avoiding floating-point multiplication and rounding. Its real-shop unit/minimum acceptance remains a release check.

The current Performance campaign must use TARGET_BIDS for CPC adjustments or TARGET_CIR for target-CIR adjustments. Paginated GET v2 products must find the selected SKU. Missing/unsupported strategies, malformed/repeated pages and absent SKU stop before PUT. No campaign or product is implicitly created.

The official UpdateProducts documentation warns that it overwrites stop words and phrases with bids. Requests therefore require `confirmKeywordReset: true`, supplied only after the settings dialog shows that impact and obtains confirmation. This change does not reconstruct or preserve keyword settings; operators who need them preserved must cancel and use the Ozon cabinet. This warning must not be removed merely because test responses contain no keywords.

## After the write

A successful HTTP response alone cannot update the local metadata. Paginated GET v2 products must return the selected SKU with the exact bid integer or matching targetCir. Only then return `ok: true, verified: true` and update scoped local campaign metadata. Spend/revenue and statistics `synced_at` are not modified by changing a setting.

An accepted PUT followed by missing/mismatched values or failed read-back returns `ok: false, verified: false, pending_verification: true` and an operator message. The dialog stays open and retains the warning. An ambiguous failed write instructs the operator to check the cabinet or refresh before retrying. No write is automatically retried; 405 does not cause POST fallback. Explicit provider errors remain errors.

Active shop, current enterprise membership and unchanged Performance Client ID/Secret are checked around every provider request, including token retrieval. Rotation/revocation stops subsequent calls and local persistence. A revoked response does not establish whether a remote write took effect; operators must reconcile it before another attempt.

## Evidence and acceptance

The official Performance documentation snapshot collected in the original audit contains UpdateProducts, GetProductsV2, strategy enums and targetCir bounds. The current web fetch returned no readable content; this is not fresh documentation verification. Source: https://docs.ozon.ru/api/performance/#operation/UpdateProducts

Validation uses pure contract tests, actual Vue submit-function tests, and real isolated MySQL tests with all provider responses mocked. It covers exact payloads, pagination, unsupported strategies, missing consent/invalid values, mismatched reads, 405/429, foreign shops, key rotation and membership revocation. No real advertising spend, keyword removal, production configuration change or deployment was performed. Before release, independently verify bid units/minimums, both supported strategies and the keyword warning against a small explicitly approved real campaign.

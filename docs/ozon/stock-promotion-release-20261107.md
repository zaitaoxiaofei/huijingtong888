# Stock and promotion release candidate

Reviewed 2026-11-07. Based on latest fetched `origin/main` at `8096f9f`. Candidate branch: `release/2026.11.07-ozon-stock-promotions`.

## Scope

- Recover pending/zero-stock products across visibility buckets, retain real product/offer identities without inventing SKUs, and require explicit current zero-stock evidence.
- Complete v2 warehouse pagination; validate integer stock; send at most 100 stock rows per batch; preserve each accepted/rejected receipt, including successful earlier batches when later work stops.
- Read official promotion products/candidates through v2 and submit Money limits through products/update. Manual exits use v2 directly and retain threshold/voucher distinctions. Existing unattended-cleanup protections remain separate.
- Calculate 200 → 100 from the product's base price, never the current promotion limit. Recheck current admission conditions; do not silently reduce 100 to a lower admission ceiling.
- Preserve existing page layout/styles, expose partial outcomes, retain failed stock targets for retry, and ignore stale shop/activity/login reads.

No database schema, browser-plugin source, production configuration, or frozen profit-formula change is included.

## Local evidence

- Stock/client/warehouse/pending-listing/enterprise checks: final 13-file run, 96 passed, no failures or skips, using the isolated socket-only MySQL fixture and mocked Ozon responses.
- Promotion, cleanup, enterprise and page checks: 121 passed in the combined run. After the direct-v2 manual-exit follow-up, its two MySQL suites passed 18 checks; final changed-page suites passed 28 checks. These groups overlap and should not be summed.
- Production frontend build, UTF-8 check, SQL-binding check and Git whitespace check passed. Existing build-size and AI-workbench runtime-proxy warnings remain unchanged.
- Browser verification used an isolated static test server on local `8788`, with every `/api/` request mocked. Verified repeated half-price filling stays at 100, currency and shared-price consent reach the request, partial enrollment/stock failures stay visible, and only failed stock targets remain available for retry. No browser runtime errors were observed; page layout and styles remained intact.
- One unrelated order-normalization assertion also fails on unmodified `8096f9f`; see [the baseline discrepancy](./stock-pending-listing.md#existing-normalization-test-discrepancy). Neither the order normalizer nor that test was changed.

No real-shop inventory/price writes were performed. Provider acceptance, eventual stock visibility, actual eligibility and shared-price effects remain distinct from mocked regression coverage.

## Pending ECS rollout

This candidate has not been deployed to ECS and production services have not been restarted. The isolated worktree intentionally has no production `.env`, so deployment-environment preflight stopped at its missing-env check; production-environment validation is still pending.

After fresh explicit approval under `AGENTS.md`, deploy the clean release branch using the checked-in ECS workflow and its normal build/package/preflight steps. Keep the existing production configuration and normal reviewed database release policy. Verify service health and read-only stock/promotion queries after deployment; use the workflow's rollback if activation health fails. Do not claim a real inventory or promotion mutation was accepted without its per-item provider receipt and applicable read-back.

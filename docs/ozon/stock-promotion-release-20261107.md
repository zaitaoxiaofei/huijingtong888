# Stock and promotion release candidate

Reviewed 2026-11-07. Initially based on fetched `origin/main` at `8096f9f`, then merged the verified current ECS production head `024feb9911657009a36677e28c726eea4c6a334f` before rollout. The canonical remote release is `release/2026.10.21-task-brand`; the task release is `release/2026.11.07-ozon-stock-promotions`. Both must contain the final integration commit.

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
- After merging the exact production baseline, the stock group passed 99 checks, the promotion/MySQL group passed 34, and changed-page plus production-commit-guard checks passed 29, without skips. The merged frontend build and browser verification also passed. Two test-fixture bindings were updated for schema/logging dependencies already present in production; runtime schema and health logging were preserved.
- One unrelated order-normalization assertion also fails on unmodified `8096f9f`; see [the baseline discrepancy](./stock-pending-listing.md#existing-normalization-test-discrepancy). Neither the order normalizer nor that test was changed.

No real-shop inventory/price writes were performed. Provider acceptance, eventual stock visibility, actual eligibility and shared-price effects remain distinct from mocked regression coverage.

## Pending ECS rollout

The user explicitly approved merging and deploying to ECS after reviewing the repair and local validation. Current production collector `1.5.4` and analytics source `1.0.44` are preserved from its verified Git baseline; this task does not modify either plugin. The private build environment has been prepared without adding credentials to Git or the deployment artifact, and deployment-environment preflight now passes.

Deploy the exact clean merged release using the checked-in ECS workflow and `ExpectedProductionCommit=024feb9911657009a36677e28c726eea4c6a334f`. This guard rejects activation if another release changes production during packaging/upload. Keep the existing production configuration and skip broad database initialization/maintenance; candidate-required structure checks remain enabled. Verify service health, read-only stock/promotion queries and the downloaded existing unified-plugin package after deployment; use the workflow's rollback if activation health fails. Do not claim a real inventory or promotion mutation was accepted without its per-item provider receipt and applicable read-back.

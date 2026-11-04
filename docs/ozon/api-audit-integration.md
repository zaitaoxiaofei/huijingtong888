# Ozon API audit: integrated validation, 2026-11-04

Release baseline: `b5fa55338650a53f66e7e485e42b7b31fb4d39af`, remote `release/2026.10.21-task-brand`, fetched again after validation. This is a local integration branch, not a released/deployed build.

| Scope | Draft PR | Reviewed source head |
| --- | --- | --- |
| Seller credential health and data freshness | #96 | 96465afafea2709627dd2fdd113615294b6a8369 |
| Warehouse v2 pagination and stale-cache protection | #97 | 926d06bed044c186da6e922f09973141de61ad9f |
| Finance daily source independent of profit policy | #99 | a592ae2fe050f7d9e5e2d12253bacba9e7d9d5ec |
| Promotion enrollment and per-product confirmation | #100 | 685d6ce57a3d47dbc78d002cc3f4ec34c0e6e518 |
| Advertising bid path and read-back | #101 | 92f5fb8c1a60f8fe88fcc13a51526cf131930f59 |

## Integration resolution

Merging finance after credential health conflicts in the raw finance error handler. Keep both `recordOzonSyncHealth(...success: false...)` and `shopResult.status = "error"`. Do not choose either side wholesale. Other changes merged without source conflicts.

The finance VM fixture must provide the health recorder when testing the combined implementation. Added assertions confirm that a real collected range records finance health and a wholly excluded legacy range does not advance freshness. First integrated VM run exposed the missing fixture dependency; it was repaired and rerun. Actual MySQL coverage uses the real health adapter.

## Combined evidence

- 157 focused logic, client, route and actual Vue-function tests passed, no skips.
- 104 isolated MySQL tests passed, no skips: credential health, warehouses, finance writes/pipeline, tenant orders, promotions, cleanup and advertising.
- Integrated frontend build, UTF-8, SQL bindings and generated API documentation checks passed.
- Provider HTTP responses were mocked. No real promotion, advertising or production write was performed.
- Known baseline logistics fixture failures were independently documented in the earlier credential phase; this is focused acceptance, not a claim that the entire repository test suite passes.

## Remaining acceptance and release sequence

1. Verify each active shop's Seller authorization/expiry using the read-only health path, ensure the intended owner/admin receives notifications, and identify the production SHA. Never invent a missing expiry date.
2. Validate complete FBS/rFBS warehouse reads for actual shops. A failure must block stock submission, not reuse an old successful list. FBO supply and reviews remain excluded by user scope.
3. Compare small settled/refunded order samples to original finance bills and currencies. Review legacy-date gaps/corrections separately. Do not enable a new profit policy or bulk-recalculate frozen history as part of raw-source recovery.
4. Promotion and advertising acceptance writes require a specific small selection and impact confirmation. Verify future enrollment, shared promotion limits, bid units/minimums and both supported ad strategies. The advertising update method's documented keyword/stop-word overwrite risk remains; do not proceed where those settings must be preserved.
5. Before any rollout, merge the selected validated changes (including the finance/health resolution) into the then-current remote release branch, reconcile concurrent production hotfixes, and rerun affected checks. Build the release artifact from that exact merged SHA, then present a concrete ECS deployment for explicit approval. Local integration artifacts are not deployable release evidence.

The product `total_items` change remains a November 23 warning/regression item. Multi-label latency remains separate follow-up work; the currently working print path is not replaced by this audit.

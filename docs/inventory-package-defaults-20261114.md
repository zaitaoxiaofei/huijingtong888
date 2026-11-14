# Inventory package validation and defaults

User scope: stock creation/editing requires positive finite package weight and dimensions. Selection drafts may remain incomplete; conversion to stock already validates measurements. Both direct catalog creation and pending inventory applications enforce the stock requirement. The shared editor points to the missing measurement before sending a request.

New catalog packaging/handling defaults use CNY selling price only: up to and including 50 = 0.30; above 50 through 100 = 0.50; above 100 = 1.00. RUB list prices use the catalog exchange rate. Weight and purchase cost do not change the tier. Explicit manual amounts, including zero, are retained. Existing profit formulas, settled costs and historical packaging rules are unchanged.

Validation:

- Boundary/measurement/API tests pass (3 tests); published formula and OGL regression group passes (15 tests including the new three).
- Isolated MySQL catalog creation/manual-fee/edit validation and OGL recalculation integration pass (2 tests).
- Inventory application lifecycle includes rejection of zero-weight pending applications. Extended existing UI/application suite: 32 pass, 10 fail; exactly the same ten failures reproduce on clean release a96581d; no new failures.
- Frontend production build, encoding and SQL binding checks pass.

Production data repair (authorized separately from code deployment): 22 confirmed inventory products checked; 20 weights changed and 2 already correct. IDs: 389,564,578,606,824,827,828,829,830,845,847,848,849,872,881,894,940,958,984,1013,1025,1038. All TENET PLUS L6 zinc-alloy/leather-and-zinc-alloy variants, including straps and gift boxes, were explicitly confirmed at 200g; PLUS L4 ordinary stainless trim confirmed at 280g.

100 corresponding orders from Beijing 2026-11-01 were reviewed; 99 estimated results changed, total estimated profit difference -212.45 CNY. Two settled actual-cost records were byte-for-byte preserved. All 100 detail snapshots refreshed. Four remaining zero-weight orders belong to EXEED black LOGO TPU kit product 711; no weight was invented. Production manifests and before-images are under `/opt/ozon-erp/shared/maintenance/requested-weights-20261114` and `/opt/ozon-erp/shared/maintenance/ogl-switch-weights-20261114`.

Deployment status: previously approved OGL fix merged to remote release as a96581d73eb115a071666cf6f54edc9c87e5e6fe. Reproducible artifact version 2026.11.14-ogl-estimate-a96581d was built and uploaded. Remote release guard refused before installation because swap usage was approximately 89% (maximum 80%); primary was not changed. Current production remains 4a5a6ef485d05047beee345f88818cebdafe8f98, version 2026.11.13-wb-workflows-4a5a6ef. MySQL holds approximately 3.4 GiB of swapped memory despite a current 128 MiB buffer pool. No restart, swap modification or resource-guard bypass was performed. A graceful MySQL restart requires explicit approval and temporarily affects ERP availability; after recovery the standard release guard must pass before retrying the approved release.

This additional catalog validation/defaults change has not been deployed; prepare a fresh merged artifact only after its separate deployment approval.

# Annual company finance source sorting

After archiving 33 official order-sales sources, the annual company query exhausted MySQL sort memory because SELECT * filesorted full JSON payloads. Read tenant/company-scoped rows without SQL sorting, then retain deterministic month/id ordering in JavaScript, including prior-period cost allocation history. No business amounts, confirmation states or server memory settings change.

Validation: 63 focused tests passed, including a large-JSON regression; SQL bindings, UTF-8 and API documentation checks passed. Read-only production-scale verification returned both complete annual reports: 652 Shanghai documents and 118 Hefei documents. Z October matched 672 source rows at CNY 6,515.25; historical Shanghai unmatched costs remain null with issues. The verification injected only the corrected SELECT ordering and performed no financial writes.

Deploy the exact merged release artifact with --skip-storage-lifecycle-setup; retain existing storage workers and configuration. Final acceptance must repeat authenticated annual HTTP reports and detail pagination after activation.

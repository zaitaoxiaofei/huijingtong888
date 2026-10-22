# Daily catalog compatibility

Default enterprise employees and customer enterprise employees use the same verified route set. A platform identity does not give an enterprise-wide business data bypass. Existing default products and shops with legacy NULL ownership remain available only to the actual default enterprise.

The verified daily catalog paths include CSV import preview/commit, product add/remove/delete/restore, product profit recalculation, online product binding and creation from an online product, online edit drafts, and local listing drafts created from an inventory product. Product merge and undo have separate evidence in `saas-product-merge-isolation.md`.

CSV preview resolves personnel names only among current enterprise members. Commit validates the actor, writes explicit ownership and ignores submitted enterprise selectors. Online binding validates nested recipe products before writing the mapping or online product. Binding-triggered outbound synchronization and deferred profit work receive the trusted session and enterprise.

The HTTP online edit adapter calls the runtime listing wrapper with `(id, {}, session)`. The wrapper forwards the numeric enterprise to the live Ozon reader, scopes saved publish snapshots to the same enterprise and owning shop, and rechecks the session before returning. This matters because testing only `onlineProductEditDraftMysql` misses the runtime wrapper and its snapshot lookup.

Inventory quick drafts validate source product ownership, reuse only drafts from the same enterprise and explicitly store `tenant_id`. This action requires inventory write permission and does not invoke an AI provider. The shared official Ozon category definitions remain shared.

Online archive, zero stock and zero-then-archive verify the owning shop and current enterprise/member/role before and after external calls. A revoked membership or expired subscription stops subsequent requests and local product mutations. Associated order exceptions are selected from the same owning shop, and each task ID is ownership checked before writing state. External HTTP is replaced by deterministic responses in tests; actual SQL and credentials selection execute against a random isolated database.

`test/tenant-catalog-compatibility-mysql.test.js` exercises the complete A/B/default service workflows, including actual runtime draft normalization, reuse of own records, corrupt foreign links, invalid nested recipes, foreign snapshot rejection, and revocation races. `test/tenant-catalog-route-contract.test.js` checks the HTTP argument boundary and the exact route/job permission matrix. The existing order isolation suite covers normal and forced product profit recalculation.

Higher-level matrix generation/publishing, batch publishing and advanced draft bindings remain closed until separately verified. This batch changes backend code and tests only; it does not change UI, V1 profit formulas, deploy or restart services.

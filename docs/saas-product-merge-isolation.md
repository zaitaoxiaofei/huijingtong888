# Product merge isolation

Merge preview, merge history, merge and undo resolve the actual enterprise ID. Only the default enterprise additionally accepts legacy `tenant_id IS NULL` data. Platform grants never widen this range.

The source and target products must all be owned by the current enterprise. Field and bundle sources must be among those selected products. Supplier, personnel, parent-product and logistics references are validated before committing. Existing invalid foreign references are excluded from preview counts and migration; they are not silently reassigned or repaired.

The existing reference registry covers child products, online products, SKU mappings, procurement requests, purchase items, inbound/outbound records, inventory movements, analytics snapshots, Ozon stock snapshots, FBP replenishment items and FBP transfer records. Each reference also checks its direct enterprise and applicable shop/order/purchase parents. Receipt children are moved before their procurement parents. Analytics are rebuilt within the same enterprise.

New merge histories retain version 2 internal snapshots of products, components, SKU recipes and procurement rows. Undo locks the products and stored references, verifies ownership again, accepts only static registry keys and refuses to overwrite captured rows that changed after the merge. It restores component/recipe IDs and quantities as well as procurement quantities, amounts and statuses. A failure rolls back the complete transaction. Trusted HTTP sessions are rechecked for active enterprise, subscription, membership and inventory permission before writes and before commit.

Existing history IDs and data remain unchanged. Histories created before version 2 keep their earlier product-field/reference restoration behavior, with the new ownership/key checks. They cannot recover component or procurement details that the old history never captured. There is no automatic historical data repair and no tenant-wide business update during merge schema initialization.

The schema initializer creates the existing FBP reference tables through schema-only ensure functions before processing a merge; product composition and SKU recipe schemas are also prepared. It does not run the older global FBP date backfill. No new columns or standalone data migration are required by this change.

Verification: `TENANT_TEST_MYSQL_SOCKET` must point to the independent socket-only MySQL instance. `node --test test/tenant-product-merge-mysql.test.js` creates and removes a random database, executes production SQL and transactions against it, and covers A/B/default/legacy data, foreign-parent corruption, preview counts, bundle/recipe arithmetic, procurement restoration, stock rebuilding, modified recovery data, revoked membership and transaction rollback. Only post-commit timers/external recalculation are replaced in the fixture; their tenant arguments are checked. `test/product-merge-composition-references.test.js` retains the existing merge behavior checks.

Verified exact routes: `POST /api/products/merge-preview`, `GET /api/products/merge-history`, `POST /api/products/merge`, `POST /api/products/:historyId/undo-merge`. The pilot route registry admits these paths; job authorization still requires inventory permission. This code change does not deploy or restart a service.

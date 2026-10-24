# Reviewed cleanup of eight online-product duplicates

This is a narrow administrator-only operation for the eight keep/remove choices in [the approved business review](legacy-online-cleanup-review-20261024.md). It does not run during startup or deployment. It does not repair history/category tables, change inventory quantities, change procurement/orders/profit, or guess historical parents. The tool has a code-level whitelist of the eight exact remove/keep/shop/SKU identities. Differing product/Ozon identities are accepted only for those explicit decisions, without rewriting either original row to satisfy another tool's identity rules.

`scripts/repair-reviewed-online-products.mjs` imports no application environment or credentials. Explicit database and root local socket are mandatory. Default execution is read-only. Bare `--apply` is the only apply flag; `--apply=false`, duplicate/unknown flags, ambiguous actions and nonabsolute plan/output paths are refused before connection. Errors omit raw SQL, business rows and values.

## Snapshot and scope

The manifest uses `version:1`, `mode:"reviewed-online-eight"`, a fresh twelve-character lowercase hex `repair_id`, and the exported `REVIEWED_ONLINE_PAIRS` array. Read-only inspection returns `snapshot`; copy it verbatim to `expected_snapshot` after independent review. It contains:

- Full PRIMARY-order native online-product count/hash, original DDL and AUTO_INCREMENT.
- All sixteen reviewed row native hashes, without exposing row content.
- Full before-state hashes/IDs of references to all sixteen IDs, plus exact loser-reference row hashes and digests excluding only `online_product_id`.
- Current DDL/counters for the six audited direct reference tables and DDL/zero-reference proof for the active inventory-request JSON path.
- Native hashes of the exact protected product 504, outbound 13777 and keeper barcode cache 243408.
- Actual default enterprise ID and native owner/product/order/item parent evidence.

The manifest additionally requires the existing exact `unchanged_outbound_reference` structure documented in [the unique repair guide](reviewed-legacy-unique-index-repair.md). It must identify outbound 13777, its original keeper/parent and native hash, with the user's explicit preservation confirmation. The same-enterprise parent-shop disagreement is retained byte for byte and remains unreconciled. No other parent mismatch is waived.

Apply requires actual boolean `production_approved:true`, `maintenance_confirmed:true`, `rollback_restores_nonunique_schema:true`, and nonempty `reviewed_by`/`reason`. Freeze all application writers, jobs, other administrator writers and the event scheduler before capturing the final approved snapshot. The acknowledgement/advisory lock does not itself stop unrelated writers. The database lock is shared with the older unique-repair tools. Both metadata and InnoDB lock waits are bounded at five seconds; SELECTs at ten seconds through the CLI.

New typed references, generated/invisible writable columns, unexpected natural key/primary key, writable-table triggers, CHECK constraints and incoming/outgoing FKs (including another database's FK) refuse execution. CREATE LIKE can rename CHECK constraints; the reviewed production scope has none, so no generic constraint-equivalence rule is introduced. Read-only products may have generated columns; native parent/protected hashes include them. Current zero loser cache/recipe or active request JSON references are hard scope boundaries: new ones require separate review, never cache deletion or generic JSON replacement. Historical action JSON stays unchanged.

## Reconstruction and recovery

Only `online_products` is rebuilt. A fresh shadow uses a real strict `UNIQUE(shop_id,ozon_sku)` with `unique_checks=1`. A PRIMARY copy excludes exactly eight reviewed losers. Any other duplicate fails the copy. The shadow's full retained native digest/count and AUTO_INCREMENT are checked against the complete original. No original online row is deleted in place.

Changed reference rows receive complete native before/after images in repair-owned tables. One transaction locks/rechecks current source/parents/references and changes only the loser's `online_product_id` to its reviewed keeper. All automatic timestamp columns are explicitly held at their existing values. Native digests excluding only the reference column prove that quantities, amounts, parent IDs, blobs and historical JSON stayed unchanged. Keeper references and their barcode PDF are untouched.

After the reference transaction, the original defective key becomes same-column NONUNIQUE, and the full original table is rehashed. Atomic RENAME installs the strict shadow and retains every original online row in `_roc_<repair_id>_old_online`. This archive itself is dump/restorable; it does not retain a contradictory UNIQUE. Capacity is computed only for this online-table operation: four times current reported online allocation plus a 1 GiB operating reserve, using actual datadir filesystem free bytes. This is not the fifteen-table maintenance budget and does not include permission to remove backups or unrelated artifacts. A separately verified native snapshot/dump and independent restore proof must also be retained by the operator.

The dedicated `_reviewed_online_cleanups` journal avoids exposing this new narrow mode to older rollback code, which recognizes only its own tables/modes. It records `preparing`, `references_applied`, `swap_pending`, `applied`, `rollback_swap_pending` and `rolled_back`. DDL and reference writes cannot be one MySQL transaction. Interrupted phases must be inspected, never rerun with the same repair ID.

```text
node scripts/repair-reviewed-online-products.mjs --database=EXPLICIT_DB --mysql-admin-socket=EXPLICIT_SOCKET --plan=/absolute/reviewed.json --output=/absolute/audit.json
node scripts/repair-reviewed-online-products.mjs --database=EXPLICIT_DB --mysql-admin-socket=EXPLICIT_SOCKET --plan=/absolute/reviewed.json --apply --output=/absolute/applied.json
node scripts/repair-reviewed-online-products.mjs --database=EXPLICIT_DB --mysql-admin-socket=EXPLICIT_SOCKET --journal=REPAIR_ID
node scripts/repair-reviewed-online-products.mjs --database=EXPLICIT_DB --mysql-admin-socket=EXPLICIT_SOCKET --rollback=REPAIR_ID --maintenance-confirmed
```

Matching rollback verifies current full online rows, complete original archive, reference before/after images, the entire affected reference set and protected rows before writing. Later changed rows/new references refuse automatic rollback. It recovers after reference COMMIT, forward RENAME before phase persistence, and reverse RENAME before reference restoration. It preserves the repaired strict table as `_roc_<repair_id>_undo_online`. Rollback restores original data with a NONUNIQUE natural key (`schema_exact:false`); contradictory original data cannot satisfy UNIQUE. Keep writers stopped until independently validated recovery. No archive/journal cleanup is automatic.

## Verification boundary

`test/reviewed-online-cleanup-mysql.test.js` uses only random disposable databases on an explicit local `TENANT_TEST_MYSQL_SOCKET` and requires server TCP networking disabled. The fixture represents duplicate source data through the exact same-column NONUNIQUE recovery schema; it does not claim to reproduce the historical corruption cause. It exercises all eight decisions with different identities, 28 reference remaps, protected inventory/outbound/PDF bytes, exact timestamps/amounts/JSON, strict unreviewed-duplicate refusal, native/schema/enterprise/FK/trigger guards, transaction rollback and interrupted commit/rename recovery. This test evidence does not establish production completion or inventory reconciliation.

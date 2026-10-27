# Reviewed history-only repair

This maintenance path repairs only `order_status_history`. It does not migrate online products, inventory references, category mappings, orders, profits, or frontend assets. The existing combined coordinator has a different, fixed fifteen-table scope and must not be used as a shortcut for this operation.

## Business decision and evidence

The user selected the following retention policy on 2026-10-27: keep the latest complete observation online, ordered by `observed_at` and then `id`, for the seven groups containing different business facts; retain the older complete records in a separate archive for restoration and traceability. Do not merge fields or rewrite IDs or timestamps to synthesize a keeper. This decision is not approval for production deployment, a service restart, or production configuration changes.

A production read-only audit of previously reviewed primary IDs found 5,227 unchanged native full-row hashes and 5,227 unique replacement parents identified by each history row's original shop and posting number. Of the existing parent links, 2,615 point to another shop, 2,595 point to another posting within the same shop, and 17 have no current parent. These are association errors, not evidence that the customer or address fields should be deleted. The historical mechanism that created the errors remains unproven.

The same audit rechecked 575 previously identified unique-key conflict groups: 518 include different posting numbers, and 54 have identical business fields. This is a recheck of known IDs, not exhaustive current production duplicate discovery. An earlier isolated backup rehearsal regrouped the table after correcting the 5,227 parent IDs: 1,370 duplicate groups remained, of which 1,363 differed only in observation metadata and seven contained different business facts. These backup counts must not replace a fresh frozen production capture.

The seven material groups include customer and region differences and delivery-window differences. In five groups, the latest observation lacks some information in the older observation. The archive preserves that information without presenting the older values as current facts.

## Query verification

Run the complete historical dataset through the current consumers before approving keepers. Compare the parent-corrected dataset with the proposed strict dataset separately from comparing incorrect and corrected parent links. Required checks include:

- The business facts selected by the maximum history ID per order.
- The latest observation per order, including every row tied at the maximum `observed_at`; set equality alone does not prove join multiplicity is unchanged.
- The latest row ordered by `(observed_at, id)`.
- The latest eligible delivered observation used by delivery-region statistics.
- Transport existence and the minimum non-null `last_status_changed_at` for the application's actual transport statuses.

Identical business fields alone do not establish that deleting a row preserves every reader. Imported IDs may have a different order from observation timestamps. Record actual differences and require a deliberate decision for a material effect; do not adjust business fields or timestamps to make a comparison pass.

## Production sequence

1. Review the exact code, local full-data rehearsal, keeper manifest, retention archive plan, measured capacity budget, and recovery procedure. Obtain fresh production rollout approval under the repository `AGENTS.md` rule.
2. Freeze every writer: primary and candidate application processes, workers, scheduled jobs, MySQL events and administrator SQL sessions. An advisory lock is not a writer freeze. Keep the freeze throughout capture, installation and independent validation.
3. Capture fresh complete native primary-row fingerprints, DDL, AUTO_INCREMENT values and parent dependency definitions for exactly `tenants`, `shops`, `orders` and `order_status_history`. A production capture must always begin unapproved. Recheck the reviewed correction and duplicate-row evidence; never silently replace an approved hash with a new hash.
4. Independently review the fresh candidate and explicitly approve that exact manifest. Production preparation and installation require actual boolean `production_approved: true`; the business retention answer alone must never populate this approval.
5. Build a repair-owned four-table staging database. Parents are evidence copies only. On the staging history table, convert the known broken natural index to NONUNIQUE, apply only the reviewed `order_id` corrections, and construct a fresh strict table using the reviewed explicit keepers and native hashes. Verify complete retained rows, schema, counters and the original staging archives.
6. Recheck the unchanged production snapshot and remaining filesystem headroom. Journal source installation separately from staging. Downgrade only the source history archive's damaged unique index without changing its rows, then atomically rename the original history to its repair-owned temporary archive and install the verified strict history. Parent tables are never installed, renamed or rewritten.
7. Independently verify strict uniqueness, row counts and native hashes; compare current application queries; export and strictly restore the final history table, the seven complete older material observations and the required repair evidence on an isolated MySQL instance. Keep restore evidence and archive manifests free of raw customer text in ordinary reports. A successful history-only restore does not establish that unrelated legacy unique-index issues in other tables are repaired.
8. Keep maintenance active if any check fails. Inspect the durable journal and use the matching history-only rollback; do not rerun an interrupted repair ID. Restoring original contradictory rows uses NONUNIQUE schema and does not authorize resuming normal writers.
9. After restoration and business verification, review the exact temporary artifact list before cleanup. Remove only repair-owned staging objects and the verified temporary original history table. Preserve the seven full older observations and the agreed correction evidence. Compare actual filesystem available bytes and final tablespace allocation after cleanup, then verify production readiness and ingestion.

## Administrator commands

The new entry point is `scripts/repair-reviewed-history-shadow.mjs`. It never imports application credentials. Every command requires an explicit database and local administrator socket. Writing actions are bare flags, are mutually exclusive, and never run by default. Use fresh output paths.

```text
node scripts/repair-reviewed-history-shadow.mjs --database=BUSINESS_DB --mysql-admin-socket=EXPLICIT_SOCKET --capture --source-kind=production_maintenance_snapshot --maintenance-confirmed --plan=/absolute/reviewed-baseline.json --output=/absolute/fresh-unapproved-candidate.json
node scripts/repair-reviewed-history-shadow.mjs --database=BUSINESS_DB --mysql-admin-socket=EXPLICIT_SOCKET --plan=/absolute/fresh-reviewed-plan.json --output=/absolute/inspection.json
node scripts/repair-reviewed-history-shadow.mjs --database=BUSINESS_DB --mysql-admin-socket=EXPLICIT_SOCKET --plan=/absolute/fresh-reviewed-plan.json --prepare --output=/absolute/prepared.json
node scripts/repair-reviewed-history-shadow.mjs --database=BUSINESS_DB --mysql-admin-socket=EXPLICIT_SOCKET --plan=/absolute/fresh-reviewed-plan.json --install --output=/absolute/installed.json
node scripts/repair-reviewed-history-shadow.mjs --database=BUSINESS_DB --mysql-admin-socket=EXPLICIT_SOCKET --journal=REPAIR_ID --output=/absolute/source-journal.json
node scripts/repair-reviewed-history-shadow.mjs --database=BUSINESS_DB --mysql-admin-socket=EXPLICIT_SOCKET --rollback=REPAIR_ID --maintenance-confirmed --output=/absolute/rollback.json
```

These are templates, not authorization to run production commands. Capture refreshes the four complete source snapshots and clears production approval. With a baseline plan, it preserves the existing reviewed link hashes, duplicate hashes, keepers and accepted differing columns; it does not independently approve or refresh those business decisions. Changed reviewed rows must be inspected separately. Stage preparation refuses mismatches before installing anything in the source. Unknown additional conflicts fail real strict reconstruction.

Use `--journal=REPAIR_ID --stage --database=_uir_hist_stage_REPAIR_ID` to inspect staging. The matching source journal is `_reviewed_history_shadow_repairs`; the ordinary and combined repair rollback commands do not manage it. There is deliberately no automatic cleanup action.

The manifest fixes the four-table scope, separate outer/link/unique repair IDs, complete native source snapshots, server-bound capture, explicit history-only correction and duplicate plans, a material-group retention list and an itemized measured capacity budget. The capacity fields are `stage_bytes`, `strict_bytes`, `link_archive_bytes`, `source_alter_bytes`, `restore_bytes`, `log_growth_bytes` and `reserve_bytes`, with a measurement reference and timestamp. Preparation compacts the strict staging history before installation and verifies its full native digest, exact DDL and AUTO_INCREMENT again. The strict budget must cover the strict table and its temporary compaction copy. Current source allocation supplies additional conservative lower bounds for staging, strict reconstruction and restoration.

Local verification found that cached `information_schema` statistics can report a stale or NULL AUTO_INCREMENT immediately after creating or renaming a table. The coordinator disables that cache only in its own administrator session (`information_schema_stats_expiry=0`) and retains the exact counter checks. It does not change a global database setting.

## Disk capacity and reclamation

Deleting the 1,370 conflicts in the historical rehearsal removes about 0.155% of its 885,883 rows. It is not evidence of a multi-gigabyte saving. The potential saving comes mainly from reconstructing the table and returning previously unused allocated pages to the filesystem.

The original production history tablespace was 2,902,458,368 bytes at the latest online size check. Renaming it to an archive releases zero bytes. Report a measured net benefit only after temporary original and staging objects are removed.

The capacity budget must include the staged history and parent copies, the strict reconstruction, complete before/after correction images, source index-operation temporary allocation, binlog and redo growth, an independent restore copy and an operating reserve. Use measured full-data sizes and actual free space on the MySQL data filesystem; a small fixture's disk footprint or the fifteen-table tool's capacity threshold is not a history-only budget. Do not claim future artifact removal as space already available.

Net reclaimed bytes are the original allocated history bytes minus final allocated history bytes, minus durable material-row archives, journals and any other newly retained artifacts. Existing uploads, unrelated backups and database logs are outside this repair's cleanup scope.

## Local and production status

Production execution completed after the user's explicit approval on 2026-10-28. Repair `64e0a747de50` captured 907,588 rows, applied the 5,227 reviewed parent corrections in staging and installed 906,218 retained rows. The 1,363 redundant observations were removed, and seven complete older material observations remain in `ozon_erp._hir_64e0a747de50_material_history`. All 687 affected orders passed the current consumer comparisons with zero changes from deduplication. An independent primary-row proof established that every retained field equals the original source except its explicitly reviewed `order_id` correction; all three parent tables retained their complete native fingerprints, DDL and counters.

Both the final 906,218-row production table and the seven-row archive were exported from MySQL 8.0.46 and successfully restored on an independent local MySQL 8.4.9 instance. Complete native row hashes, raw DDL, AUTO_INCREMENT, real UNIQUE indexes, zero duplicate groups and extended integrity checks all matched. Only after those proofs were the exact temporary original history table and repair-owned staging database removed. The source repair journal, material archive and private correction audit manifests remain; no full database backup was created for this operation.

The production history tablespace decreased from 2,902,458,368 to 914,358,272 bytes, returning 1,988,100,096 bytes (about 1.85 GiB) from that table. Filesystem usage changed from approximately 69% to 67%, with about 12.6 GiB available after service restoration. Immediate net filesystem benefit was about 0.85 GiB because maintenance also generated database logs. Existing automatic binlog expiry remains enabled at 86,400 seconds; it was not shortened or disabled.

The actual maintenance interval was Beijing time `2026-10-28 00:15:48` through `2026-10-28 01:01:59`, approximately 46 minutes. Main and candidate ECS services were restarted and verified, original Nginx configuration bytes were restored, event scheduling and the three existing timers returned to their original states, and the release lock was released. The current public entry `https://erp.hjt888.xyz/api/ready` returned 200. Local ERP port 8788 was not deployed or restarted. The tested administrator bundle was installed privately from `ef4ec69`, integrated into the latest release branch at `5fa99da`; the application package and UI stayed on the pinned `2026.10.27-promo-scan-8096f9f` release. Run receipts and restore proofs are retained under the private history maintenance directory and local deployment artifacts.

The 2026-10-27 isolated old-backup rehearsal processed 885,883 history rows, corrected 5,227 parent IDs and produced 884,513 retained rows. The 1,363 metadata-only removals and seven material archive decisions were evaluated separately across 687 affected orders: every required selected-row and business-result comparison, maximum-observation multiset and transport comparison was unchanged. Every retained full native row matched the original source with only its explicitly reviewed `order_id` projection. All seven complete archive rows passed a real mysqldump/import round trip with identical native hashes.

That rehearsal took 47.45 seconds for the initial copy, correction, regrouping, retention and strict-index reconstruction, followed by 66.65 seconds for additional full retained-row proofs and physical rebuild checks. Its working tablespace shrank from 1,031,798,784 to 893,386,752 bytes in the isolated physical rebuild, with identical full retained-row and parent digests. The recovery source had already been compacted and is not the current production dataset. Neither those sizes nor the initial 47.45 seconds establish a production saving or maintenance duration. Use the full coordinator timing below for local workflow evidence; a current production capture and its measured capacity budget remain separate requirements.

The final coordinator passed 31 distinct real MySQL fixture tests: a 29-test complete run plus two additional CLI/journal tests on identical library and CLI hashes. The frozen implementation then completed a full 885,883-row capture, preparation, compaction, installation, verification and rollback rehearsal in 542.05 seconds. Preparation took 310.81 seconds, installation 128.95 seconds and rollback 52.69 seconds; the remaining time covered complete snapshot checks. The installed 884,513-row digest exactly matched the independently derived retained-row proof. Rollback restored all four original table snapshots, including DDL and AUTO_INCREMENT.

After that uninterrupted local rollback, the retained strict undo table was independently verified against the installed digest, then dumped and imported into a separate random database. All 884,513 restored full native rows, exact DDL, AUTO_INCREMENT and the real UNIQUE key matched. This additional full-table restore proof took 87.71 seconds and used a 610,193,116-byte SQL dump. The seven material older rows also passed their separate complete-row restore proof. These are local validations, not production changes.

The local server was MySQL 8.4.9 with TCP, events and binlog disabled. The recovery source history index was already NONUNIQUE. Production read-only inspection found MySQL 8.0.46, binlog enabled and event scheduling enabled with no current events. Production still needs its own frozen snapshot, exact schema verification, capacity budget for source index conversion and binlog growth, and final strict restore proof. The local disk budget cannot simply be copied to production. A suggested 20-30 minute maintenance allowance is an operational estimate, not a guaranteed runtime.

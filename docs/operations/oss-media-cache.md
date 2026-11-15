# OSS media storage and reviewed cache maintenance

## Storage contract

Generated AI originals/crops, cropper uploads/outputs, shop watermarks and video source images must have a verified OSS copy before their operation succeeds. Working media uses private `ai-task-media` objects. Published listing media continues using `listing-media`. Tail templates cannot silently fall back to permanent local storage when OSS is disabled.

Private-object verification accepts an explicit private ACL. If the upload account lacks `GetObjectAcl` permission (403), it instead requires a denied unsigned range read from the canonical HTTPS OSS origin, with an OSS request ID. Public responses, missing objects, redirects, network failures and unrelated ACL errors fail closed. Upload requests still explicitly set private ACL, and authenticated body size/SHA-256 verification is unchanged. This supports minimum-permission accounts without granting additional RAM permissions. Validate a real tiny upload through the production API before migration, rather than relying only on mock credentials or a local browser preview.

Uploads retain their existing authenticated URLs and enterprise/task ownership checks. Missing local files are restored from the canonical `/uploads/...` mapping, with actual streamed size and SHA-256 verification and an atomic rename. ZIP creation and downstream crop/video readers restore their inputs as needed. Remote errors retain originals and fail the operation; AI generated-output checkpoints allow storage recovery without buying another generation.

`uploads/temp/ai-source-cache` contains reproducible HTTP downloads only. The existing daily AI history worker expires known hash-named downloads after 48 hours, at most 200 per invocation, preserving current in-memory references. It never sweeps arbitrary temporary uploads. Generated originals and migrated legacy media use the reviewed seven-day cache workflow below; this release does not schedule automatic production restarts or delete OSS objects.

## Existing file migration

Run from the activated, approved release directory, with production environment loaded. Keep manifests in a private directory outside release directories. Substitute the reviewed absolute paths and database/socket; do not copy a production manifest to another database or release path.

1. `node scripts/manage-media-cache.mjs --mode=audit --database=ozon_erp --mysql-admin-socket=/var/run/mysqld/mysqld.sock --output=/private-review/cache-before.json --limit=200 --days=7`
2. Review database/server/bucket identity, file hashes, missing roots, reference scan completeness and candidate bytes. A bounded or incomplete scan does not authorize removal. Start with a small batch and check recovery through the owning enterprise's normal preview/download/ZIP routes.
3. `node scripts/manage-media-cache.mjs --mode=archive --database=ozon_erp --mysql-admin-socket=/var/run/mysqld/mysqld.sock --manifest=/private-review/cache-before.json --output=/private-review/archive-result.json`
4. Audit again into a new manifest. This time every deletion candidate must have a `durable_media_cache` mapping, verified actual OSS content and unchanged local fingerprint. Old HEAD/size-only migration entries cannot authorize deletion. Archive never removes local files or business references.
5. After explicit maintenance approval, stop every application/worker writer including hot standby, then audit again in that maintenance window. Clean with the new manifest and `--mode=clean --offline-maintenance`. The CLI independently verifies there are no application writers or other database connections, rechecks business references, mapping identity, OSS body and local fingerprint before each unlink. Restart through the approved deployment workflow and verify representative image/video/ZIP reads after actual eviction. Incomplete or changed evidence leaves files in place.
6. Iterate remaining batches. The inventory is bounded; `has_more` means the review is not complete. Do not delete `uploads`, database files, attachments, staging backups or dependency caches as part of this operation.

The legacy `cleanup-verified-local-media.mjs --write` is disabled because HEAD existence and size alone cannot establish a recoverable cache copy.

## Large draft JSON

`scripts/manage-listing-json-storage.mjs` defaults to read-only audit. Require explicit `--database`, `--mysql-admin-socket`, `--tenant-id` (`admin` or numeric enterprise ID) and absolute `--output`. Page with `--after-id`/`--limit`; inspect `has_more` and the SHA-bound review plan.

`--mode=apply --manifest=/private-review/json-audit.json` first archives exact original JSON bytes as a private gzip object under `database-archives/listing-drafts/<tenant>/<sha>.json.gz`, reads it back and verifies the original checksum. Only then does a transaction replace eligible draft template JSON with the existing immutable-master/delta format, using a lossless compressed master when smaller. Assembly and persisted round trips must equal the original payload. Updates compare-and-swap the reviewed hash and remain enterprise scoped. Manual facts, AI facts, selected images and business histories are preserved. Existing immutable snapshots are never overwritten. Failed batches retain a partial result report for prior committed groups.

Restore with `--mode=restore --manifest=/private-review/json-result.json` and the same explicit database/tenant options. Restore refuses rows edited after compaction and reads original bytes from the checksum-verified private archive. Retain every review/result report and OSS archive. No automatic OSS lifecycle expiry should target `ai-task-media`, `listing-media` or `database-archives`.

Logical JSON savings are not immediate filesystem savings: InnoDB retains reusable pages. This operation does not run `OPTIMIZE TABLE`, rebuild tables, purge binlogs manually, remove audit histories or copy the whole database into another local backup.

## Read-only production findings, 2026-11-15

- Local media was approximately 5 GiB, dominated by AI generated PNGs (2.51 GiB) and shop variants (2.11 GiB). A 40-file oldest-first sample, 54,410,024 bytes, found no verifiable durable copy through existing hash mappings and known content-addressed namespaces. This is a sample, not an exhaustive OSS listing: archive and verify every candidate before deletion.
- Full-field exact duplicate hashing found only about 2 MiB of redundant draft/category-template JSON. Large repeated structures require reversible compression/shared snapshots, not blanket row deletion. This release prepares reviewed draft-template compaction; category-template JSON and manual facts are retained.
- MySQL occupied about 15 GiB including approximately 4.1 GiB of binary logs with 24-hour retention. Table allocations and database directory size differ; this is not 15 GiB of duplicate business data.
- At the later check there were 190,885 profit revisions and 957,098 order status observations. Latest 2,000 profit revisions had no repeated full idempotency key; latest 2,000 status observations had no repeated order/shop/hour/status/raw-content digest. Same-hour observations alone are not duplicate evidence. `ORDER_HISTORY_DEDUPE_MODE=enabled` was already active. Keep financial/order history.

## Validation and rollout boundary

Tests cover same-size corruption, private ACL, missing/bad bucket mappings, atomic recovery, concurrent download coalescing, symlink/traversal rejection, changed review evidence, maintenance gates, enterprise ownership, compressed immutable references, private JSON archive failure, MySQL transactional compaction and exact restoration. Run the protected listing tests, OSS tests, workflow recovery tests, real MySQL integration, frontend build, SQL bindings and UTF-8 checks before release.

Three `storage-growth-guard.test.js` source-shape assertions also fail on the untouched `de4a8df3` baseline. Record them separately; they are not evidence that all repository tests pass.

ECS deployment/restart/configuration requires fresh approval under AGENTS.md. Before approval, prepare and merge the tested branch into the latest remote release, build the exact merged commit and report its SHA/version. Production file deletion requires the reviewed manifests and maintenance checks above; no deletion is implied merely by installing the new readers.

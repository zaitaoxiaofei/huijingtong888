# Order read latency acceptance — 2026-11-01

Target: ordinary order opening and paging below 2,000 ms; samples above 3,000 ms fail acceptance. Validate both the authenticated API and browser rows becoming visible, including a concurrent metadata request. Do not substitute a warm isolated SQL measurement for end-to-end production acceptance.

## Baseline and concurrency

PR #68 was deployed as `2026.11.01-order-priority-e672094`, preserving finance PR #67. Its source/file integrity, 40 summary rows and scoped inventory-row refresh were checked. Quiet list calls measured 1,930 / 1,265 / 1,176 ms, but concurrent full metadata produced 5–8 seconds and one browser request took 23.9 seconds. The full metadata request exceeded the 45-second verifier timeout. Connection isolation alone was insufficient.

This task began at release e672094 and rebased onto `b69f86d6b3611578344ba85a170f2be6d7a22498`, preserving PR #70 inventory capital, billing-month, mobile and finance changes. A live probe stopped when production changed rather than comparing against the old release.

Read-only profiling found the full procurement demand query exceeding 10 seconds over roughly 88万 status-history records. FBP snapshot, picking and formula labels took about 7–23 ms each. The heavy reader also repeatedly fetched and parsed raw JSON, joined history into recipe/component expansion, and ran synchronous enterprise allocation in the API event loop.

## Changes

- Materialize the exact existing procurement warehouse/schema classification in an indexed virtual column. Preserve explicit schema fallback, root/null precedence, FBP/FBO/OGR, Unicode-escaped keys and malformed JSON behavior. The index avoids fetching large raw payloads for demand classification. MySQL maintains it within source writes; no historical order, quantity or profit arithmetic is rewritten.
- Add the index through the existing reviewed order-index migration: dry-run/compatibility inspection, release backup, `ALGORITHM=INPLACE, LOCK=NONE`, and verification before candidate startup. Unexpected column/index definitions fail closed. Reference: https://dev.mysql.com/doc/refman/8.0/en/alter-table-generated-columns.html
- Read order-level transport/physical evidence separately and attach it by owned order ID, preserving null-history timestamps, cancellation evidence, warehouse reservations and tenant boundaries.
- Execute large pure allocation calculations in one bounded worker per process. Preserve both Map entries and attached `available_batches` / `product_availability` properties. Small product saves stay local; profit formula code is unchanged.
- Coalesce/cache enterprise coverage, status counts and ordinary summary rows for 15 seconds. Shared inventory/workflow revisions immediately invalidate them; marks, printing, print rollback and inventory-product edits explicitly invalidate reads. Old in-flight results cannot repopulate a new revision. Returns are cloned to prevent accidental cache mutation. Detail and explicit product-scope reconciliation keep their fresh paths.
- Fix summary join order and reuse one owned OGL evidence relation for ordinary status filtering/count/paging. Search-specific predicates retain their existing targeted path. No toolbar, layout or selection behavior changes.

## Evidence before merge

- Live read-only, same-snapshot, 40-row comparison: first 20-row summary query 1,587 → 468 ms; second 193 → 112 ms, with every returned field equal.
- Live read-only complete membership comparison for five statuses: waiting-packaging 1,256 → 54 ms; waiting-delivery 293 → 214; OGL-bound 126 → 21; OGL-dispatched 6 → 175; delivering 558 → 231. All ID sets identical. These are query measurements, not whole-page latency claims.
- Local regression: 120 passed, one MySQL-only case skipped locally and covered in the independent run. Build, encoding, SQL bindings and frontend safety passed; pre-existing bundle-size / AI-workbench warnings remain.
- Independent socket-only MySQL: full coverage and all count hashes match a frozen e672094 reader in one snapshot for default/customer enterprises; generated facts, rollback, index repair/refusal, summary profit/stock, manual holds, complete status sets and real row-cache write invalidation are covered.
- Real Vue browser regression on the dedicated 8788 port passed: shared-component stock save updates only related orders, preserves unrelated rows and product image DOM, and leaves the order list request count unchanged. The other window's preview was not interrupted.
- A 30,000-demand worker test compares the complete Map and properties with direct calculation and confirms that heavy work yields the API event loop.

## Deployment acceptance

Build only from the exact merged latest release, with expected-production-commit protection. Recheck remote release and production before activation. After rollout, record cold/warm first-page and cross-page samples, concurrent counts, result membership/numeric comparison, artifact hashes and browser interaction. Keep optimizing if the 2-second target / 3-second ceiling is missed; never report isolated SQL improvements as full acceptance.

## Post-rollout follow-up

Release b9e3819 passed 40-row numeric comparison and artifact integrity. Its 15-request concurrency matrix had one 4,108 ms list call; the browser saw 2,022 ms navigation and 3,328 ms next-page API. This did not meet acceptance. Most row APIs were 287–1,540 ms, while full status metadata still took 8,890 ms.

The follow-up keeps raw order JSON out of the summary GROUP BY temporary rows and fetches the same owned source payload after aggregation, before enrichment. Detail readers remain unchanged. A same-snapshot, cache-bypassed live comparison returned identical fields across 40 rows: first summary 1,605 → 148 ms (131 ms aggregation + 9 ms raw read), second 95 → 66 ms. This is query-level evidence only; repeat full browser/API acceptance after rollout.

Status-count keys also include the allocation Map identity. This prevents an older in-flight inventory snapshot from seeding the new revision's derived count cache after an inventory write. A deferred-response regression reproduces the race and verifies that the newer snapshot cannot consume old counts.

Validation: 53 local tests passed, one MySQL-only case covered independently; 11 independent socket-only MySQL cases passed, including large raw payload preservation, foreign-tenant isolation, exact profit/stock fields, count membership and cache invalidation. Encoding, SQL binding and frontend safety checks passed with the existing AI-workbench warning.

## Background contention and startup resource waterfall

Release ca60064 preserved all 40 compared order results and brought targeted stock refresh to 1,527 ms. Its immediate post-start concurrent matrix still had 3–5 second list requests; a subsequent browser run also failed the target. The SQL-only improvement was insufficient under contention.

A read-only comparison with one background query at a time produced six representative foreground calls of 607 / 689 / 1,521 / 933 / 1,470 / 1,147 ms. Limit background scans to one connection while preserving the configured total budget (10 = 9 foreground + 1 background; candidate 4 = 3 + 1). Background completion may take longer; list SQL and accounting remain unchanged. Five independent MySQL cases pass, including saturated-background isolation, transaction rollback/commit, UTC sessions, queue recovery and the normal ten-connection budget.

Browser resource timing also showed a second download wave for OrdersView / OrdersPage dependencies before the first API call. Generate a route- and mode-specific modulepreload graph in the shell, following static imports only. Other routes and detail dialogs remain lazy; no script is executed by the preload. Both preload graph tests pass (cycles, mode boundaries, unsafe/missing paths), the full frontend build passes, and all 47 mode-specific URLs exist. Real Vue stock-save regression passes without replacing product images or reloading the list. Repeat real browser and concurrent API acceptance after this exact merged release is deployed.

## Compact count-only coverage

Release 790252a reduced resource-start delay (first order API at 1,121 ms rather than 3,012 ms) and next-page DOM rendering to 2,030 ms. Cold first rows still took 3,338 ms; the 15-call concurrent matrix still had two >3-second calls. Acceptance remained open.

Count-only requests do not need full per-order receipt/allocation details. Project the exact three queue ID lists inside the existing calculation worker and return an empty Map carrying those lists; ordinary detail/row readers retain complete Maps. Use separate enterprise-scoped cache keys for the two projections. The shared queue predicate derives both forms, preserving overlaps, FBP exclusion, historic missing amounts, and review flags.

Same production read-only snapshot: all three SQL membership predicates exactly equal; full 31,818-order snapshot JSON size 54,021,069 bytes versus compact 28,617 bytes. Read/compute/return measured 7,821 versus 6,120 ms. This is a projection-size/compute measurement, not a page timing claim. Five independent MySQL cases passed, including full/compact equality for default/customer scopes and frozen-release full coverage/count equivalence. Local worker tests cover both 8 and 30,000 demands, plus scoped cache separation. No formula, inventory quantity, SQL accounting rule or UI style changes.

Mobile order first paint previously requested full counts together with rows. It now loads rows without counts, then requests compact metadata independently. Preserve known numbers on metadata failure and show an em dash for unknown numbers; stale responses cannot overwrite a newer filter, and append pagination does not cancel valid metadata. Extend mode-specific preloads to the mobile order route. Eighteen focused local tests and the full frontend build/encoding/SQL checks pass; no mobile layout/style changes.

## Background writer escape from the read budget

Release 9d0807c passed the ordinary concurrent matrix: 15 calls, max/p95 1,424 ms, no >=2-second samples; 40 compared orders equal; targeted inventory refresh 1,083 ms. Its cold browser test during order synchronization still failed (8,797 ms first API; 10,787 ms next-page API). Runtime evidence showed all 9 foreground connections occupied while background order synchronization was running; the single background read limit could not constrain transactions explicitly promoted into the foreground pool.

Keep transaction connections, callback behavior, nested business reads and rollback semantics unchanged. Serialize only transactions initiated in a background workload before promoting each admitted transaction. Foreground and nested transactions bypass this queue; failures do not poison later work, and the tail does not retain transaction return values. The tradeoff is slower concurrent background writers, with foreground capacity preserved.

Validation: 19 focused local tests passed. Six independent socket-only MySQL cases passed: while a background transaction is held, a second remains unstarted and an interactive transaction commits; the held transaction then commits, the queued failure rolls back, and the following background transaction commits. Existing UTC, nested-read, pool isolation and recoverable queue saturation tests also pass. No SQL, accounting arithmetic, transaction reuse or UI styles change. Repeat cold/browser acceptance while normal synchronization is active.

## Single scan and request-local enterprise reads

Release 354b06b made browser next-page rendering 1,697 ms, but cold first rows remained 4,025 ms. Under the next metadata-concurrency run, two calls still exceeded 3 seconds, so acceptance remained open.

Ordinary pagination scanned the same active filter once for COUNT(DISTINCT id) and again for page IDs. A grouped COUNT(*) OVER() now returns the filtered total with the page IDs from one statement. Metadata-only and empty/out-of-range pages retain the count fallback; inventory sort uses its existing full ID count. Add order ID descending as a stable tie-breaker for identical order timestamps (the old pagination plan could select different tied boundary rows).

Same read-only production snapshot, five statuses × first/second/out-of-range pages: all 15 counts and ID sets equal under the stable tie order. Waiting-delivery total+IDs 2,681 → 995 ms and 2,269 → 733 ms; most other probes improved, while one delivering second-page probe regressed (951 → 1,152 ms), reinforcing the need for full post-rollout measurement.

Also memoize the validated enterprise ID/default flag only within one order-list or inventory-read request. Order and logistics scope aliases share the result; the next request always checks active ownership again. No global permission cache is introduced. Unit coverage proves concurrent coalescing, tenant separation, failed-read retry, nested request contexts and revocation on the next request.

Validation: 25 focused local cases passed; 11 independent MySQL cases passed, including pagination with tied timestamps, active print/search/status filters, default/customer ownership, out-of-range totals, manual holds, OGL membership and unchanged numeric profit/stock fields. SQL binding, encoding and syntax checks pass. No layout or accounting formula changes.

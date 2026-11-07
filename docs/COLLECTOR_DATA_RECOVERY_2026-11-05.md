# Collector data recovery investigation

Observed on 2026-11-05, all times below are Beijing time (Asia/Shanghai).

## Confirmed production evidence

- The ECS application service was active. Between 17:06 and 17:09, collector requests repeatedly logged `SELLER_POOL_UNAVAILABLE` (HTTP 409): no usable Seller authorization binding.
- Later binding refresh requests took approximately 4 seconds and saved a timeout with no `last_ok_at`. Some historical bindings already had HTTP 401/403 rejection records. An HTTP 200 from the ERP binding endpoint does not establish a successful Seller authorization.
- A read-only request using the current stored session returned an Ozon HTTP 307 challenge in about 1.2 seconds. Following it with its Set-Cookie value returned HTTP 403 in about 2 seconds total. Automatic redirects without carrying those response cookies failed after about 8 seconds. No binding was written by these probes.
- The production collector source is version 1.4.36. The shared local main checkout was still at 1.4.34, so the isolated plugin repair preserves the 1.4.36 production changes before applying the new fixes. The two affected backend files matched production hashes before editing.

## Repair scope

- Preserve the existing card layout and styles.
- Read Seller cookies for the trusted Seller page URL so applicable parent-domain Ozon cookies are included. Preserve the existing company identity check.
- Let a card with no cached price extract the visible DOM price instead of returning `undefined` early.
- Bound storefront entrypoint fetch and body reading, so a stalled request cannot leave the whole enrichment batch waiting indefinitely.
- Keep the backend authorization probe within one 4-second budget; carry challenge cookies through bounded same-origin redirects and reject login pages and non-JSON responses.
- Admit only bindings with a successful `last_ok_at` into the Seller pool. Saving a cookie or recording a timeout does not establish a usable worker.

## Recovery and release boundaries

An already-rejected session remains rejected after a code fix. The operator must log into the correct Seller company and refresh/rebind authorization, then verify a successful probe and a nonzero verified worker count. Parent-domain cookie omission is a confirmed source defect; it has not been proven to be the only reason Ozon rejected this production session.

### Follow-up: correct shop selected but authorization still fails

At 18:16, ECS had received another browser authorization upload. Its binding check still timed out without `last_ok_at`. A separate read-only probe of that newly stored session returned HTTP 307, then HTTP 403 after carrying the response cookie, within 2.6 seconds. Repeatedly selecting the same shop cannot repair this server request failure. HTTP 403 alone does not prove natural login expiry, a wrong shop, or an ECS egress restriction; identifying an egress-specific restriction requires a successful browser response and a rejected ECS response for the same shop and endpoint.

The analysis extension popup has a separate confirmed defect. Its save handler writes Chrome storage successfully, then waits for the remote heartbeat and `getPanelStatus()` before replying. The status reader also awaits live Seller page identity checks and an unbounded remote heartbeat. Executing the real listener with a hanging heartbeat reproduces `storageWritten=true` and `responseSent=false`. The popup has no message deadline and can remain at saving/reading indefinitely. The goods collector plugin 1.4.37 does not contain the analysis extension; its separate pending repair version is 1.0.41 (`ozon-seller-analytics-plugin-1.0.41.zip`).

The analysis extension repair keeps local saving and status display independent of these remote waits. Live identity checks must continue to gate task claiming, authorization binding, and collection execution; a display snapshot must never authorize a task.

Analysis extension 1.0.41 passed 51 focused tests, including actual message-listener execution with permanently pending remote/identity requests, storage errors, request/body deadlines, late responses, and old-shop display races. A separate reviewer reproduced the passing results. Its HTML and CSS are unchanged. The normal analytics packaging script produced a versioned ZIP and identical alias; all 12 package files match source bytes, and the packaged manifest is 1.0.41. ZIP SHA-256: `BF908D8291C34ADE2D72F94A9787B1E9EBEF82FB805E22774C8844C0ECF2FFD8`.

These popup fixes do not establish that Ozon will accept ECS requests. The operator has already selected the correct shop and refreshed the uploaded session; repeating those steps is not evidence of recovery. The user subsequently installed analysis extension 1.0.41: its 19:02 log reported polling started, and ECS received a ready heartbeat with polling enabled. Later analysis result uploads and a storefront screenshot confirmed data could be retrieved. The remaining reported problem is storefront monthly-sales loading latency. No ECS deployment was performed.

### Follow-up: storefront monthly-sales latency

At 19:13:09, `/api/local-plugin/collector-seller-pool/collect` took 28,979.4 ms; database pool acquisition wait for that request was 0.4 ms. Later requests reported `SELLER_POOL_UNAVAILABLE`. The collector waits for the entire pool batch before trying its browser bridge; the bridge also waits for base/variant details before publishing a product's sales fields.

The pool has a confirmed queue defect: it checked disabled authorization before entering a per-shop serial queue, but not after acquiring the lock. An executed-function fixture with one binding and seven SKUs produced six requests after the first HTTP 403. The repair marks 401/403/429 inside the lock before releasing it and rechecks queued work. The same fixture then makes one rejected request; other healthy shops still process the batch. This mechanism is consistent with the measured delay, but does not prove that it accounts for every millisecond of the production request.

The pending storefront performance package is 1.4.38. Its scope is early sales-only preview updates, a 60-second cooldown for explicitly completed failed pool attempts, and filtering duplicate/recent work before storefront base-data enrichment. Partial previews must not be marked fully collected, persisted, or cached as complete. Unknown timeouts must not be interpreted as completed server work. The authoritative price source, currency handling, and existing request concurrency remain unchanged.

This task performs local code and isolated test/package work only. It does not deploy, restart services, change production configuration, or rewrite production bindings. Fresh explicit user approval is required before an ECS rollout. Integrate this patch into the actual current production release source; do not deploy the older shared main snapshot over newer production work.

The pending plugin version is 1.4.38 (`ozon-baodan-erp-plugin-1.4.38.zip`), superseding the initial local 1.4.37 package. Before calling it released, verify both packaging source manifests, production update metadata, download filename and the manifest inside the downloaded production package all match. The local pending package is not a production release.

## Initial local validation (1.4.37)

- 75 related tests passed across the focused authorization, plugin data recovery, Seller pool, collector fast-add, collector facts, production-log remediation, enterprise plugin access, collector-box isolation, and update-status groups. The collector-facts group used dummy local database configuration only; these tests did not connect to production.
- `npm run check:encoding`, JavaScript syntax checks, and `git diff --check` passed.
- The isolated packaging source and its sibling plugin mirror both contain manifest version 1.4.37. All 19 package files matched the source bytes and the package manifest was 1.4.37. Shared main and its historical top-level plugin copy were left untouched; integrate the isolated source before generating an actual ECS release.
- Package SHA-256: `B160EAAB7CDB98C436748B8057A72A8D951202D525A13BE959E5714170B72020`.
- No local 8788 or ECS service was started, restarted, or deployed. No end-to-end browser extension recovery has been claimed; that requires a valid Seller session and deployment approval.

## Local performance validation (1.4.38)

- 73 focused authorization, queued-worker, preview-latency, collector recovery, fast-add, collector-facts, and version/package tests passed. A separate reviewer also verified the final queue and preview changes.
- Executed-function tests verify that a first rejected binding is requested once for seven queued SKUs; healthy shops still complete the batch. Sales progress is emitted before a deferred base-information response; partial progress neither writes complete cache nor changes the row's current price, title, images, or detail completion state.
- The final source manifest, isolated sibling mirror, and archive manifest all read 1.4.38. All 19 ZIP files match both source copies byte-for-byte. SHA-256: `93D6CCEAB3B316F781A9B0C7BAE1EF35E63ECEC3B1D40C02CA978B270B65856B`.
- This client package can reduce repeat failed-pool waits and publish available sales earlier. The first pool attempt and unverified authoritative price enrichment can still take time. No measured end-to-end speedup in the user's browser is claimed.
- The ECS queue fix remains local and requires integration into the actual current production source followed by fresh rollout approval. No 8788 or ECS deployment/restart was performed. Analysis extension 1.0.41 was not changed during this performance work.

## Browser-worker coordinator (pending 1.4.39)

The user requested a working multi-shop solution after ECS plain HTTP probes succeeded zero times across six saved bindings. Three responses ended in 403 with Ozon challenge fields after 307, and three ended in 401 after 307. A fresh-cookie order control still received a challenge, while a separate official Seller API product-list request succeeded. No probe wrote credentials or changed production configuration. Browser success reported by the user does not prove the plain ECS request has the same execution context.

The implemented approach keeps an embedded bounded queue on ECS and executes actual website requests in verified, already logged-in browser sessions. The product collector, rather than the separate analytics extension, registers live workers, claims one SKU per company, sends sales progress first, and reports normalized final fields. The server authenticates the enterprise token and resolves shop ownership on every worker action. Cookies and raw Ozon response JSON are excluded from job reports. Single-company locks, a six-task enterprise ceiling, leases, limited retry, company cooldown, result limits, incremental polling, and complete-only caching are covered by executed local tests.

The exact read-only production baseline is commit `8d8146ddd9f5463a59113d40048f6b39c1e4c81b`, release `2026.11.05-free-purchase-8d8146d`. Prepare the release candidate on that source so later production features are preserved. Plugin 1.4.39 supersedes the local 1.4.38 package; analytics 1.0.41 is unchanged. There is no mandatory update gate for older plugins.

The candidate has been migrated into a separate worktree based on that exact commit. The server integration adds only the coordinator imports, instance, and post-authentication delegate. Production's existing server routes and storefront fixes are preserved. Read-only Nginx/process inspection found a normal main process and a backup candidate, not active round-robin traffic; failover remains an explicit in-memory queue limitation. No process or Nginx setting was changed.

The remote release branch was independently checked through the GitHub connector: `release/2026.10.21-task-brand` now points to `d0aa54c180546a374c1ea2216f90442e2bdad835`, a descendant of the production baseline. This commit changes none of the collector, analytics, coordinator integration, or project rules files. The final task branch must retain this newer release history before any remote release merge and build.

Local HTTP fixtures use only `127.0.0.1:8788` and close their server afterwards. Their Ozon responses and Chrome session boundaries are synthetic; they establish dispatch and result handling, not live Ozon acceptance or a measured production speedup. Actual two-company browser verification and production download/version checks remain release acceptance work. No ECS deployment, restart, or configuration change is authorized or performed by this implementation step.

### Final local candidate verification

- All 169 focused recovery, queue, worker, HTTP, shop ownership, facts, token isolation, analytics popup, compatibility, and package tests passed. Facts imports use dummy local database configuration; these tests do not connect to production. UTF-8, SQL binding, JavaScript syntax, and diff checks passed.
- Executed HTTP tests include two distinct companies, duplicate tabs of one company, partial-before-final display, a worker restart, complete cache reuse, no requery of completed SKUs, unknown accepted-create responses, and polling failures. Identity-unavailable and confirmed store-conflict results stay distinct.
- The 1.4.39 source, isolated sibling mirror, and ZIP agree. All 20 files match byte-for-byte. Package: `ozon-baodan-erp-plugin-1.4.39.zip`; SHA-256: `97955C31F39057DC77A6C2E54F7C8D7A00172AF1DD0979F37BF9068D57CCE3F4`.
- Only temporary HTTP test listeners on local 8788 were started and closed. No ERP service was deployed/restarted locally or on ECS. The package remains a local candidate until production source merge, approved rollout, metadata/download checks, and live browser acceptance.

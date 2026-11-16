# Inventory capital list performance and fixed pagination

Base: release/2026.10.21-task-brand at d1d9df6956c8737f5bad80dd8101e75291f9968b.

## Changes

- Batch stocktake and purchase backfill actions move beside search in the upper-right control group. Existing permission gates and selection behavior remain.
- Desktop list uses a bounded flex layout with an Element Plus table scrollport. Header and pagination remain outside the body scroll area. Page size supports 20/50/100, resetting to page one on filter or size changes. Mobile cards retain their previous layout.
- Local stock state and historical purchase gaps share one tenant procurement coverage load instead of independently rebuilding it twice.
- The UI opts into a 20-second list snapshot through reuse_snapshot=1. Its bounded existing master-data cache key includes resolved enterprise ID, default-enterprise mode and workflow revision. Filtering/search/paging operate on the shared read snapshot. Ordinary finance API callers remain fresh by default; financial writers and mutation previews do not use this cache.
- Master-data invalidations and workflow revisions invalidate reuse; explicit refresh=1 and post-save UI reloads force a new snapshot. Existing cache in-flight invalidation safeguards prevent an old request from overwriting a newer fill. Snapshot timestamps reflect computation time. Periodic refresh does not clear a nonempty selection.

## Evidence

- Isolated MySQL: initial list requires 26 SQL acquisitions; warm filter/page requests require 2, with identical totals. Tests cover enterprise separation, workflow invalidation, manual force-refresh and legacy finance/inventory behavior.
- Ego-browser fixture with 150 records: 50 rows on first page; header top remained 303px and pagination bottom remained 1186px after body scrollTop=2000. Selecting 100/page and page two produced records 101–150. Filter reset to page one, empty results, selection and force-refresh query were verified.
- 1280×720 viewport: document height=720px and footer bottom=697px; no outer-page vertical scrolling. Search and batch controls share query-actions. Production Chinese pagination locale verified in preview.
- New code is not deployed; no inventory quantities, purchase records, costs or profits changed.

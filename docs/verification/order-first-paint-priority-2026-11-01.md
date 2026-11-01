# Order first-paint priority repair — 2026-11-01

## Reproduction and scope

Production version `2026.11.01-order-query-f943855` was observed in the authenticated browser: roughly 11.8 seconds from navigation to 20 visible orders. `/api/orders?includeCounts=0` took 10.354 seconds; preferences took 297 ms and sync metadata 458 ms. The order request started after those auxiliary requests. Prior production diagnostics also showed the shared 10-connection pool saturated by scheduled advertising/OGL work and long acquisition waits. Query-only improvements therefore did not establish fast end-to-end opening under background load.

Task started from release `9677df1cbf302819cc038c6194c9e3ecefab2e2d`, then rebased onto `6be246c27df54e88d6a86ee7be626693500ed1d0` to retain the finance window's PR #67. This repair changes neither profit formulas nor inventory allocation arithmetic.

## Repair

- Start order loading immediately while toolbar preferences and sync metadata load independently. Deep links retain their existing bootstrap.
- Divide the existing MySQL connection budget into foreground and background pools: normal budget 10 becomes 7 + 3; deployment candidate budget 4 becomes 3 + 1. Single-connection configurations keep their shared connection. No additional total connections are introduced.
- Use asynchronous request context for scheduled tasks, full order-count reads and initial inventory hydration. Interactive page reads and user-triggered inventory row refreshes keep foreground priority. Tenant arguments and SQL scopes remain unchanged.
- Keep lock-holding business transactions and nested reads in the foreground pool to avoid background transaction starvation; transaction commit/rollback and UTC session setup remain intact. Long background reads can still consume database CPU, so this is resource isolation, not a guaranteed response-time bound.
- Expose foreground/background active counts and budgets in existing performance and health logs. Existing job deferral and bounded critical-job execution remain in place.

## Validation

- 52 focused local tests passed, including async-context isolation, auxiliary-endpoint delays/failure, deep-link bootstrap, service classification, cross-enterprise session/cache isolation, inventory hydration/local refresh, scheduler fairness, deadlock retry and concurrent finance changes.
- Frontend production build, frontend safety and UTF-8 encoding checks passed. Existing large-chunk and AI-workbench safety warnings remain.
- Independent socket-only MySQL tests cover a deliberately saturated background connection, foreground progress before releasing it, connection-budget preservation, session UTC, nested transaction reads, rollback/commit, pool shutdown/reopen, recoverable queue overflow, read-committed analytics and order-summary numeric/tenant equivalence.
- Full local browser regression remains pending while another window owns port 8788 (`work/finance-overview-performance`). Its preview was not stopped. The first-paint lifecycle itself was executed with deliberately unresolved auxiliary promises in the focused regression.
- These changes are not yet deployed. Production latency must be remeasured after an explicitly approved deployment, with both quiet and background-active samples; do not treat isolated database tests as a production speed claim.

# Scheduled transaction read admission

The order performance target remains below two seconds. Release 1cb7472 did not meet it: the desktop browser recorded 3,477 ms to the first twenty rows and 2,588 ms for paging, including inline inventory facts. These are failures, not acceptance results.

A scheduled transaction already had serialized admission, but its nested global reads could still fill the foreground connection pool. Limit that fan-out before acquiring connections. Keep the scheduled transaction's read queue separate from ordinary background scans so a transaction holding row locks does not wait behind the scan backlog. Interactive requests remain outside both queues. Transaction connection reuse, commit, rollback, accounting queries, and profit formulas are unchanged.

Validation: 64 focused local checks passed. Nine existing isolated MySQL checks passed, including transaction commit/rollback and background scan admission. The additional isolated MySQL test passed after correcting its fixture database prefix: with two foreground connections, a user query overtakes twelve scheduled nested reads and the transaction marker commits. The test uses synthetic data in a socket-only test instance, not production. UTF-8 and diff whitespace checks passed.

Deployment requires the exact merged release artifact and another desktop/mobile/API timing run. No database buffer-pool setting is changed by this patch. The proposed online 128-to-512 MiB trial remains subject to explicit user approval.

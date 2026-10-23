# Read-only capture before a reviewed historical repair

`scripts/capture-reviewed-combined-plan.mjs` captures a fresh maintenance snapshot for the existing combined repair tool. It does not repair data or approve production changes. Do not import it into the application.

First capture a per-column native SHA256 proof from the isolated, reviewed backup. The proof contains row IDs and hashes, not raw customer text or media. Its scope fingerprint binds the exact link corrections, explicit duplicate groups and keepers, and any reviewed unchanged-reference exception.

```sh
node scripts/capture-reviewed-combined-plan.mjs --mode=baseline \
  --mysql-admin-socket=EXPLICIT_ISOLATED_SOCKET --database=REVIEWED_BACKUP_DB \
  --plan=reviewed-plan.json --output=new-column-proof.json
```

After operators and background writers are stopped, capture the frozen production source using the same reviewed plan and baseline proof. Use fresh output paths; the CLI never overwrites input or existing output files.

```sh
node scripts/capture-reviewed-combined-plan.mjs --mode=capture \
  --mysql-admin-socket=EXPLICIT_ADMIN_SOCKET --database=BUSINESS_DB \
  --plan=reviewed-plan.json --baseline=new-column-proof.json \
  --output=fresh-candidate.json --report=fresh-report.json \
  --source-kind=production_maintenance_snapshot --maintenance-confirmed
```

Capture uses one read-only consistent transaction. It preserves all reviewed before/after values, row hashes, keepers, differing-column decisions and business confirmations. It refuses changed or missing reviewed rows, new or missing duplicate groups, ambiguous original-shop parent candidates, changed enterprise ownership and changed unchanged-reference exceptions. Changed business timestamps are reported by column name and never silently accepted. A mismatch produces a report without a new candidate; an administrator must inspect the fresh facts and explicitly revise the reviewed input before another capture.

Fresh native fingerprints and complete DDL for the existing fifteen-table guard scope, including read-only parent dependencies, are recorded for review. The reference digest is calculated from current exact reference rows with only the reviewed field projection. Natural-key grouping reads the clustered primary key and uses MySQL collation weights, not the damaged secondary indexes.

Every candidate resets top-level `production_approved` to boolean `false`, clears previous approval metadata, and requires a separate final reviewer decision. A previously approved input cannot confer approval on a new capture. The combined production prepare/install commands require a reviewer to set boolean `production_approved: true` on the exact final reviewed manifest; capture never does this.

On the 2026-10-23 full historical backup, the read-only capture checked 889,874 history rows plus the other two target scopes in approximately 26 seconds with a measured process RSS peak near 403 MiB on the isolated Windows instance. This is evidence for sizing, not a guaranteed production runtime. The report records elapsed time and peak RSS for each real capture. Keep the frozen maintenance window in place until review, preparation, installation and validation finish.

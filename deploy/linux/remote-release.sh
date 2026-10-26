#!/usr/bin/env bash
set -Eeuo pipefail

archive_path="${1:-}"
release_version="${2:-}"
run_db_init="${3:-1}"
run_db_maintenance="${4:-1}"
reviewed_identity_manifest="${5:-}"
reviewed_ai_material_manifest="${6:-}"
allow_service_interruption="${7:-0}"
material_change_required="ready"
candidate_warmup_seconds=360
rollback_warmup_seconds=360
candidate_ready=0
primary_changed=0
app_root="/opt/ozon-erp"
releases_root="$app_root/releases"
shared_root="$app_root/shared"
current_link="$app_root/current"
env_file="/etc/ozon-erp/ozon-erp.env"
candidate_port="3001"
candidate_pid=""
candidate_log="/tmp/ozon-erp-candidate-${release_version}.log"
candidate_pid_file="/tmp/ozon-erp-candidate.pid"
release_lock_file="/var/lock/ozon-erp-release.lock"

cleanup_material_manifest() {
  if [[ "$reviewed_ai_material_manifest" =~ ^/tmp/ozon-erp-ai-material-[0-9A-Za-z._-]+\.json$ ]]; then
    rm -f -- "$reviewed_ai_material_manifest"
  fi
}
trap cleanup_material_manifest EXIT

if [[ -z "$archive_path" || -z "$release_version" ]]; then
  echo "Usage: remote-release.sh <archive.zip> <version> [run-db-init:1|0] [run-db-maintenance:1|0] [reviewed-identity-manifest] [reviewed-ai-material-manifest] [allow-service-interruption:1|0]" >&2
  exit 2
fi
if [[ ! -f "$archive_path" ]]; then
  echo "Release archive not found: $archive_path" >&2
  exit 2
fi
if [[ ! -s "$env_file" ]]; then
  echo "Server environment file not found: $env_file" >&2
  exit 2
fi
if [[ ! "$release_version" =~ ^[0-9A-Za-z._-]+$ ]]; then
  echo "Invalid release version: $release_version" >&2
  exit 2
fi
if [[ "$run_db_maintenance" != "0" && "$run_db_maintenance" != "1" ]]; then
  echo "Invalid database maintenance flag: $run_db_maintenance" >&2
  exit 2
fi
if [[ "$allow_service_interruption" != "0" && "$allow_service_interruption" != "1" ]]; then
  echo "Invalid service interruption flag: $allow_service_interruption" >&2
  exit 2
fi
if [[ -n "$reviewed_identity_manifest" && (! -f "$reviewed_identity_manifest" || ! -s "$reviewed_identity_manifest") ]]; then
  echo "Reviewed identity manifest not found or empty: $reviewed_identity_manifest" >&2
  exit 2
fi
if [[ -n "$reviewed_ai_material_manifest" ]]; then
  if [[ ! "$reviewed_ai_material_manifest" =~ ^/tmp/ozon-erp-ai-material-[0-9A-Za-z._-]+\.json$ || -L "$reviewed_ai_material_manifest" || ! -s "$reviewed_ai_material_manifest" ]]; then
    echo "Reviewed AI material manifest must be a private uploaded temporary file." >&2
    exit 2
  fi
  chmod 600 "$reviewed_ai_material_manifest"
fi

# ECS has one shared current release link and one blue/green candidate port.
# A second release must fail before touching either, rather than racing a live
# database initialization or rolling another release back.
exec 9>"$release_lock_file"
if ! flock -n 9; then
  echo "Another ECS release is already active; wait for it to finish before deploying." >&2
  exit 75
fi

release_dir="$releases_root/$release_version"
staging_dir="$releases_root/.${release_version}.staging"
previous_target=""
previous_version=""
if [[ -L "$current_link" ]]; then
  previous_target="$(readlink -f "$current_link" || true)"
  previous_version="$(node -e 'try { process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version || ""); } catch {}' "$previous_target/public/release.json")"
fi

rollback() {
  local exit_code=$?
  trap - ERR
  if [[ $exit_code -eq 0 ]]; then
    return
  fi
  echo "Release failed; attempting rollback." >&2
  if [[ "$primary_changed" != "1" ]]; then
    # A failed install, preflight or cold candidate has not changed the primary.
    # Restarting it here would turn a harmless rejected release into an outage.
    if [[ -n "$candidate_pid" ]]; then
      kill "$candidate_pid" 2>/dev/null || true
      rm -f "$candidate_pid_file"
    fi
    echo "Primary was not changed; existing service remains running." >&2
  elif [[ -n "$previous_target" && -d "$previous_target" ]]; then
    if [[ "$candidate_ready" != "1" && -n "$candidate_pid" ]]; then
      kill "$candidate_pid" 2>/dev/null || true
      rm -f "$candidate_pid_file"
      candidate_pid=""
    fi
    ln -sfn "$previous_target" "$current_link"
    # Keep the verified candidate available to Nginx while the old primary
    # performs its own cold start. Never kill the only known healthy process.
    if systemctl restart ozon-erp && wait_for_release 3000 "$previous_version" "$rollback_warmup_seconds"; then
      echo "Rollback restored and ready: $previous_target" >&2
      # Nginx may still remember the primary's failure for fail_timeout. Keep
      # the validated candidate as hot backup until the next release replaces it.
      candidate_pid=""
    else
      echo "Rollback primary is not ready; retaining the candidate for failover and investigation." >&2
    fi
  fi
  exit "$exit_code"
}
trap rollback ERR

assert_release_interruption_policy() {
  if [[ "$allow_service_interruption" != "1" && ("$material_change_required" == "change" || -n "$reviewed_identity_manifest") ]]; then
    echo "Release requires stopping legacy writers for reviewed ownership/identity changes. Existing services were left running. Schedule explicit maintenance with --allow-service-interruption; a normal release cannot perform this stop." >&2
    return 1
  fi
}

wait_for_release() {
  local port="$1" expected_version="$2" budget_seconds="$3" pid="${4:-}"
  local deadline=$((SECONDS + budget_seconds))
  while ((SECONDS < deadline)); do
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      echo "Release process exited before readiness." >&2
      return 1
    fi
    local remaining=$((deadline - SECONDS)) request_timeout=5
    ((remaining < request_timeout)) && request_timeout=$remaining
    local status
    status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$request_timeout" "http://127.0.0.1:${port}/api/ready" || true)"
    local actual_version=""
    if [[ "$status" == "200" && -n "$expected_version" ]]; then
      remaining=$((deadline - SECONDS))
      ((remaining > 0)) || break
      request_timeout=5
      ((remaining < request_timeout)) && request_timeout=$remaining
      actual_version="$(curl -fsS --max-time "$request_timeout" "http://127.0.0.1:${port}/release.json" | node -e 'let text="";process.stdin.on("data", c => text+=c);process.stdin.on("end", () => { try { process.stdout.write(JSON.parse(text).version || ""); } catch {} });' || true)"
    fi
    if [[ "$status" == "200" && ( -z "$expected_version" || "$actual_version" == "$expected_version" ) ]]; then
      return 0
    fi
    remaining=$((deadline - SECONDS))
    ((remaining > 0)) || break
    local pause_seconds=2
    ((remaining < pause_seconds)) && pause_seconds=$remaining
    sleep "$pause_seconds"
  done
  return 1
}

configure_nginx_failover() {
  local upstream_file="/etc/nginx/conf.d/ozon-erp-upstream.conf"
  if [[ ! -f "$upstream_file" ]]; then
    cat > "$upstream_file" <<'EOF'
upstream ozon_erp_backend {
    server 127.0.0.1:3000;
    server 127.0.0.1:3001 backup;
    keepalive 32;
}
EOF
  fi

  local changed=0
  while IFS= read -r enabled_file; do
    [[ -n "$enabled_file" ]] || continue
    local config_file
    config_file="$(readlink -f "$enabled_file" || true)"
    [[ -f "$config_file" ]] || continue
    if grep -qF 'proxy_pass http://127.0.0.1:3000;' "$config_file"; then
      cp -a "$config_file" "${config_file}.before-blue-green"
      sed -i 's#proxy_pass http://127\.0\.0\.1:3000;#proxy_pass http://ozon_erp_backend;#g' "$config_file"
      changed=1
    fi
  done < <(grep -RIl 'proxy_pass http://127.0.0.1:3000;' /etc/nginx/sites-enabled 2>/dev/null || true)

  if ! nginx -t; then
    find /etc/nginx/sites-available -maxdepth 1 -type f -name '*.before-blue-green' -print0 \
      | while IFS= read -r -d '' backup; do cp -a "$backup" "${backup%.before-blue-green}"; done
    rm -f "$upstream_file"
    nginx -t
    echo "Nginx failover configuration validation failed." >&2
    return 1
  fi
  if [[ "$changed" == "1" ]]; then
    systemctl reload nginx
  fi
}

stop_existing_candidate() {
  if [[ -f "$candidate_pid_file" ]]; then
    local old_candidate_pid
    old_candidate_pid="$(cat "$candidate_pid_file" 2>/dev/null || true)"
    if [[ "$old_candidate_pid" =~ ^[0-9]+$ ]] && ((old_candidate_pid > 1)) && kill -0 "$old_candidate_pid" 2>/dev/null; then
      local old_candidate_cwd
      old_candidate_cwd="$(readlink -f "/proc/$old_candidate_pid/cwd" || true)"
      if [[ "$old_candidate_cwd" != "$releases_root/"* ]] || ! grep -zFxq 'DEPLOYMENT_CANDIDATE=1' "/proc/$old_candidate_pid/environ"; then
        echo "Refusing to stop a PID that is not a recorded ERP candidate." >&2
        return 1
      fi
      kill "$old_candidate_pid" 2>/dev/null || true
      for _ in {1..30}; do
        kill -0 "$old_candidate_pid" 2>/dev/null || break
        sleep 1
      done
      if kill -0 "$old_candidate_pid" 2>/dev/null; then
        echo "Previous candidate did not stop." >&2
        return 1
      fi
    fi
    rm -f "$candidate_pid_file"
  fi
}

# Read-only, before backup or stopping a service. No unreviewed historical row
# may disappear into quarantine as an incidental effect of a normal release.
material_optimization_preflight() {
  set -a
  source "$env_file"
  set +a
  (cd "$staging_dir" && node --input-type=module - "$DB_NAME" "$reviewed_ai_material_manifest" <<'NODE'
import fs from "node:fs/promises";
import mysql from "mysql2/promise";
import { migrateTenantAiMaterialOptimization } from "./scripts/migrate-tenant-ai-material-optimization.mjs";
const [database, manifestPath] = process.argv.slice(2);
if (!database) throw new Error("Explicit deployment database is required for AI material preflight.");
const connection = await mysql.createConnection({ socketPath: "/var/run/mysqld/mysqld.sock", user: "root", database });
try {
  let reviewManifest = null;
  if (manifestPath) {
    try { reviewManifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); }
    catch { throw new Error("Reviewed AI material manifest is not valid JSON."); }
  }
  const report = await migrateTenantAiMaterialOptimization(connection, { reviewManifest });
  if (report.review.length) throw new Error("AI material ownership requires an explicit complete reviewed manifest; no historical rows were changed.");
  const changed = report.reviewed_batches.length > 0 || report.tables.some(table => table.create || table.change_tenant_definition
    || table.add_checkpoint || table.add_review_metadata || table.replace_unique || table.remove_unscoped_unique_indexes?.length);
  if (changed) for (const table of ["ai_material_optimization_batches", "ai_material_optimization_items"]) {
    const [exists] = await connection.execute("SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?", [table]);
    if (!exists.length) continue;
    const [[active]] = await connection.query(`SELECT COUNT(*) n FROM ${table} WHERE status IN ('queued', 'running')`);
    if (Number(active.n)) throw new Error("AI material jobs are queued or running; let existing jobs finish before retrying this release. No task was cancelled.");
  }
  process.stdout.write(changed ? "change" : "ready");
} finally { await connection.end(); }
NODE
  )
}

backup_database() {
  local backup_dir="$shared_root/backups/identity-releases"
  local backup_path="$backup_dir/pre-release-${release_version}-$(date -u '+%Y%m%dT%H%M%SZ')-$$.sql.gz"
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
  : "${DB_NAME:?DB_NAME is required for the pre-release database backup}"
  install -d -m 700 "$backup_dir"
  (
    umask 077
    mysqldump --protocol=SOCKET --socket=/var/run/mysqld/mysqld.sock --user=root \
      --single-transaction --routines --triggers --events --hex-blob --set-gtid-purged=OFF \
      --databases "$DB_NAME" | gzip > "$backup_path.partial"
  )
  gzip -t "$backup_path.partial"
  chmod 600 "$backup_path.partial"
  mv "$backup_path.partial" "$backup_path"
  echo "Pre-release database backup verified: $backup_path"
  local private_results_root="${AI_CREDIT_RESULT_ROOT:-$shared_root/private-ai-results}"
  if [[ -f "$staging_dir/scripts/backup-private-ai-results.mjs" ]]; then
    if [[ ! -d "$private_results_root" || -L "$private_results_root" ]]; then
      echo "Private AI result directory is missing or linked; refusing an unpaired database backup." >&2
      return 1
    fi
    (cd "$staging_dir" && node scripts/backup-private-ai-results.mjs --root="$private_results_root" --output="${backup_path%.sql.gz}.ai-results.jsonl.gz")
  fi
}

start_candidate() {
  stop_existing_candidate
  rm -f "$candidate_log"
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
  runuser -u ozon-erp -- bash -lc "
    cd '$release_dir'
    exec 9>&-
    nohup env PORT='$candidate_port' HOST='127.0.0.1' SCHEDULED_JOBS_ENABLED='false' DEPLOYMENT_CANDIDATE='1' NODE_ENV='production' NODE_OPTIONS='--max-old-space-size=384' /usr/bin/node src/server.js >'$candidate_log' 2>&1 &
    echo \$! >'$candidate_pid_file'
  "
  candidate_pid="$(cat "$candidate_pid_file")"

  # The primary continues serving throughout normal cold-start warmup.
  if ! wait_for_release "$candidate_port" "$release_version" "$candidate_warmup_seconds" "$candidate_pid"; then
    cat "$candidate_log" >&2 || true
    echo "Candidate process did not become ready." >&2
    return 1
  fi
  candidate_ready=1
}

install -d -o ozon-erp -g ozon-erp "$releases_root" "$shared_root/uploads/public" "$shared_root/uploads/runtime"
install -d -m 700 -o ozon-erp -g ozon-erp "$shared_root/private-ai-results"
rm -rf "$staging_dir"
install -d -o ozon-erp -g ozon-erp "$staging_dir"
unzip -q "$archive_path" -d "$staging_dir"

if [[ ! -f "$staging_dir/package.json" || ! -f "$staging_dir/src/server.js" ]]; then
  echo "Archive is not an Ozon ERP deploy artifact." >&2
  exit 3
fi

chown -R ozon-erp:ozon-erp "$staging_dir"
runuser -u ozon-erp -- bash -lc "cd '$staging_dir' && npm ci --omit=dev --include=optional"

if [[ -f "$staging_dir/scripts/migrate-tenant-ai-material-optimization.mjs" ]]; then
  if ! material_change_required="$(material_optimization_preflight)"; then
    echo "AI material preflight refused this release; existing services were left running." >&2
    exit 1
  fi
elif [[ -n "$reviewed_ai_material_manifest" ]]; then
  echo "This release does not contain the reviewed AI material migration." >&2
  exit 1
fi
assert_release_interruption_policy

if [[ "$run_db_maintenance" == "1" || -n "$reviewed_identity_manifest" || -f "$staging_dir/scripts/migrate-order-profit-calculation-versions.mjs" || -f "$staging_dir/scripts/migrate-ai-variant-draft-history-index.mjs" || -f "$staging_dir/scripts/migrate-ogl-dispatch-schema.mjs" || -f "$staging_dir/scripts/migrate-enterprise-messages.mjs" || -f "$staging_dir/scripts/migrate-subscription-vouchers.mjs" || -f "$staging_dir/scripts/migrate-tenant-ai-material-optimization.mjs" || -f "$staging_dir/scripts/migrate-ai-credits.mjs" || -f "$staging_dir/scripts/migrate-listing-frozen-content.mjs" || -f "$staging_dir/scripts/migrate-listing-draft-list-indexes.mjs" || -f "$staging_dir/scripts/migrate-order-search-indexes.mjs" ]]; then
  backup_database
fi

# Additive performance/reader/credit schemas are installed before candidate
# readiness even when broad maintenance is skipped. These scripts do not enrol
# an enterprise, set a price, opt in a writer or repair/delete legacy rows.
for additive_migration in migrate-order-search-indexes.mjs migrate-listing-draft-list-indexes.mjs migrate-listing-frozen-content.mjs migrate-ai-credits.mjs migrate-order-profit-daily-fx.mjs migrate-order-profit-fx-policy.mjs; do
  if [[ ! -f "$staging_dir/scripts/$additive_migration" ]]; then continue; fi
  set -a
  source "$env_file"
  set +a
  (cd "$staging_dir" && node "scripts/$additive_migration" --database="$DB_NAME" --mysql-admin-socket=/var/run/mysqld/mysqld.sock)
  (cd "$staging_dir" && node "scripts/$additive_migration" --apply --database="$DB_NAME" --mysql-admin-socket=/var/run/mysqld/mysqld.sock)
done

# Order, procurement and inventory SQL depend on the new OGL evidence tables.
# Create and verify them before any maintenance readers, even with skip enabled.
if [[ -f "$staging_dir/scripts/migrate-ogl-dispatch-schema.mjs" ]]; then
  set -a
  source "$env_file"
  set +a
  (cd "$staging_dir" && node scripts/migrate-ogl-dispatch-schema.mjs --database="$DB_NAME" --mysql-admin-socket=/var/run/mysqld/mysqld.sock)
  (cd "$staging_dir" && node scripts/migrate-ogl-dispatch-schema.mjs --apply --database="$DB_NAME" --mysql-admin-socket=/var/run/mysqld/mysqld.sock)
fi

if [[ "$run_db_maintenance" == "1" && "$run_db_init" == "1" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
  (cd "$staging_dir" && npm run db:init:mysql)
fi

# These additive schemas are required by the candidate's membership and people
# APIs, even when ordinary maintenance is skipped. Never classify people here.
for membership_schema in migrate-enterprise-messages.mjs migrate-subscription-vouchers.mjs; do
  if [[ ! -f "$staging_dir/scripts/$membership_schema" ]]; then
    continue
  fi
  set -a
  source "$env_file"
  set +a
  (cd "$staging_dir" && node "scripts/$membership_schema" --mysql-admin-socket=/var/run/mysqld/mysqld.sock)
  (cd "$staging_dir" && node "scripts/$membership_schema" --apply --mysql-admin-socket=/var/run/mysqld/mysqld.sock)
done

# Tenant-aware order sync and inventory binding require these ownership columns.
# Existing installations need explicit, idempotent migrations because CREATE TABLE
# IF NOT EXISTS cannot add ownership columns to legacy tables.
install -d -o ozon-erp -g ozon-erp "$staging_dir/public"
if [[ "$run_db_maintenance" == "1" ]]; then
for tenant_migration in \
  migrate-tenant-products-ownership.mjs \
  migrate-tenant-suppliers.mjs \
  migrate-tenant-product-relations.mjs \
  migrate-tenant-sku-mappings.mjs \
  migrate-tenant-logistics-rules.mjs \
  migrate-tenant-asset-variant-config.mjs \
  migrate-tenant-finance-center.mjs \
  migrate-tenant-inventory-procurement.mjs; do
  if [[ ! -f "$staging_dir/scripts/$tenant_migration" ]]; then
    continue
  fi
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
  migration_args=(--apply --mysql-admin-socket=/var/run/mysqld/mysqld.sock)
  if [[ "$tenant_migration" == "migrate-tenant-inventory-procurement.mjs" ]]; then
    migration_args+=(--assign-legacy-platform-default)
  fi
  (cd "$staging_dir" && node "scripts/$tenant_migration" "${migration_args[@]}")
done

# Explicit database selection and a read-only plan precede the task ownership DDL.
for tenant_task_migration in migrate-tenant-team-tasks.mjs migrate-tenant-order-heatmap.mjs migrate-tenant-material-assets.mjs migrate-tenant-system-notifications.mjs migrate-tenant-customer-messages.mjs migrate-tenant-vehicle-catalog.mjs; do
  if [[ -f "$staging_dir/scripts/$tenant_task_migration" ]]; then
    task_migration_args=()
    if [[ "$tenant_task_migration" == "migrate-tenant-customer-messages.mjs" ]]; then
      task_migration_args+=(--assign-legacy-customer-default)
    fi
    (cd "$staging_dir" && node "scripts/$tenant_task_migration" --database="$DB_NAME" --mysql-admin-socket=/var/run/mysqld/mysqld.sock)
    (cd "$staging_dir" && node "scripts/$tenant_task_migration" --apply --database="$DB_NAME" --mysql-admin-socket=/var/run/mysqld/mysqld.sock "${task_migration_args[@]}")
  fi
done

# Pilot business boundaries are verified before changing the active release.
# The private-file migration never creates memberships or guesses customer ownership.
(cd "$staging_dir" && node scripts/migrate-tenant-ai-background.mjs --database="$DB_NAME" --mysql-admin-socket=/var/run/mysqld/mysqld.sock)
(cd "$staging_dir" && node scripts/migrate-tenant-ai-background.mjs --apply --database="$DB_NAME" --mysql-admin-socket=/var/run/mysqld/mysqld.sock)
(cd "$staging_dir" && node scripts/migrate-tenant-private-files.mjs --mysql-admin-socket=/var/run/mysqld/mysqld.sock \
  --legacy-root="$shared_root/uploads/runtime/team-attachments" --legacy-root="$shared_root/uploads/public/team-attachments")
(cd "$staging_dir" && node scripts/migrate-tenant-private-files.mjs --apply --backfill-legacy-default --mysql-admin-socket=/var/run/mysqld/mysqld.sock \
  --legacy-root="$shared_root/uploads/runtime/team-attachments" --legacy-root="$shared_root/uploads/public/team-attachments")

if [[ "$run_db_init" == "1" && -f "$staging_dir/scripts/apply-ogl-rates.mjs" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
  (cd "$staging_dir" && node scripts/apply-ogl-rates.mjs --apply)
fi

if [[ -f "$staging_dir/scripts/init-inventory-numbering.mjs" ]]; then
  set -a
  source "$env_file"
  set +a
  (cd "$staging_dir" && node scripts/init-inventory-numbering.mjs --mysql-admin-socket=/var/run/mysqld/mysqld.sock)
fi

if [[ -f "$staging_dir/scripts/init-order-query-facts.mjs" ]]; then
  set -a
  source "$env_file"
  set +a
  (cd "$staging_dir" && node scripts/init-order-query-facts.mjs --mysql-admin-socket=/var/run/mysqld/mysqld.sock)
fi
else
  echo "Skipping database maintenance for $release_version"
fi

# Case target history requires this additive index before candidate readiness,
# including releases that skip broad database maintenance. The backup above is
# mandatory whenever this migration is packaged.
if [[ -f "$staging_dir/scripts/migrate-ai-variant-draft-history-index.mjs" ]]; then
  set -a
  source "$env_file"
  set +a
  (cd "$staging_dir" && node scripts/migrate-ai-variant-draft-history-index.mjs --database="$DB_NAME" --mysql-admin-socket=/var/run/mysqld/mysqld.sock)
  (cd "$staging_dir" && node scripts/migrate-ai-variant-draft-history-index.mjs --apply --database="$DB_NAME" --mysql-admin-socket=/var/run/mysqld/mysqld.sock)
fi

# Material jobs must have reviewed ownership before the new worker is started.
# This does not run the unrelated historical inventory/unique-key repair.
if [[ -f "$staging_dir/scripts/migrate-tenant-ai-material-optimization.mjs" && "$material_change_required" == "change" ]]; then
  # No active job was cancelled or waited on. Stop both old writers only when
  # material ownership/schema actually changes, then close the preflight race.
  stop_existing_candidate
  primary_changed=1
  systemctl stop ozon-erp
  if ! material_change_required="$(material_optimization_preflight)"; then
    echo "AI material preflight changed after stopping old writers; restoring the previous service." >&2
    false
  fi
  set -a
  source "$env_file"
  set +a
  material_migration_args=(--database="$DB_NAME" --mysql-admin-socket=/var/run/mysqld/mysqld.sock)
  if [[ -n "$reviewed_ai_material_manifest" ]]; then
    material_migration_args+=(--review-manifest="$reviewed_ai_material_manifest")
  fi
  if ! (cd "$staging_dir" && node scripts/migrate-tenant-ai-material-optimization.mjs --apply "${material_migration_args[@]}" >/dev/null); then
    echo "Reviewed AI material migration failed; restoring the previous service." >&2
    false
  fi
  echo "Reviewed AI material schema and ownership migration verified."
fi

# This additive schema is required even when broad maintenance is disabled.
# Baseline copying is a separate, explicit operation after the new writer is live.
if [[ -f "$staging_dir/scripts/migrate-order-profit-calculation-versions.mjs" ]]; then
  set -a
  source "$env_file"
  set +a
  (cd "$staging_dir" && node scripts/migrate-order-profit-calculation-versions.mjs --write --create-schema --schema-only --allow-concurrent-writers)
fi

rm -rf "$staging_dir/public/uploads" "$staging_dir/uploads"
ln -s "$shared_root/uploads/public" "$staging_dir/public/uploads"
ln -s "$shared_root/uploads/runtime" "$staging_dir/uploads"
install -d -o ozon-erp -g ozon-erp "$staging_dir/data"
if [[ -e "$staging_dir/data/ai-credit-results" || -L "$staging_dir/data/ai-credit-results" ]]; then
  echo "Deploy archives must not contain private AI result data." >&2
  exit 3
fi
ln -s "$shared_root/private-ai-results" "$staging_dir/data/ai-credit-results"

if [[ -e "$release_dir" ]]; then
  echo "Release already exists: $release_dir" >&2
  exit 3
fi
mv "$staging_dir" "$release_dir"
chown -R ozon-erp:ozon-erp "$release_dir"
configure_nginx_failover
if [[ -n "$reviewed_identity_manifest" ]]; then
  chmod 600 "$reviewed_identity_manifest"
  stop_existing_candidate
  primary_changed=1
  systemctl stop ozon-erp
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
  (cd "$release_dir" && node scripts/migrate-platform-enterprise-identities.mjs --manifest="$reviewed_identity_manifest")
  (cd "$release_dir" && node scripts/migrate-platform-enterprise-identities.mjs --apply --manifest="$reviewed_identity_manifest" --mysql-admin-socket=/var/run/mysqld/mysqld.sock)
fi
start_candidate
ln -sfn "$release_dir" "$current_link"
primary_changed=1
systemctl restart ozon-erp

if ! wait_for_release 3000 "$release_version" "$candidate_warmup_seconds"; then
  journalctl -u ozon-erp -n 80 --no-pager >&2 || true
  false
fi

# Capture files uploaded by the old default-only writer during candidate warmup.
if [[ "$run_db_maintenance" == "1" ]]; then
  (cd "$release_dir" && node scripts/migrate-tenant-private-files.mjs --apply --backfill-legacy-default --mysql-admin-socket=/var/run/mysqld/mysqld.sock \
    --legacy-root="$shared_root/uploads/runtime/team-attachments" --legacy-root="$shared_root/uploads/public/team-attachments")
fi

# Keep the validated candidate alive as Nginx's hot backup. The next release
# replaces it while the primary remains healthy.
candidate_pid=""

trap - ERR
release_retention_minutes=$((7 * 24 * 60))
while IFS= read -r -d '' old_release; do
  [[ "$old_release" != "$release_dir" && "$old_release" != "$previous_target" ]] || continue
  rm -rf -- "$old_release"
done < <(find "$releases_root" -mindepth 1 -maxdepth 1 -type d -mmin "+$release_retention_minutes" -print0)

find "$releases_root" -mindepth 1 -maxdepth 1 -type d -not -name '.*.staging' -printf '%T@ %p\n' \
  | sort -nr \
  | tail -n +3 \
  | cut -d' ' -f2- \
  | while IFS= read -r old_release; do
      [[ -n "$old_release" && "$old_release" != "$release_dir" && "$old_release" != "$previous_target" ]] || continue
      rm -rf -- "$old_release"
    done

if [[ -d "$shared_root/rollback" ]]; then
  find "$shared_root/rollback" -mindepth 1 -maxdepth 1 -type d -mmin "+$release_retention_minutes" -exec rm -rf -- {} +
fi
find /tmp -maxdepth 1 -type f -name 'ozon-erp-*.zip' -mmin +60 -delete

rm -f "$archive_path"
if [[ -n "$reviewed_identity_manifest" ]]; then
  rm -f -- "$reviewed_identity_manifest"
fi
echo "Release active: $release_dir"
systemctl --no-pager --full status ozon-erp | head -n 12

#!/usr/bin/env bash
set -Eeuo pipefail

archive_path="${1:-}"
release_version="${2:-}"
run_db_init="${3:-1}"
app_root="/opt/ozon-erp"
releases_root="$app_root/releases"
shared_root="$app_root/shared"
current_link="$app_root/current"
env_file="/etc/ozon-erp/ozon-erp.env"
candidate_port="3001"
candidate_pid=""
candidate_log="/tmp/ozon-erp-candidate-${release_version}.log"
candidate_pid_file="/tmp/ozon-erp-candidate.pid"

if [[ -z "$archive_path" || -z "$release_version" ]]; then
  echo "Usage: remote-release.sh <archive.zip> <version> [run-db-init:1|0]" >&2
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

release_dir="$releases_root/$release_version"
staging_dir="$releases_root/.${release_version}.staging"
previous_target=""
if [[ -L "$current_link" ]]; then
  previous_target="$(readlink -f "$current_link" || true)"
fi

rollback() {
  local exit_code=$?
  if [[ -n "$candidate_pid" ]]; then
    kill "$candidate_pid" 2>/dev/null || true
  fi
  if [[ $exit_code -eq 0 ]]; then
    return
  fi
  echo "Release failed; attempting rollback." >&2
  if [[ -n "$previous_target" && -d "$previous_target" ]]; then
    ln -sfn "$previous_target" "$current_link"
    systemctl restart ozon-erp || true
    echo "Rollback restored: $previous_target" >&2
  fi
  exit "$exit_code"
}
trap rollback ERR

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

start_candidate() {
  if [[ -f "$candidate_pid_file" ]]; then
    local old_candidate_pid
    old_candidate_pid="$(cat "$candidate_pid_file" 2>/dev/null || true)"
    if [[ "$old_candidate_pid" =~ ^[0-9]+$ ]]; then
      kill "$old_candidate_pid" 2>/dev/null || true
      for _ in {1..30}; do
        kill -0 "$old_candidate_pid" 2>/dev/null || break
        sleep 1
      done
    fi
    rm -f "$candidate_pid_file"
  fi
  rm -f "$candidate_log"
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
  runuser -u ozon-erp -- bash -lc "
    cd '$release_dir'
    nohup env PORT='$candidate_port' HOST='127.0.0.1' SCHEDULED_JOBS_ENABLED='false' DEPLOYMENT_CANDIDATE='1' NODE_ENV='production' NODE_OPTIONS='--max-old-space-size=1024' /usr/bin/node src/server.js >'$candidate_log' 2>&1 &
    echo \$! >'$candidate_pid_file'
  "
  candidate_pid="$(cat "$candidate_pid_file")"

  local candidate_ok=0
  for _ in {1..60}; do
    if ! kill -0 "$candidate_pid" 2>/dev/null; then
      cat "$candidate_log" >&2 || true
      echo "Candidate process exited before readiness." >&2
      return 1
    fi
    local status
    status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${candidate_port}/api/ready" || true)"
    if [[ "$status" == "200" ]]; then
      candidate_ok=1
      break
    fi
    sleep 2
  done
  if [[ "$candidate_ok" != "1" ]]; then
    cat "$candidate_log" >&2 || true
    echo "Candidate process did not become ready." >&2
    return 1
  fi
}

install -d -o ozon-erp -g ozon-erp "$releases_root" "$shared_root/uploads/public" "$shared_root/uploads/runtime"
rm -rf "$staging_dir"
install -d -o ozon-erp -g ozon-erp "$staging_dir"
unzip -q "$archive_path" -d "$staging_dir"

if [[ ! -f "$staging_dir/package.json" || ! -f "$staging_dir/src/server.js" ]]; then
  echo "Archive is not an Ozon ERP deploy artifact." >&2
  exit 3
fi

chown -R ozon-erp:ozon-erp "$staging_dir"
runuser -u ozon-erp -- bash -lc "cd '$staging_dir' && npm ci --omit=dev"

if [[ "$run_db_init" == "1" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
  (cd "$staging_dir" && npm run db:init:mysql)
fi

install -d -o ozon-erp -g ozon-erp "$staging_dir/public"
rm -rf "$staging_dir/public/uploads" "$staging_dir/uploads"
ln -s "$shared_root/uploads/public" "$staging_dir/public/uploads"
ln -s "$shared_root/uploads/runtime" "$staging_dir/uploads"

if [[ -e "$release_dir" ]]; then
  echo "Release already exists: $release_dir" >&2
  exit 3
fi
mv "$staging_dir" "$release_dir"
chown -R ozon-erp:ozon-erp "$release_dir"
configure_nginx_failover
start_candidate
ln -sfn "$release_dir" "$current_link"
systemctl restart ozon-erp

health_ok=0
for _ in {1..60}; do
  status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/ready || true)"
  if [[ "$status" == "200" ]]; then
    health_ok=1
    break
  fi
  sleep 2
done
if [[ "$health_ok" != "1" ]]; then
  journalctl -u ozon-erp -n 80 --no-pager >&2 || true
  false
fi

# Keep the validated candidate alive as Nginx's hot backup. The next release
# replaces it while the primary remains healthy.
candidate_pid=""

trap - ERR
find "$releases_root" -mindepth 1 -maxdepth 1 -type d -not -name '.*.staging' -printf '%T@ %p\n' \
  | sort -nr \
  | tail -n +4 \
  | cut -d' ' -f2- \
  | while IFS= read -r old_release; do
      [[ -n "$old_release" && "$old_release" != "$release_dir" && "$old_release" != "$previous_target" ]] || continue
      rm -rf "$old_release"
    done

rm -f "$archive_path"
echo "Release active: $release_dir"
systemctl --no-pager --full status ozon-erp | head -n 12

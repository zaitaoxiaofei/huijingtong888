#!/usr/bin/env bash
set -Eeuo pipefail

mysql_config="/etc/mysql/mysql.conf.d/ozon-erp-memory.cnf"
sysctl_config="/etc/sysctl.d/99-ozon-erp-memory.conf"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "This script must run as root." >&2
  exit 2
fi

recover_services() {
  systemctl is-active --quiet mysql || systemctl start mysql || true
  systemctl is-active --quiet ozon-erp || systemctl start ozon-erp || true
}
trap recover_services EXIT

install -d -m 0755 /etc/mysql/mysql.conf.d /etc/sysctl.d

cat > "$mysql_config" <<'EOF'
[mysqld]
# Sized for the current 3.4 GiB ECS. Production peak connections observed: 21.
max_connections = 60
table_open_cache = 2000
EOF

cat > "$sysctl_config" <<'EOF'
# Prefer reclaiming filesystem cache before swapping active MySQL/Node pages.
vm.swappiness = 10
EOF

mysqld --validate-config
sysctl -p "$sysctl_config"

systemctl stop ozon-erp
if [[ -f /tmp/ozon-erp-candidate.pid ]]; then
  candidate_pid="$(cat /tmp/ozon-erp-candidate.pid 2>/dev/null || true)"
  if [[ "$candidate_pid" =~ ^[0-9]+$ ]]; then
    kill "$candidate_pid" 2>/dev/null || true
  fi
  rm -f /tmp/ozon-erp-candidate.pid
fi
systemctl restart mysql
systemctl start ozon-erp

for _ in {1..90}; do
  status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/api/ready || true)"
  if [[ "$status" == "200" ]]; then
    echo "ECS memory tuning applied; ERP is ready."
    trap - EXIT
    exit 0
  fi
  sleep 2
done

journalctl -u mysql -u ozon-erp -n 100 --no-pager >&2 || true
echo "ERP did not become ready after memory tuning." >&2
exit 1

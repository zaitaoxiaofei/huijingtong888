#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: bash deploy/linux/deploy-ecs.sh [options]

Options:
  --host HOST                 ECS host (or OZON_ECS_HOST)
  --user USER                 SSH user (or OZON_ECS_USER; default: root)
  --port PORT                 SSH port (or OZON_ECS_PORT; default: 22)
  --identity-file PATH        SSH private key (or OZON_ECS_IDENTITY_FILE)
  --version VERSION           Release version (default: local timestamp)
  --reviewed-identity-manifest PATH  Apply an explicitly reviewed identity manifest
  --reviewed-ai-material-manifest PATH  Apply an explicitly reviewed material ownership manifest
  --skip-build                Reuse an existing deployment artifact
  --allow-dirty               Emergency override for a dirty/non-release worktree
  --skip-database-init        Do not run the compatible database initializer
  --skip-database-maintenance  Do not run schema migrations or database maintenance
  --dry-run                   Validate local inputs only; never build or connect
  -h, --help                  Show this help

Requires Bash 3.2+, Node.js/npm, OpenSSH (ssh/scp), and zip.
EOF
}

fail() {
  printf 'Deployment error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

read_saved_value() {
  local config_path="$1"
  local key="$2"
  node - "$config_path" "$key" <<'NODE'
const fs = require("node:fs");
const [configPath, key] = process.argv.slice(2);
try {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const value = config[key];
  if (typeof value === "string" || typeof value === "number") process.stdout.write(String(value));
} catch {}
NODE
}

expand_home_path() {
  case "$1" in
    '~/'*) printf '%s/%s' "$HOME" "${1#\~/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

on_error() {
  local line="$1"
  printf 'Deployment failed near line %s. Production activation was not confirmed.\n' "$line" >&2
}
trap 'on_error "$LINENO"' ERR

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
project_root="$(CDPATH= cd -- "$script_dir/../.." && pwd -P)"
artifact_root="$project_root/.deploy-artifacts"
saved_config="$artifact_root/ecs-deploy.json"

host="${OZON_ECS_HOST:-}"
ssh_user="${OZON_ECS_USER:-}"
ssh_port="${OZON_ECS_PORT:-}"
identity_file="${OZON_ECS_IDENTITY_FILE:-}"
version=""
reviewed_identity_manifest=""
reviewed_ai_material_manifest=""
skip_build=0
skip_database_init=0
skip_database_maintenance=0
dry_run=0
allow_dirty=0

while (($#)); do
  case "$1" in
    --host|--user|--port|--identity-file|--version|--reviewed-identity-manifest|--reviewed-ai-material-manifest)
      (($# >= 2)) || fail "$1 requires a value"
      case "$1" in
        --host) host="$2" ;;
        --user) ssh_user="$2" ;;
        --port) ssh_port="$2" ;;
        --identity-file) identity_file="$2" ;;
        --version) version="$2" ;;
        --reviewed-identity-manifest) reviewed_identity_manifest="$2" ;;
        --reviewed-ai-material-manifest) reviewed_ai_material_manifest="$2" ;;
      esac
      shift 2
      ;;
    --skip-build) skip_build=1; shift ;;
    --allow-dirty) allow_dirty=1; shift ;;
    --skip-database-init) skip_database_init=1; shift ;;
    --skip-database-maintenance) skip_database_maintenance=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

require_command node

if [[ -f "$saved_config" ]]; then
  [[ -n "$host" ]] || host="$(read_saved_value "$saved_config" host)"
  [[ -n "$ssh_user" ]] || ssh_user="$(read_saved_value "$saved_config" user)"
  [[ -n "$ssh_port" ]] || ssh_port="$(read_saved_value "$saved_config" port)"
  [[ -n "$identity_file" ]] || identity_file="$(read_saved_value "$saved_config" identityFile)"
fi

host="${host:-47.120.47.194}"
ssh_user="${ssh_user:-root}"
ssh_port="${ssh_port:-22}"
version="${version:-$(date '+%Y.%m.%d-%H%M%S')}"

[[ "$version" =~ ^[0-9A-Za-z._-]+$ ]] || fail "version contains unsupported characters: $version"
[[ "$ssh_port" =~ ^[0-9]+$ ]] && ((ssh_port >= 1 && ssh_port <= 65535)) || fail "invalid SSH port"
[[ "$ssh_user" =~ ^[A-Za-z_][A-Za-z0-9._-]*$ ]] || fail "invalid SSH user"
[[ "$host" =~ ^[A-Za-z0-9._:-]+$ ]] || fail "invalid ECS host"

output_dir="$artifact_root/$version-package"
archive_path="$artifact_root/ozon-erp-$version.zip"
remote_archive="/tmp/ozon-erp-$version.zip"
remote_script="/tmp/ozon-erp-remote-release.sh"
remote_identity_manifest=""
remote_ai_material_manifest=""
if [[ -n "$reviewed_identity_manifest" ]]; then
  [[ -f "$reviewed_identity_manifest" ]] || fail "reviewed identity manifest does not exist"
  node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$reviewed_identity_manifest"
  reviewed_identity_manifest="$(CDPATH= cd -- "$(dirname -- "$reviewed_identity_manifest")" && pwd -P)/$(basename -- "$reviewed_identity_manifest")"
  remote_identity_manifest="/tmp/ozon-erp-identity-$version.json"
fi
if [[ -n "$reviewed_ai_material_manifest" ]]; then
  [[ -f "$reviewed_ai_material_manifest" ]] || fail "reviewed AI material manifest does not exist"
  node -e 'try { JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); } catch { console.error("Reviewed AI material manifest is not valid JSON."); process.exit(1); }' "$reviewed_ai_material_manifest"
  reviewed_ai_material_manifest="$(CDPATH= cd -- "$(dirname -- "$reviewed_ai_material_manifest")" && pwd -P)/$(basename -- "$reviewed_ai_material_manifest")"
  material_token="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
  remote_ai_material_manifest="/tmp/ozon-erp-ai-material-$version-$material_token.json"
fi
db_init_flag=1
((skip_database_init)) && db_init_flag=0
db_maintenance_flag=1
((skip_database_maintenance)) && db_maintenance_flag=0
activation_command="bash '$remote_script' '$remote_archive' '$version' '$db_init_flag' '$db_maintenance_flag' '$remote_identity_manifest' '$remote_ai_material_manifest'"

if ((dry_run)); then
  printf 'DryRun only: no build, upload, SSH command, database change, release switch, restart, or rollback will run.\n'
  printf 'Project root: %s\n' "$project_root"
  printf 'Target: %s@%s:%s\n' "$ssh_user" "$host" "$ssh_port"
  printf 'Version: %s\n' "$version"
  printf 'Artifact: %s\n' "$archive_path"
  printf 'Activation arguments: %s\n' "$activation_command"
  exit 0
fi

require_command npm
require_command ssh
require_command scp
require_command zip
require_command split

if (( !allow_dirty )); then
  (cd "$project_root" && node scripts/verify-release-worktree.mjs)
fi

[[ -n "$identity_file" ]] || fail "SSH identity file is required; set --identity-file or OZON_ECS_IDENTITY_FILE"
identity_file="$(expand_home_path "$identity_file")"
[[ -f "$identity_file" ]] || fail "SSH identity file does not exist"

mkdir -p "$artifact_root"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/ozon-erp-deploy-$version.XXXXXX")"
material_upload_attempted=0
cleanup() {
  if ((material_upload_attempted)); then
    ssh "${ssh_options[@]}" "$remote_target" "rm -f -- '$remote_ai_material_manifest'" >/dev/null 2>&1 || printf 'Private AI material manifest cleanup could not be confirmed.\n' >&2
  fi
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

cd "$project_root"
if ((!skip_build)); then
  printf 'Building deployment artifact...\n'
  DEPLOY_OUTPUT_DIR="$output_dir" \
    OZON_DEPLOY_WORK_DIR="$work_dir" \
    OZON_RELEASE_VERSION="$version" \
    OZON_RELEASE_BRANCH="$(git branch --show-current)" \
    OZON_RELEASE_COMMIT="$(git rev-parse HEAD)" \
    OZON_RELEASE_CHANNEL="production" \
    npm run package:deploy
fi

[[ -f "$output_dir/deploy-manifest.json" ]] || fail "deployment artifact is missing deploy-manifest.json: $output_dir"
rm -f -- "$archive_path"
(cd "$output_dir" && zip -q -r "$archive_path" .)

ssh_options=(-p "$ssh_port" -o ServerAliveInterval=15 -o ServerAliveCountMax=12 -i "$identity_file")
scp_options=(-P "$ssh_port" -o ServerAliveInterval=15 -o ServerAliveCountMax=12 -i "$identity_file")
remote_target="$ssh_user@$host"

printf 'Splitting release artifact for upload...\n'
split -b 4m "$archive_path" "$work_dir/ozon-erp-upload-part-"
printf 'Uploading release artifact in chunks...\n'
for chunk_path in "$work_dir"/ozon-erp-upload-part-*; do
  chunk_suffix="${chunk_path##*-}"
  printf 'Uploading artifact chunk %s...\n' "$chunk_suffix"
  scp "${scp_options[@]}" "$chunk_path" "$remote_target:$remote_archive.part-$chunk_suffix"
done
ssh "${ssh_options[@]}" "$remote_target" \
  "set -e; cat '$remote_archive'.part-* > '$remote_archive'; rm -f '$remote_archive'.part-*; unzip -tqq '$remote_archive'"
scp "${scp_options[@]}" "$script_dir/remote-release.sh" "$remote_target:$remote_script"
if [[ -n "$reviewed_identity_manifest" ]]; then
  scp "${scp_options[@]}" "$reviewed_identity_manifest" "$remote_target:$remote_identity_manifest"
fi
if [[ -n "$reviewed_ai_material_manifest" ]]; then
  material_upload_attempted=1
  ssh "${ssh_options[@]}" "$remote_target" "set -Ce; umask 077; : > '$remote_ai_material_manifest'; chmod 600 '$remote_ai_material_manifest'"
  scp "${scp_options[@]}" "$reviewed_ai_material_manifest" "$remote_target:$remote_ai_material_manifest"
fi

printf 'Activating release on ECS...\n'
if [[ -n "$remote_identity_manifest" ]]; then
  ssh "${ssh_options[@]}" "$remote_target" "chmod 600 '$remote_identity_manifest'"
fi
ssh "${ssh_options[@]}" "$remote_target" \
  "$activation_command"

if command -v shasum >/dev/null 2>&1; then
  archive_hash="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
elif command -v openssl >/dev/null 2>&1; then
  archive_hash="$(openssl dgst -sha256 "$archive_path" | awk '{print $NF}')"
else
  archive_hash="unavailable"
fi

printf 'Deployment completed.\n'
printf 'Version: %s\n' "$version"
printf 'Artifact: %s\n' "$archive_path"
printf 'SHA256: %s\n' "$archive_hash"

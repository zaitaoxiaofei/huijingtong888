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
  --expected-production-commit SHA  Abort activation if production changed while building/uploading
  --reviewed-identity-manifest PATH  Apply an explicitly reviewed identity manifest
  --reviewed-ai-material-manifest PATH  Apply an explicitly reviewed material ownership manifest
  --reviewed-ai-media-retention-manifest PATH  Reclaim reviewed unused AI media during offline maintenance
  --reviewed-inventory-consumables-manifest PATH  Apply individually reviewed consumable flags
  --reviewed-inventory-numbering-manifest PATH  Cut over reviewed inventory numbers during explicit maintenance
  --skip-build                Reuse an existing deployment artifact
  --allow-dirty               Emergency override for a dirty/non-release worktree
  --skip-database-init        Do not run the compatible database initializer
  --skip-database-maintenance  Skip broad database maintenance (the default)
  --run-database-maintenance   Explicitly run broad database maintenance
  --allow-service-interruption  Explicit maintenance window for reviewed legacy writer changes
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
expected_production_commit=""
version=""
reviewed_identity_manifest=""
reviewed_ai_material_manifest=""
reviewed_ai_media_retention_manifest=""
reviewed_inventory_consumables_manifest=""
reviewed_inventory_numbering_manifest=""
skip_build=0
skip_database_init=0
skip_database_maintenance=0
run_database_maintenance=0
dry_run=0
allow_dirty=0
allow_service_interruption=0

while (($#)); do
  case "$1" in
    --host|--user|--port|--identity-file|--version|--expected-production-commit|--reviewed-identity-manifest|--reviewed-ai-material-manifest|--reviewed-ai-media-retention-manifest|--reviewed-inventory-consumables-manifest|--reviewed-inventory-numbering-manifest)
      (($# >= 2)) || fail "$1 requires a value"
      case "$1" in
        --host) host="$2" ;;
        --user) ssh_user="$2" ;;
        --port) ssh_port="$2" ;;
        --identity-file) identity_file="$2" ;;
        --version) version="$2" ;;
        --expected-production-commit) expected_production_commit="$2" ;;
        --reviewed-identity-manifest) reviewed_identity_manifest="$2" ;;
        --reviewed-ai-material-manifest) reviewed_ai_material_manifest="$2" ;;
        --reviewed-ai-media-retention-manifest) reviewed_ai_media_retention_manifest="$2" ;;
        --reviewed-inventory-consumables-manifest) reviewed_inventory_consumables_manifest="$2" ;;
        --reviewed-inventory-numbering-manifest) reviewed_inventory_numbering_manifest="$2" ;;
      esac
      shift 2
      ;;
    --skip-build) skip_build=1; shift ;;
    --allow-dirty) allow_dirty=1; shift ;;
    --skip-database-init) skip_database_init=1; shift ;;
    --skip-database-maintenance) skip_database_maintenance=1; shift ;;
    --run-database-maintenance) run_database_maintenance=1; shift ;;
    --allow-service-interruption) allow_service_interruption=1; shift ;;
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
((${#version} <= 128)) || fail "version is too long for a release job"
[[ -z "$expected_production_commit" || "$expected_production_commit" =~ ^[a-f0-9]{40}$ ]] || fail "expected production commit must be a full Git SHA"
[[ "$ssh_port" =~ ^[0-9]+$ ]] && ((ssh_port >= 1 && ssh_port <= 65535)) || fail "invalid SSH port"
[[ "$ssh_user" =~ ^[A-Za-z_][A-Za-z0-9._-]*$ ]] || fail "invalid SSH user"
[[ "$host" =~ ^[A-Za-z0-9._:-]+$ ]] || fail "invalid ECS host"

output_dir="$artifact_root/$version-package"
archive_path="$artifact_root/ozon-erp-$version.zip"
release_job_token="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(6).toString("hex"))')"
release_unit="ozon-erp-release-$version-$release_job_token"
remote_archive="/tmp/ozon-erp-$version-$release_job_token.zip"
remote_script="/tmp/ozon-erp-remote-release-$version-$release_job_token.sh"
remote_identity_manifest=""
remote_ai_material_manifest=""
remote_ai_media_retention_manifest=""
remote_inventory_consumables_manifest=""
remote_inventory_numbering_manifest=""
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
if [[ -n "$reviewed_ai_media_retention_manifest" ]]; then
  ((allow_service_interruption)) || fail "AI media retention requires --allow-service-interruption"
  [[ -f "$reviewed_ai_media_retention_manifest" ]] || fail "AI media retention manifest does not exist"
  node -e 'try { JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); } catch { console.error("AI media retention manifest is not valid JSON."); process.exit(1); }' "$reviewed_ai_media_retention_manifest"
  reviewed_ai_media_retention_manifest="$(CDPATH= cd -- "$(dirname -- "$reviewed_ai_media_retention_manifest")" && pwd -P)/$(basename -- "$reviewed_ai_media_retention_manifest")"
  retention_token="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
  remote_ai_media_retention_manifest="/tmp/ozon-erp-ai-media-retention-$version-$retention_token.json"
fi
if [[ -n "$reviewed_inventory_consumables_manifest" ]]; then
  [[ -f "$reviewed_inventory_consumables_manifest" ]] || fail "reviewed inventory consumables manifest does not exist"
  node -e 'try { JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); } catch { console.error("Reviewed inventory consumables manifest is not valid JSON."); process.exit(1); }' "$reviewed_inventory_consumables_manifest"
  reviewed_inventory_consumables_manifest="$(CDPATH= cd -- "$(dirname -- "$reviewed_inventory_consumables_manifest")" && pwd -P)/$(basename -- "$reviewed_inventory_consumables_manifest")"
  consumables_token="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
  remote_inventory_consumables_manifest="/tmp/ozon-erp-inventory-consumables-$version-$consumables_token.json"
fi
if [[ -n "$reviewed_inventory_numbering_manifest" ]]; then
  ((allow_service_interruption)) || fail "inventory numbering requires --allow-service-interruption"
  [[ -f "$reviewed_inventory_numbering_manifest" ]] || fail "reviewed inventory numbering manifest does not exist"
  node -e 'try { JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")); } catch { console.error("Reviewed inventory numbering manifest is not valid JSON."); process.exit(1); }' "$reviewed_inventory_numbering_manifest"
  reviewed_inventory_numbering_manifest="$(CDPATH= cd -- "$(dirname -- "$reviewed_inventory_numbering_manifest")" && pwd -P)/$(basename -- "$reviewed_inventory_numbering_manifest")"
  numbering_token="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
  remote_inventory_numbering_manifest="/tmp/ozon-erp-inventory-numbering-$version-$numbering_token.json"
fi
db_init_flag=1
((skip_database_init)) && db_init_flag=0
if ((skip_database_maintenance && run_database_maintenance)); then fail "choose either run or skip database maintenance"; fi
db_maintenance_flag=0
((run_database_maintenance)) && db_maintenance_flag=1
((skip_database_maintenance)) && db_maintenance_flag=0
activation_command="bash '$remote_script' '$remote_archive' '$version' '$db_init_flag' '$db_maintenance_flag' '$remote_identity_manifest' '$remote_ai_material_manifest' '$allow_service_interruption'"
if [[ -n "$remote_ai_media_retention_manifest" || -n "$expected_production_commit" || -n "$remote_inventory_consumables_manifest" || -n "$remote_inventory_numbering_manifest" ]]; then activation_command+=" '$remote_ai_media_retention_manifest'"; fi
if [[ -n "$expected_production_commit" || -n "$remote_inventory_consumables_manifest" || -n "$remote_inventory_numbering_manifest" ]]; then
  activation_command+=" '$expected_production_commit'"
fi
if [[ -n "$remote_inventory_consumables_manifest" || -n "$remote_inventory_numbering_manifest" ]]; then activation_command+=" '$remote_inventory_consumables_manifest'"; fi
if [[ -n "$remote_inventory_numbering_manifest" ]]; then activation_command+=" '$remote_inventory_numbering_manifest'"; fi

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
retention_upload_attempted=0
consumables_upload_attempted=0
numbering_upload_attempted=0
remote_job_started=0
remote_job_finished=0
cleanup() {
  if ((remote_job_started && !remote_job_finished)); then
    printf 'Release may still be running in ECS unit %s; private manifests retained for that job.\n' "$release_unit" >&2
    rm -rf -- "$work_dir"
    return
  fi
  if ((numbering_upload_attempted)); then
    ssh "${ssh_options[@]}" "$remote_target" "rm -f -- '$remote_inventory_numbering_manifest'" >/dev/null 2>&1 || printf 'Private inventory numbering manifest cleanup could not be confirmed.\n' >&2
  fi
  if ((consumables_upload_attempted)); then
    ssh "${ssh_options[@]}" "$remote_target" "rm -f -- '$remote_inventory_consumables_manifest'" >/dev/null 2>&1 || printf 'Private inventory consumables manifest cleanup could not be confirmed.\n' >&2
  fi
  if ((retention_upload_attempted)); then
    ssh "${ssh_options[@]}" "$remote_target" "rm -f -- '$remote_ai_media_retention_manifest'" >/dev/null 2>&1 || printf 'AI media retention manifest cleanup could not be confirmed.\n' >&2
  fi
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
    OZON_DEPLOY_TARGET="linux" \
    npm run package:deploy
fi

[[ -f "$output_dir/deploy-manifest.json" ]] || fail "deployment artifact is missing deploy-manifest.json: $output_dir"
rm -f -- "$archive_path"
(cd "$output_dir" && zip -q -r "$archive_path" .)

ssh_options=(-p "$ssh_port" -o ServerAliveInterval=15 -o ServerAliveCountMax=12 -i "$identity_file")
scp_options=(-P "$ssh_port" -o ServerAliveInterval=15 -o ServerAliveCountMax=12 -i "$identity_file")
remote_target="$ssh_user@$host"

file_hash() {
  node -e 'const fs=require("node:fs"),crypto=require("node:crypto");const hash=crypto.createHash("sha256");fs.createReadStream(process.argv[1]).on("data",chunk=>hash.update(chunk)).on("end",()=>process.stdout.write(hash.digest("hex"))).on("error",()=>process.exit(1));' "$1"
}

upload_verified_file() {
  local source="$1" destination="$2" checksum attempt
  checksum="$(file_hash "$source")"
  for attempt in 1 2 3; do
    if ssh "${ssh_options[@]}" "$remote_target" "test -f '$destination' && test ! -L '$destination' && test \"\$(sha256sum '$destination' | cut -d' ' -f1)\" = '$checksum'"; then return; fi
    if scp "${scp_options[@]}" "$source" "$remote_target:$destination" \
      && ssh "${ssh_options[@]}" "$remote_target" "test \"\$(sha256sum '$destination' | cut -d' ' -f1)\" = '$checksum'"; then return; fi
    sleep 2
  done
  fail "Upload failed checksum verification: $destination"
}

# Large Windows tools are source-versioned blobs, not mutable files copied from
# a running release. Only missing objects are uploaded; rollback keeps old hashes.
node --input-type=module - "$output_dir/deploy-manifest.json" > "$work_dir/external-files.tsv" <<'NODE'
import fs from 'node:fs';
const files=JSON.parse(fs.readFileSync(process.argv[2],'utf8')).externalFiles||[];
if(!Array.isArray(files)||files.length>2)throw Error('Invalid external file manifest');
for(const file of files) {
  if(!/^[a-f0-9]{64}$/.test(file.sha256)||!/^[a-f0-9]{64}$/.test(file.compressed_sha256))throw Error('Invalid external object hash');
  console.log(`${file.sha256}\t${file.compressed_sha256}`);
}
NODE
# SSH reads stdin by default; keep manifest records on their own descriptor.
while IFS=$'\t' read -r object_hash compressed_hash <&3; do
  [[ -n "$object_hash" ]] || continue
  if ssh "${ssh_options[@]}" "$remote_target" "test -f '/opt/ozon-erp/artifacts/files/$object_hash' && test ! -L '/opt/ozon-erp/artifacts/files/$object_hash' && test \"\$(sha256sum '/opt/ozon-erp/artifacts/files/$object_hash' | cut -d' ' -f1)\" = '$object_hash'"; then
    printf 'Reusing unchanged tool object %s\n' "$object_hash"
    continue
  fi
  object_source="${output_dir}-external/$object_hash.gz"
  [[ "$(file_hash "$object_source")" == "$compressed_hash" ]] || fail "External object does not match source manifest"
  ssh "${ssh_options[@]}" "$remote_target" "install -d -m 700 '${remote_archive}.files'"
  upload_verified_file "$object_source" "${remote_archive}.files/$object_hash.gz"
done 3< "$work_dir/external-files.tsv"

printf 'Splitting release artifact for upload...\n'
split -b 4m "$archive_path" "$work_dir/ozon-erp-upload-part-"
printf 'Uploading release artifact in chunks...\n'
for chunk_path in "$work_dir"/ozon-erp-upload-part-*; do
  chunk_suffix="${chunk_path##*-}"
  printf 'Uploading artifact chunk %s...\n' "$chunk_suffix"
  upload_verified_file "$chunk_path" "$remote_archive.part-$chunk_suffix"
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
if [[ -n "$reviewed_ai_media_retention_manifest" ]]; then
  retention_upload_attempted=1
  ssh "${ssh_options[@]}" "$remote_target" "set -Ce; umask 077; : > '$remote_ai_media_retention_manifest'; chmod 600 '$remote_ai_media_retention_manifest'"
  scp "${scp_options[@]}" "$reviewed_ai_media_retention_manifest" "$remote_target:$remote_ai_media_retention_manifest"
fi
if [[ -n "$reviewed_inventory_consumables_manifest" ]]; then
  consumables_upload_attempted=1
  ssh "${ssh_options[@]}" "$remote_target" "set -Ce; umask 077; : > '$remote_inventory_consumables_manifest'; chmod 600 '$remote_inventory_consumables_manifest'"
  scp "${scp_options[@]}" "$reviewed_inventory_consumables_manifest" "$remote_target:$remote_inventory_consumables_manifest"
fi
if [[ -n "$reviewed_inventory_numbering_manifest" ]]; then
  numbering_upload_attempted=1
  ssh "${ssh_options[@]}" "$remote_target" "set -Ce; umask 077; : > '$remote_inventory_numbering_manifest'; chmod 600 '$remote_inventory_numbering_manifest'"
  scp "${scp_options[@]}" "$reviewed_inventory_numbering_manifest" "$remote_target:$remote_inventory_numbering_manifest"
fi

archive_hash="$(file_hash "$archive_path")"
script_hash="$(file_hash "$script_dir/remote-release.sh")"
ssh "${ssh_options[@]}" "$remote_target" "test \"\$(sha256sum '$remote_archive' | cut -d' ' -f1)\" = '$archive_hash' && test \"\$(sha256sum '$remote_script' | cut -d' ' -f1)\" = '$script_hash'"
printf 'Starting independent ECS release job %s...\n' "$release_unit"
if [[ -n "$remote_identity_manifest" ]]; then
  ssh "${ssh_options[@]}" "$remote_target" "chmod 600 '$remote_identity_manifest'"
fi
node - "$artifact_root/deploy-job-$version-$release_job_token.json" "$release_unit" "$host" "$version" "$archive_hash" <<'NODE'
const fs=require('node:fs');const [file,unit,host,version,sha256]=process.argv.slice(2);
fs.writeFileSync(file,JSON.stringify({unit,host,version,sha256})+'\n',{mode:0o600});
NODE
remote_job_started=1
ssh "${ssh_options[@]}" "$remote_target" \
  "systemd-run --quiet --unit='$release_unit' --property=RuntimeMaxSec=1800 --property=KillMode=control-group $activation_command"

wait_for_remote_release() {
  local deadline=$((SECONDS + 1860)) status active result exit_status load_state
  while ((SECONDS < deadline)); do
    if ! status="$(ssh "${ssh_options[@]}" "$remote_target" "systemctl show '$release_unit.service' -p LoadState -p ActiveState -p Result -p ExecMainStatus")"; then
      sleep 5
      continue
    fi
    active=""; result=""; exit_status=""; load_state=""
    while IFS='=' read -r key value; do
      case "$key" in LoadState) load_state="$value" ;; ActiveState) active="$value" ;; Result) result="$value" ;; ExecMainStatus) exit_status="$value" ;; esac
    done <<< "$status"
    if [[ "$load_state" != "loaded" ]]; then
      echo "Release unit is unavailable; verify the running version before retrying." >&2
      return 1
    fi
    if [[ "$active" == "failed" || "$active" == "inactive" ]]; then
      remote_job_finished=1
      ssh "${ssh_options[@]}" "$remote_target" "journalctl -u '$release_unit.service' -n 30 --no-pager" || true
      [[ "$active" == "inactive" && "$result" == "success" && "$exit_status" == "0" ]] || return 1
      return
    fi
    sleep 5
  done
  echo "Release status is unknown; inspect ECS unit $release_unit before retrying." >&2
  return 1
}
wait_for_remote_release

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

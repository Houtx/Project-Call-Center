#!/usr/bin/env bash
set -euo pipefail

UPDATE_SERVER_SSH="${UPDATE_SERVER_SSH:?set UPDATE_SERVER_SSH, for example deploy-user@update.example.com}"
UPDATE_SERVER_IDENTITY_FILE="${UPDATE_SERVER_IDENTITY_FILE:-}"
UPDATE_SERVER_ROOT="${UPDATE_SERVER_ROOT:-/opt/project-call-center-update/public}"
UPDATE_SERVER_BASE_URL="${UPDATE_SERVER_BASE_URL:-https://call.haoyunqiankun.com}"
UPDATE_GITHUB_REPOSITORY="${UPDATE_GITHUB_REPOSITORY:-Houtx/Project-Call-Center}"
MANIFEST_PATH="${1:-release-assets/release.json}"

for command_name in node ssh curl; do
  command -v "$command_name" >/dev/null || {
    echo "Missing required command: $command_name" >&2
    exit 1
  }
done

[[ "$UPDATE_SERVER_ROOT" =~ ^/[A-Za-z0-9._/-]+$ ]] || {
  echo "UPDATE_SERVER_ROOT contains unsupported characters" >&2
  exit 1
}
[[ "$UPDATE_SERVER_BASE_URL" == https://* ]] || {
  echo "UPDATE_SERVER_BASE_URL must use HTTPS" >&2
  exit 1
}
[[ "$UPDATE_GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
  echo "UPDATE_GITHUB_REPOSITORY must use owner/repository format" >&2
  exit 1
}
[[ -f "$MANIFEST_PATH" ]] || {
  echo "Manifest not found: $MANIFEST_PATH" >&2
  exit 1
}

release_tag="$(node -e '
  const fs = require("fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (manifest.schemaVersion !== 1 || !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(manifest.releaseTag || "")) process.exit(1);
  process.stdout.write(manifest.releaseTag);
' "$MANIFEST_PATH")"
apk_asset="$(node -e '
  const fs = require("fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.apk$/.test(manifest.apkAsset || "")) process.exit(1);
  process.stdout.write(manifest.apkAsset);
' "$MANIFEST_PATH")"
expected_sha256="$(node -e '
  const fs = require("fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!/^[a-f0-9]{64}$/.test(manifest.sha256 || "")) process.exit(1);
  process.stdout.write(manifest.sha256);
' "$MANIFEST_PATH")"
expected_size="$(node -e '
  const fs = require("fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!Number.isSafeInteger(manifest.sizeBytes) || manifest.sizeBytes <= 0) process.exit(1);
  process.stdout.write(String(manifest.sizeBytes));
' "$MANIFEST_PATH")"
expected_manifest_sha256="$(node -e '
  const crypto = require("crypto");
  const fs = require("fs");
  process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));
' "$MANIFEST_PATH")"
github_release_base="https://github.com/$UPDATE_GITHUB_REPOSITORY/releases/download/$release_tag"
github_manifest_url="$github_release_base/release.json"
github_apk_url="$github_release_base/$apk_asset"

ssh_args=( -o BatchMode=yes -o StrictHostKeyChecking=accept-new )
if [[ -n "$UPDATE_SERVER_IDENTITY_FILE" ]]; then
  ssh_args+=( -i "$UPDATE_SERVER_IDENTITY_FILE" )
fi

remote_tmp="$(ssh "${ssh_args[@]}" "$UPDATE_SERVER_SSH" 'mktemp -d /tmp/project-call-center-update.XXXXXX')"
[[ "$remote_tmp" =~ ^/tmp/project-call-center-update\.[A-Za-z0-9]+$ ]] || {
  echo "Update server returned an invalid temporary directory" >&2
  exit 1
}
cleanup_remote() {
  ssh "${ssh_args[@]}" "$UPDATE_SERVER_SSH" "rm -rf -- '$remote_tmp'" >/dev/null 2>&1 || true
}
trap cleanup_remote EXIT

ssh "${ssh_args[@]}" "$UPDATE_SERVER_SSH" sudo -n bash -s -- \
  "$remote_tmp" "$UPDATE_SERVER_ROOT" "$release_tag" "$apk_asset" \
  "$expected_sha256" "$expected_size" "$expected_manifest_sha256" \
  "$github_manifest_url" "$github_apk_url" <<'REMOTE_SCRIPT'
set -euo pipefail
incoming_dir="$1"
public_root="$2"
release_tag="$3"
apk_asset="$4"
expected_sha256="$5"
expected_size="$6"
expected_manifest_sha256="$7"
github_manifest_url="$8"
github_apk_url="$9"
incoming_apk="$incoming_dir/$apk_asset"
incoming_manifest="$incoming_dir/release.json"
target_dir="$public_root/releases/$release_tag"
target_apk="$target_dir/$apk_asset"

for command_name in curl sha256sum stat install; do
  command -v "$command_name" >/dev/null || {
    echo "Missing required server command: $command_name" >&2
    exit 1
  }
done

curl -fL --retry 5 --connect-timeout 15 --max-time 120 \
  "$github_manifest_url" -o "$incoming_manifest"
actual_manifest_sha256="$(sha256sum "$incoming_manifest" | awk '{print $1}')"
test "$actual_manifest_sha256" = "$expected_manifest_sha256"

curl -fL --retry 5 --connect-timeout 15 --max-time 600 \
  "$github_apk_url" -o "$incoming_apk"
actual_sha256="$(sha256sum "$incoming_apk" | awk '{print $1}')"
actual_size="$(stat -c '%s' "$incoming_apk")"
test "$actual_sha256" = "$expected_sha256"
test "$actual_size" = "$expected_size"

install -d -o root -g root -m 0755 "$public_root" "$target_dir"
if [[ -f "$target_apk" ]]; then
  installed_sha256="$(sha256sum "$target_apk" | awk '{print $1}')"
  test "$installed_sha256" = "$expected_sha256" || {
    echo "Refusing to replace an existing release asset with different content" >&2
    exit 1
  }
else
  install -o root -g root -m 0644 "$incoming_apk" "$target_apk"
fi

install -o root -g root -m 0644 "$incoming_manifest" "$public_root/.release.json.new"
mv -f "$public_root/.release.json.new" "$public_root/release.json"
REMOTE_SCRIPT

verify_dir="$(mktemp -d)"
trap 'rm -rf -- "$verify_dir"; cleanup_remote' EXIT
curl -fsSL --retry 3 -H 'Cache-Control: no-cache' \
  "$UPDATE_SERVER_BASE_URL/release.json" -o "$verify_dir/release.json"
curl -fsSL --retry 3 \
  "$UPDATE_SERVER_BASE_URL/releases/$release_tag/$apk_asset" -o "$verify_dir/$apk_asset"
node -e '
  const crypto = require("crypto");
  const fs = require("fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const apk = fs.readFileSync(process.argv[2]);
  const hash = crypto.createHash("sha256").update(apk).digest("hex");
  if (manifest.releaseTag !== process.argv[3] || manifest.apkAsset !== process.argv[4] ||
      manifest.sha256 !== hash || manifest.sizeBytes !== apk.length) process.exit(1);
' "$verify_dir/release.json" "$verify_dir/$apk_asset" "$release_tag" "$apk_asset"

echo "Published Android update: $UPDATE_SERVER_BASE_URL/releases/$release_tag/$apk_asset"
echo "Downloaded by the production server from: $github_release_base"

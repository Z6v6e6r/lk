#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: install_lk1_subscription_dev_bootstrap.sh --bundle <directory> --manifest-sha256 <sha> --apply" >&2
  exit 64
}

fail() {
  echo "$1" >&2
  exit "${2:-78}"
}

[[ $# -eq 5 && "$1" == "--bundle" && "$3" == "--manifest-sha256" && "$5" == "--apply" ]] || usage
BUNDLE="$(realpath -e -- "$2")"
EXPECTED_MANIFEST_SHA="$4"
EXPECTED_BUNDLE="/tmp/lk1-subscription-dev-bootstrap-$EXPECTED_MANIFEST_SHA"
TARGET_ROOT="/srv/lk1-subscription-dev"
TARGET_MARKER="$TARGET_ROOT/bootstrap-evidence/installed-from-manifest.sha256"
STAGING_ROOT="/srv/.lk1-subscription-dev.bootstrap-$EXPECTED_MANIFEST_SHA"
STAGING_MARKER="$STAGING_ROOT/bootstrap-evidence/installed-from-manifest.sha256"
AUTHORIZATION_MARKER="$TARGET_ROOT/authorization/service-start.approved"
EXPECTED_HOSTNAME="89-108-64-209.cloudvps.regruhosting.ru"
NODE_RED_ARCHIVE="/tmp/lk1-node-red-4.0.9-bootstrap.tgz"
UNITS=(
  lk1-subscription-dev-mongo.service
  lk1-subscription-dev-cup.service
  lk1-subscription-dev-provider-fixture.service
  lk1-subscription-dev-identity-fixture.service
  lk1-subscription-dev-nodered.service
)
PORTS=(1882 27030 3037 3038 3039)

[[ "$EXPECTED_MANIFEST_SHA" =~ ^[a-f0-9]{64}$ ]] || fail "manifest SHA must be exact lowercase hex" 65
[[ "$BUNDLE" == "$EXPECTED_BUNDLE" ]] || fail "bundle path is not the exact manifest-bound path" 65
[[ "$(id -u)" -eq 0 ]] || fail "installer must run as root" 77
[[ "$(hostname)" == "$EXPECTED_HOSTNAME" ]] || fail "target hostname mismatch"
[[ "$(stat -c %u "$BUNDLE")" == "0" && "$(stat -c %a "$BUNDLE")" == "700" ]] || fail "bundle root must be root-owned mode 0700"
[[ -z "$(find "$BUNDLE" -xdev ! -user root -print -quit)" ]] || fail "bundle contains non-root-owned content"
[[ -z "$(find "$BUNDLE" -xdev -type l -print -quit)" ]] || fail "bundle contains symlinks"
[[ -z "$(find "$BUNDLE" -xdev -perm /022 -print -quit)" ]] || fail "bundle contains group/world-writable content"
[[ "$(sha256sum "$BUNDLE/manifest.json" | cut -d' ' -f1)" == "$EXPECTED_MANIFEST_SHA" ]] || fail "bootstrap manifest SHA mismatch"
[[ "$(sha256sum /usr/bin/node | cut -d' ' -f1)" == "8f4e416b508c3c149ad62d13c37b83a61f24c40058ed3bb07fe298d9d228cd3a" ]] || fail "Node dependency drift"

manifest_value() {
  /usr/bin/node -e 'const fs=require("fs");const [file,kind,key]=process.argv.slice(1);const value=JSON.parse(fs.readFileSync(file,"utf8"));if(kind==="file"){const row=value.files.find((item)=>item.path===key);if(!row?.sha256)process.exit(2);process.stdout.write(row.sha256)}else if(kind==="root"&&typeof value[key]==="string"){process.stdout.write(value[key])}else process.exit(2)' "$BUNDLE/manifest.json" "$1" "$2"
}

INSTALLER_EXPECTED_SHA="$(manifest_value file payload/install_lk1_subscription_dev_bootstrap.sh)"
VERIFIER_EXPECTED_SHA="$(manifest_value file payload/verify_lk1_subscription_dev_bootstrap.mjs)"
[[ "$(sha256sum "$BUNDLE/payload/install_lk1_subscription_dev_bootstrap.sh" | cut -d' ' -f1)" == "$INSTALLER_EXPECTED_SHA" ]] || fail "bootstrap installer SHA mismatch"
[[ "$(sha256sum "$BUNDLE/payload/verify_lk1_subscription_dev_bootstrap.mjs" | cut -d' ' -f1)" == "$VERIFIER_EXPECTED_SHA" ]] || fail "bootstrap verifier SHA mismatch"

exec 9>/run/lock/lk1-subscription-dev-bootstrap.lock
flock -n 9 || fail "another bootstrap installer owns the host lock" 75

export LK1_BOOTSTRAP_MANIFEST_SHA256="$EXPECTED_MANIFEST_SHA"
/usr/bin/node "$BUNDLE/payload/verify_lk1_subscription_dev_bootstrap.mjs" --bundle "$BUNDLE"
[[ "$(stat -c %F:%U:%G:%a:%s "$NODE_RED_ARCHIVE")" == "regular file:root:root:644:19532194" ]] || fail "Node-RED source archive custody or size drift"
[[ "$(sha256sum /opt/phab-subscriptions-dev/runtime/mongodb/bin/mongod | cut -d' ' -f1)" == "14df921651e73e17384ec9436657a7774c6ca6ebc7a614e0536e4183ed99b825" ]] || fail "Mongo dependency drift"
[[ "$(stat -c %s /opt/phab-subscriptions-dev/runtime/mongodb/bin/mongod)" == "184369384" ]] || fail "Mongo dependency size drift"

[[ ! -e "$AUTHORIZATION_MARKER" ]] || fail "service-start marker must be absent"
for port in "${PORTS[@]}"; do
  if ss -H -ltn | awk '{print $4}' | grep -Eq "(^|:)$port$"; then
    fail "planned listener is occupied: $port" 73
  fi
done
for unit in "${UNITS[@]}"; do
  [[ "$(systemctl is-active "$unit" 2>/dev/null || true)" != "active" ]] || fail "unit is unexpectedly active: $unit" 73
  [[ "$(systemctl is-enabled "$unit" 2>/dev/null || true)" != "enabled" ]] || fail "unit is unexpectedly enabled: $unit" 73
  if [[ -e "/etc/systemd/system/$unit" ]]; then
    cmp -s "$BUNDLE/payload/units/$unit" "/etc/systemd/system/$unit" || fail "existing unit differs from authorized bytes: $unit" 73
  fi
done

if getent group lk1-subscription-dev >/dev/null; then
  [[ -z "$(getent group lk1-subscription-dev | cut -d: -f4)" ]] || fail "existing target group has supplementary members" 73
else
  groupadd --system lk1-subscription-dev
fi
TARGET_GID="$(getent group lk1-subscription-dev | cut -d: -f3)"
if getent passwd lk1-subscription-dev >/dev/null; then
  IFS=: read -r _ _ _ EXISTING_GID _ EXISTING_HOME EXISTING_SHELL < <(getent passwd lk1-subscription-dev)
  [[ "$EXISTING_GID" == "$TARGET_GID" && "$EXISTING_HOME" == "$TARGET_ROOT" && "$EXISTING_SHELL" == "/usr/sbin/nologin" ]] || fail "existing target user identity mismatch" 73
else
  useradd --system --gid lk1-subscription-dev --home-dir "$TARGET_ROOT" --shell /usr/sbin/nologin --no-create-home lk1-subscription-dev
fi

if [[ -e "$TARGET_ROOT" ]]; then
  [[ -f "$TARGET_MARKER" && "$(cat "$TARGET_MARKER")" == "$EXPECTED_MANIFEST_SHA" ]] || fail "existing target root lacks exact resumable bootstrap marker" 73
  [[ "$(stat -c %U:%G:%a "$TARGET_ROOT")" == "root:lk1-subscription-dev:750" ]] || fail "existing target root custody mismatch" 73
else
  if [[ -e "$STAGING_ROOT" ]]; then
    [[ -f "$STAGING_MARKER" && "$(cat "$STAGING_MARKER")" == "$EXPECTED_MANIFEST_SHA" ]] || fail "existing staging root lacks exact resumable bootstrap marker" 73
    [[ "$(stat -c %U:%G:%a "$STAGING_ROOT")" == "root:lk1-subscription-dev:750" ]] || fail "existing staging root custody mismatch" 73
  else
    install -d -o root -g lk1-subscription-dev -m 0750 "$STAGING_ROOT"
    install -d -o root -g root -m 0700 "$STAGING_ROOT/bootstrap-evidence"
    printf '%s\n' "$EXPECTED_MANIFEST_SHA" > "$STAGING_MARKER"
    chmod 0600 "$STAGING_MARKER"
  fi
  mv "$STAGING_ROOT" "$TARGET_ROOT"
fi

install -d -o root -g root -m 0700 "$TARGET_ROOT/authorization" "$TARGET_ROOT/bootstrap-evidence" "$TARGET_ROOT/bootstrap-evidence/dependencies"
install -d -o root -g lk1-subscription-dev -m 0750 "$TARGET_ROOT/runtime" "$TARGET_ROOT/runtime/node" "$TARGET_ROOT/runtime/node/bin" "$TARGET_ROOT/runtime/mongodb" "$TARGET_ROOT/runtime/mongodb/bin" "$TARGET_ROOT/fixtures" "$TARGET_ROOT/node-red"
install -d -o lk1-subscription-dev -g lk1-subscription-dev -m 0700 "$TARGET_ROOT/mongo" "$TARGET_ROOT/evidence"

install -o root -g root -m 0555 /usr/bin/node "$TARGET_ROOT/runtime/node/bin/node"
install -o root -g root -m 0555 /opt/phab-subscriptions-dev/runtime/mongodb/bin/mongod "$TARGET_ROOT/runtime/mongodb/bin/mongod"
install -o root -g root -m 0600 "$NODE_RED_ARCHIVE" "$TARGET_ROOT/bootstrap-evidence/dependencies/node-red-4.0.9.tgz"
install -o root -g lk1-subscription-dev -m 0550 "$BUNDLE/payload/fixtures/locked_fixture_runtime.mjs" "$TARGET_ROOT/fixtures/locked_fixture_runtime.mjs"
install -o root -g lk1-subscription-dev -m 0640 "$BUNDLE/payload/node-red/settings.js" "$TARGET_ROOT/node-red/settings.js"
SEALED_NODE_RED_ARCHIVE="$TARGET_ROOT/bootstrap-evidence/dependencies/node-red-4.0.9.tgz"
[[ "$(stat -c %U:%G:%a:%s "$SEALED_NODE_RED_ARCHIVE")" == "root:root:600:19532194" ]] || fail "sealed Node-RED archive custody or size drift"
[[ "$(sha256sum "$SEALED_NODE_RED_ARCHIVE" | cut -d' ' -f1)" == "3e36bf948f2e97b4988bdb55566957bce8992439759f4cd9785ed4523142490c" ]] || fail "sealed Node-RED archive drift"
PACKAGE_ROWS=0
while IFS= read -r entry; do
  [[ "$entry" == node-red/* && "$entry" != /* && "$entry" != *"/../"* && "$entry" != ../* ]] || fail "sealed Node-RED archive path escaped package root"
  [[ "$entry" == "node-red/package.json" ]] && PACKAGE_ROWS=$((PACKAGE_ROWS + 1))
done < <(tar -tzf "$SEALED_NODE_RED_ARCHIVE")
[[ "$PACKAGE_ROWS" -eq 1 ]] || fail "sealed Node-RED archive package identity is ambiguous"
tar -xzf "$SEALED_NODE_RED_ARCHIVE" -C "$TARGET_ROOT/runtime"
chown -R root:root "$TARGET_ROOT/runtime/node-red"
chmod -R go-w "$TARGET_ROOT/runtime/node-red"

while IFS= read -r -d '' link; do
  RESOLVED_LINK="$(realpath -m "$link")"
  [[ "$RESOLVED_LINK" == "$TARGET_ROOT/runtime/node-red/"* ]] || fail "Node-RED symlink escapes installed package"
done < <(find "$TARGET_ROOT/runtime/node-red" -type l -print0)
[[ -z "$(find "$TARGET_ROOT/runtime/node-red" -type f -perm /022 -print -quit)" ]] || fail "installed Node-RED contains writable executable content"
[[ "$(sha256sum "$TARGET_ROOT/runtime/node/bin/node" | cut -d' ' -f1)" == "8f4e416b508c3c149ad62d13c37b83a61f24c40058ed3bb07fe298d9d228cd3a" ]] || fail "installed Node drift"
[[ "$(sha256sum "$SEALED_NODE_RED_ARCHIVE" | cut -d' ' -f1)" == "3e36bf948f2e97b4988bdb55566957bce8992439759f4cd9785ed4523142490c" ]] || fail "sealed Node-RED archive changed after extraction"
[[ "$(sha256sum "$TARGET_ROOT/runtime/node-red/package.json" | cut -d' ' -f1)" == "d425a214f90741d4e9ef4b5dab3854d00d653520f6f9f32591ef39573546c302" ]] || fail "installed Node-RED package drift"
[[ "$(sha256sum "$TARGET_ROOT/runtime/mongodb/bin/mongod" | cut -d' ' -f1)" == "14df921651e73e17384ec9436657a7774c6ca6ebc7a614e0536e4183ed99b825" ]] || fail "installed Mongo drift"

for unit in "${UNITS[@]}"; do
  install -o root -g root -m 0644 "$BUNDLE/payload/units/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload

for unit in "${UNITS[@]}"; do
  [[ "$(systemctl is-enabled "$unit" 2>/dev/null || true)" == "disabled" ]] || fail "unit unexpectedly enabled: $unit"
  [[ "$(systemctl is-active "$unit" 2>/dev/null || true)" == "inactive" ]] || fail "unit unexpectedly active: $unit"
done
[[ ! -e "$AUTHORIZATION_MARKER" ]] || fail "service-start marker unexpectedly exists"
for port in "${PORTS[@]}"; do
  if ss -H -ltn | awk '{print $4}' | grep -Eq "(^|:)$port$"; then
    fail "planned listener opened during stopped bootstrap: $port"
  fi
done

SOURCE_COMMIT="$(manifest_value root sourceCommit)"
PROVISIONING_SHA="$(manifest_value root provisioningContractSha256)"
INSTALLED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
EVIDENCE_TMP="$TARGET_ROOT/bootstrap-evidence/bootstrap-install.json.tmp"
EVIDENCE="$TARGET_ROOT/bootstrap-evidence/bootstrap-install.json"
printf '{\n  "formatVersion": 1,\n  "stage": "STOPPED_BOOTSTRAP",\n  "environment": "DEV",\n  "installedAt": "%s",\n  "sourceCommit": "%s",\n  "manifestSha256": "%s",\n  "provisioningContractSha256": "%s",\n  "nodeSha256": "8f4e416b508c3c149ad62d13c37b83a61f24c40058ed3bb07fe298d9d228cd3a",\n  "nodeRedArchiveSha256": "3e36bf948f2e97b4988bdb55566957bce8992439759f4cd9785ed4523142490c",\n  "nodeRedPackageJsonSha256": "d425a214f90741d4e9ef4b5dab3854d00d653520f6f9f32591ef39573546c302",\n  "mongoSha256": "14df921651e73e17384ec9436657a7774c6ca6ebc7a614e0536e4183ed99b825",\n  "servicesEnabled": false,\n  "servicesActive": false,\n  "listenersOpen": false,\n  "serviceStartAuthorized": false,\n  "ingressChanged": false,\n  "activationChanged": false,\n  "canaryIdsInstalled": false,\n  "secretsInstalled": false\n}\n' "$INSTALLED_AT" "$SOURCE_COMMIT" "$EXPECTED_MANIFEST_SHA" "$PROVISIONING_SHA" > "$EVIDENCE_TMP"
chmod 0600 "$EVIDENCE_TMP"
mv "$EVIDENCE_TMP" "$EVIDENCE"

echo "LK1_DEV_BOOTSTRAP=INSTALLED_STOPPED"
echo "manifestSha256=$EXPECTED_MANIFEST_SHA"
echo "serviceStartAuthorized=false"
echo "servicesEnabled=false"
echo "servicesActive=false"
echo "listenersOpen=false"

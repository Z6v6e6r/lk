#!/usr/bin/env bash

set -euo pipefail
umask 077

if [[ $# -ne 2 ]]; then
  echo "Usage: install_mongodb_logging_guard_147_remote.sh STAGE_DIR BACKUP_STAMP" >&2
  exit 2
fi

stage_dir="$1"
backup_stamp="$2"
user_dir="/root/.node-red"
module_path="$user_dir/node_modules/@pafum/node-red-node-mongodb/66-mongodb.js"
package_path="$user_dir/package.json"
flows_path="$user_dir/flows.json"
install_directory="$user_dir/.padlhub-runtime-hardening"
installed_guard="$install_directory/harden_mongodb_logging.cjs"
installer="$stage_dir/install_mongodb_logging_guard.mjs"
guard_source="$stage_dir/harden_mongodb_logging.cjs"
backup_directory="/root/codex-backups"
package_backup="$backup_directory/node-red-package-pre-mongodb-log-guard-$backup_stamp.json"
module_backup="$backup_directory/66-mongodb-pre-durable-log-guard-$backup_stamp.js"
installed_guard_backup="$backup_directory/harden-mongodb-logging-pre-update-$backup_stamp.cjs"
expected_postinstall="node ./.padlhub-runtime-hardening/harden_mongodb_logging.cjs --user-dir ."
expected_node_arg="--disable-warning=DEP0170"
success=0
restart_attempted=0
install_directory_existed=0
installed_guard_existed=0

case "$stage_dir" in
  /root/.node-red/.padlhub-mongodb-log-guard-stage-*) ;;
  *) echo "Unexpected stage directory" >&2; exit 3 ;;
esac
if [[ ! "$backup_stamp" =~ ^[0-9]{8}T[0-9]{6}[+]0300$ ]]; then
  echo "Unexpected backup stamp" >&2
  exit 4
fi

for file in "$installer" "$guard_source" "$module_path" "$package_path" "$flows_path"; do
  if [[ ! -f "$file" || -L "$file" ]]; then
    echo "Required regular file is missing" >&2
    exit 5
  fi
done
if [[ -e "$package_backup" || -e "$module_backup" || -e "$installed_guard_backup" ]]; then
  echo "Backup target already exists" >&2
  exit 6
fi
if [[ -e "$install_directory" || -L "$install_directory" ]]; then
  if [[ ! -d "$install_directory" || -L "$install_directory" ]]; then
    echo "Runtime hardening directory is not a real directory" >&2
    exit 7
  fi
  install_directory_existed=1
fi
if [[ -e "$installed_guard" || -L "$installed_guard" ]]; then
  if [[ ! -f "$installed_guard" || -L "$installed_guard" ]]; then
    echo "Installed runtime guard is not a regular file" >&2
    exit 8
  fi
  installed_guard_existed=1
fi
package_mode="$(stat -c %a "$package_path")"
module_mode="$(stat -c %a "$module_path")"

rollback() {
  exit_code=$?
  if [[ "$success" != "1" ]]; then
    if [[ -f "$package_backup" ]]; then
      cat "$package_backup" > "$package_path" || true
      chmod "$package_mode" "$package_path" || true
    fi
    if [[ -f "$module_backup" ]]; then
      cat "$module_backup" > "$module_path" || true
      chmod "$module_mode" "$module_path" || true
    fi
    if [[ "$installed_guard_existed" == "1" && -f "$installed_guard_backup" ]]; then
      cat "$installed_guard_backup" > "$installed_guard" || true
      chmod 700 "$installed_guard" || true
    elif [[ "$installed_guard_existed" == "0" ]]; then
      rm -f "$installed_guard" 2>/dev/null || true
    fi
    if [[ "$install_directory_existed" == "0" ]]; then
      rmdir "$install_directory" 2>/dev/null || true
    fi
    if [[ "$restart_attempted" == "1" ]]; then
      pm2 start node-red --node-args="$expected_node_arg" --update-env >/dev/null 2>&1 || true
    fi
  fi
  exit "$exit_code"
}
trap rollback EXIT

install -d -m 700 "$backup_directory"
cp --preserve=mode,timestamps "$package_path" "$package_backup"
cp --preserve=mode,timestamps "$module_path" "$module_backup"
chmod 600 "$package_backup" "$module_backup"
if [[ "$installed_guard_existed" == "1" ]]; then
  cp --preserve=mode,timestamps "$installed_guard" "$installed_guard_backup"
  chmod 600 "$installed_guard_backup"
fi

flow_sha_before="$(sha256sum "$flows_path" | awk '{print $1}')"
node "$installer" --user-dir "$user_dir" --guard-source "$guard_source"
node "$installed_guard" --user-dir "$user_dir" --check

node -e '
  const fs = require("fs");
  const [packagePath, expectedPostinstall] = process.argv.slice(1);
  const value = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const actual = value?.scripts?.postinstall;
  if (
    actual !== expectedPostinstall
    && !String(actual || "").startsWith(`${expectedPostinstall} && `)
  ) process.exit(21);
' "$package_path" "$expected_postinstall"

restart_attempted=1
pm2 restart node-red --node-args="$expected_node_arg" --update-env >/dev/null
pm2 save >/dev/null

pm2 jlist | node -e '
  let source = "";
  process.stdin.on("data", (chunk) => { source += chunk; });
  process.stdin.on("end", () => {
    const expectedArg = process.argv[1];
    const processInfo = JSON.parse(source).find((item) => item.name === "node-red");
    const args = Array.isArray(processInfo?.pm2_env?.node_args) ? processInfo.pm2_env.node_args : [];
    if (processInfo?.pm2_env?.status !== "online") process.exit(22);
    if (args.length !== 1 || args[0] !== expectedArg) process.exit(23);
  });
' "$expected_node_arg"

remaining_uri_count=0
while IFS= read -r -d '' log_file; do
  count="$(perl -ne '$count += () = /mongodb(?:\+srv)?:\/\/\S+/g; END { print(($count || 0), "\n") }' "$log_file")"
  remaining_uri_count=$((remaining_uri_count + count))
done < <(find /root/.pm2/logs -maxdepth 1 -type f -name 'node-red*.log' -print0)
while IFS= read -r -d '' log_file; do
  count="$(gzip -dc < "$log_file" | perl -ne '$count += () = /mongodb(?:\+srv)?:\/\/\S+/g; END { print(($count || 0), "\n") }')"
  remaining_uri_count=$((remaining_uri_count + count))
done < <(find /root/.pm2/logs -maxdepth 1 -type f -name 'node-red*.gz' -print0)
if (( remaining_uri_count != 0 )); then
  echo "MongoDB URI remains in Node-RED logs" >&2
  exit 24
fi

flow_sha_after="$(sha256sum "$flows_path" | awk '{print $1}')"
if [[ "$flow_sha_after" != "$flow_sha_before" ]]; then
  echo "Node-RED flow changed during runtime hardening" >&2
  exit 25
fi

success=1
echo "flowSha256=$flow_sha_after"
echo "mongodbUrisRemaining=$remaining_uri_count"
echo "packageBackup=$package_backup"
echo "moduleBackup=$module_backup"

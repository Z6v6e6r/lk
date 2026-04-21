#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash ./scripts/package-lk-upload.sh <prod|dev|all>

Creates:
  dist/deploy/lk-upload-<channel>-<timestamp>.tar.gz

The archive includes:
  - selected LK bundles from dist/
  - server-install-lk.sh
EOF
}

if [[ $# -ne 1 ]]; then
  usage
  exit 1
fi

channel="$1"
if [[ "$channel" != "prod" && "$channel" != "dev" && "$channel" != "all" ]]; then
  echo "Unknown channel: $channel" >&2
  usage
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist_dir="$repo_root/dist"
package_dir="$dist_dir/deploy"
staging_dir="$package_dir/staging-$channel"
timestamp="$(date -u '+%Y%m%dT%H%M%SZ')"
archive_name="lk-upload-$channel-$timestamp.tar.gz"
archive_path="$package_dir/$archive_name"

prod_files=(
  "bundle.js"
  "games.js"
  "tournaments.js"
  "onboarding.js"
  "communities.js"
  "release.json"
)

dev_files=(
  "bundle-dev.js"
  "games-dev.js"
  "tournaments-dev.js"
  "onboarding-dev.js"
  "communities-dev.js"
  "release-dev.json"
)

files=()
case "$channel" in
  prod)
    files=("${prod_files[@]}")
    ;;
  dev)
    files=("${dev_files[@]}")
    ;;
  all)
    files=("${prod_files[@]}" "${dev_files[@]}")
    ;;
esac

missing_files=()
for file_name in "${files[@]}"; do
  if [[ ! -f "$dist_dir/$file_name" ]]; then
    missing_files+=("$dist_dir/$file_name")
  fi
done

if [[ ! -f "$repo_root/scripts/server-install-lk.sh" ]]; then
  missing_files+=("$repo_root/scripts/server-install-lk.sh")
fi

if [[ ${#missing_files[@]} -gt 0 ]]; then
  echo "Missing files for packaging:" >&2
  for file_path in "${missing_files[@]}"; do
    echo "  $file_path" >&2
  done
  echo "Run 'npm run build' first if dist/ is missing." >&2
  exit 1
fi

rm -rf "$staging_dir"
mkdir -p "$staging_dir"

for file_name in "${files[@]}"; do
  cp "$dist_dir/$file_name" "$staging_dir/$file_name"
done

cp "$repo_root/scripts/server-install-lk.sh" "$staging_dir/server-install-lk.sh"
chmod +x "$staging_dir/server-install-lk.sh"

cat > "$staging_dir/README.txt" <<EOF
1. Upload this archive to the server.
2. Unpack it into a temporary folder, for example:
   tar -xzf $archive_name
3. Run:
   bash ./server-install-lk.sh $channel

Optional:
  bash ./server-install-lk.sh $channel --target-dir /var/www/html/lk --dry-run
EOF

mkdir -p "$package_dir"
tar -czf "$archive_path" -C "$staging_dir" .
rm -rf "$staging_dir"

echo "Package created: $archive_path"

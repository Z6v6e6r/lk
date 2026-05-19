#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash ./scripts/deploy-lk.sh <prod|dev|all> [--dry-run]

Environment overrides:
  DEPLOY_HOST=147.45.103.3
  DEPLOY_USER=root
  DEPLOY_PATH=/var/www/html/lk
  DEPLOY_PORT=22
  DEPLOY_USE_SUDO=0

Examples:
  bash ./scripts/deploy-lk.sh prod
  bash ./scripts/deploy-lk.sh dev
  bash ./scripts/deploy-lk.sh all
  DEPLOY_USE_SUDO=1 bash ./scripts/deploy-lk.sh all
  DEPLOY_HOST=example.com DEPLOY_USER=deploy bash ./scripts/deploy-lk.sh prod --dry-run
EOF
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 1
fi

channel="$1"
dry_run="${2:-}"

if [[ "$channel" != "prod" && "$channel" != "dev" && "$channel" != "all" ]]; then
  echo "Unknown channel: $channel" >&2
  usage
  exit 1
fi

if [[ -n "$dry_run" && "$dry_run" != "--dry-run" ]]; then
  echo "Unknown option: $dry_run" >&2
  usage
  exit 1
fi

deploy_host="${DEPLOY_HOST:-147.45.103.3}"
deploy_user="${DEPLOY_USER:-root}"
deploy_path="${DEPLOY_PATH:-/var/www/html/lk}"
deploy_port="${DEPLOY_PORT:-22}"
deploy_use_sudo="${DEPLOY_USE_SUDO:-0}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist_dir="$repo_root/dist"

prod_files=(
  "$dist_dir/bundle.js"
  "$dist_dir/games.js"
  "$dist_dir/tournaments.js"
  "$dist_dir/onboarding.js"
  "$dist_dir/levels-info.js"
  "$dist_dir/communities.js"
  "$dist_dir/release.json"
)

dev_files=(
  "$dist_dir/bundle-dev.js"
  "$dist_dir/games-dev.js"
  "$dist_dir/tournaments-dev.js"
  "$dist_dir/onboarding-dev.js"
  "$dist_dir/levels-info-dev.js"
  "$dist_dir/communities-dev.js"
  "$dist_dir/release-dev.json"
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
for file_path in "${files[@]}"; do
  if [[ ! -f "$file_path" ]]; then
    missing_files+=("$file_path")
  fi
done

if [[ ${#missing_files[@]} -gt 0 ]]; then
  echo "Missing build artifacts:" >&2
  for file_path in "${missing_files[@]}"; do
    echo "  $file_path" >&2
  done
  echo "Run 'npm run build' first." >&2
  exit 1
fi

scp_cmd=(scp -P "$deploy_port")
if [[ "$deploy_use_sudo" == "1" ]]; then
  scp_cmd=(sudo "${scp_cmd[@]}")
fi

target="${deploy_user}@${deploy_host}:${deploy_path}/"

echo "Deploy target: $target"
echo "Channel: $channel"
echo "Files:"
for file_path in "${files[@]}"; do
  echo "  - $(basename "$file_path")"
done

if [[ "$dry_run" == "--dry-run" ]]; then
  echo
  echo "Dry run command:"
  printf '  %q' "${scp_cmd[@]}" "${files[@]}" "$target"
  echo
  exit 0
fi

"${scp_cmd[@]}" "${files[@]}" "$target"

echo
echo "Deploy finished."

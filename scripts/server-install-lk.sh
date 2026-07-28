#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash ./server-install-lk.sh <prod|dev|all> [--source-dir DIR] [--target-dir DIR] [--dry-run]

Environment overrides:
  SOURCE_DIR=/root/lk-upload
  TARGET_DIR=/var/www/html/lk
  BACKUP_DIR=/var/www/html/lk/.deploy-backups

Examples:
  bash ./server-install-lk.sh prod
  bash ./server-install-lk.sh all --source-dir /root/lk-upload
  TARGET_DIR=/srv/www/lk bash ./server-install-lk.sh dev --dry-run
EOF
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

channel="$1"
shift

if [[ "$channel" != "prod" && "$channel" != "dev" && "$channel" != "all" ]]; then
  echo "Unknown channel: $channel" >&2
  usage
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_dir="${SOURCE_DIR:-$script_dir}"
target_dir="${TARGET_DIR:-/var/www/html/lk}"
backup_dir="${BACKUP_DIR:-$target_dir/.deploy-backups}"
dry_run=0
font_files=(
  "rf-dewi-ultrabold.woff2"
  "rf-dewi-expanded-ultrabold-italic.woff2"
  "SourceCodePro-Medium.woff2"
  "SourceCodePro-Regular.woff2"
)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-dir)
      source_dir="${2:?Missing value for --source-dir}"
      shift 2
      ;;
    --target-dir)
      target_dir="${2:?Missing value for --target-dir}"
      backup_dir="${BACKUP_DIR:-$target_dir/.deploy-backups}"
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

prod_files=(
  "bundle.js"
  "games.js"
  "tournaments.js"
  "tournament-signup.js"
  "group-schedule.js"
  "padel-day-schedule.js"
  "tournament-subscription.js"
  "tournament-subscription-referral.js"
  "onboarding.js"
  "levels-info.js"
  "communities.js"
  "release.json"
)

dev_files=(
  "bundle-dev.js"
  "games-dev.js"
  "tournaments-dev.js"
  "tournament-signup-dev.js"
  "group-schedule-dev.js"
  "padel-day-schedule-dev.js"
  "tournament-subscription-dev.js"
  "tournament-subscription-referral-dev.js"
  "onboarding-dev.js"
  "levels-info-dev.js"
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
  if [[ ! -f "$source_dir/$file_name" ]]; then
    missing_files+=("$source_dir/$file_name")
  fi
done

for file_name in "${font_files[@]}"; do
  if [[ ! -f "$source_dir/fonts/$file_name" ]]; then
    missing_files+=("$source_dir/fonts/$file_name")
  fi
done

if [[ ${#missing_files[@]} -gt 0 ]]; then
  echo "Missing upload files:" >&2
  for file_path in "${missing_files[@]}"; do
    echo "  $file_path" >&2
  done
  exit 1
fi

timestamp="$(date -u '+%Y%m%dT%H%M%SZ')"
backup_target="$backup_dir/$timestamp"

echo "Source: $source_dir"
echo "Target: $target_dir"
echo "Backup: $backup_target"
echo "Channel: $channel"
echo "Files:"
for file_name in "${files[@]}"; do
  echo "  - $file_name"
done
echo "Fonts:"
for file_name in "${font_files[@]}"; do
  echo "  - fonts/$file_name"
done

if [[ "$dry_run" == "1" ]]; then
  echo
  echo "Dry run only. No files changed."
  exit 0
fi

mkdir -p "$target_dir" "$target_dir/fonts" "$backup_target" "$backup_target/fonts"

for file_name in "${files[@]}"; do
  if [[ -f "$target_dir/$file_name" ]]; then
    cp -p "$target_dir/$file_name" "$backup_target/$file_name"
  fi
done

for file_name in "${font_files[@]}"; do
  if [[ -f "$target_dir/fonts/$file_name" ]]; then
    cp -p "$target_dir/fonts/$file_name" "$backup_target/fonts/$file_name"
  fi
done

for file_name in "${files[@]}"; do
  install -m 0644 "$source_dir/$file_name" "$target_dir/$file_name"
done

for file_name in "${font_files[@]}"; do
  install -m 0644 "$source_dir/fonts/$file_name" "$target_dir/fonts/$file_name"
done

echo
echo "Install finished."
echo "Backup saved to: $backup_target"

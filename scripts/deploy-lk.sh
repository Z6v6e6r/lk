#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash ./scripts/deploy-lk.sh <prod|dev|all> [--dry-run]

Environment overrides:
  DEPLOY_TARGETS=lk-reserve-89:/var/www/html/lk,root@147.45.103.3:/var/www/html/lk
  DEPLOY_HOST=147.45.103.3
  DEPLOY_USER=root
  DEPLOY_PATH=/var/www/html/lk
  DEPLOY_PORT=22
  DEPLOY_USE_SUDO=0
  DEPLOY_PRUNE_OPPOSITE_CHANNEL=0
  DEPLOY_DIST_DIR=/absolute/path/to/dist
  DEPLOY_FONT_SOURCE_DIR=/absolute/path/to/fonts

Examples:
  bash ./scripts/deploy-lk.sh prod
  bash ./scripts/deploy-lk.sh dev
  bash ./scripts/deploy-lk.sh all
  DEPLOY_TARGETS='lk-reserve-89:/var/www/html/lk,root@147.45.103.3:/var/www/html/lk' bash ./scripts/deploy-lk.sh all
  DEPLOY_USE_SUDO=1 bash ./scripts/deploy-lk.sh all
  DEPLOY_HOST=example.com DEPLOY_USER=deploy bash ./scripts/deploy-lk.sh prod --dry-run
EOF
}

trim_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
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
deploy_prune_opposite_channel="${DEPLOY_PRUNE_OPPOSITE_CHANNEL:-0}"
deploy_targets_raw="${DEPLOY_TARGETS:-}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist_dir="${DEPLOY_DIST_DIR:-$repo_root/dist}"
font_source_dir="${DEPLOY_FONT_SOURCE_DIR:-$repo_root/src/fonts}"
font_files=(
  "$font_source_dir/rf-dewi-ultrabold.woff2"
  "$font_source_dir/rf-dewi-expanded-ultrabold-italic.woff2"
  "$font_source_dir/SourceCodePro-Medium.woff2"
  "$font_source_dir/SourceCodePro-Regular.woff2"
)

prod_files=(
  "$dist_dir/bundle.js"
  "$dist_dir/games.js"
  "$dist_dir/tournaments.js"
  "$dist_dir/tournament-signup.js"
  "$dist_dir/group-schedule.js"
  "$dist_dir/padel-day-schedule.js"
  "$dist_dir/tournament-subscription.js"
  "$dist_dir/tournament-subscription-referral.js"
  "$dist_dir/onboarding.js"
  "$dist_dir/levels-info.js"
  "$dist_dir/communities.js"
  "$dist_dir/release.json"
)

dev_files=(
  "$dist_dir/bundle-dev.js"
  "$dist_dir/games-dev.js"
  "$dist_dir/tournaments-dev.js"
  "$dist_dir/tournament-signup-dev.js"
  "$dist_dir/group-schedule-dev.js"
  "$dist_dir/padel-day-schedule-dev.js"
  "$dist_dir/tournament-subscription-dev.js"
  "$dist_dir/tournament-subscription-referral-dev.js"
  "$dist_dir/onboarding-dev.js"
  "$dist_dir/levels-info-dev.js"
  "$dist_dir/communities-dev.js"
  "$dist_dir/release-dev.json"
)

files=()
prune_files=()
case "$channel" in
  prod)
    files=("${prod_files[@]}")
    if [[ "$deploy_prune_opposite_channel" == "1" ]]; then
      prune_files=("${dev_files[@]}")
    fi
    ;;
  dev)
    files=("${dev_files[@]}")
    if [[ "$deploy_prune_opposite_channel" == "1" ]]; then
      prune_files=("${prod_files[@]}")
    fi
    ;;
  all)
    files=("${prod_files[@]}" "${dev_files[@]}")
    ;;
esac

manifest_files=()
case "$channel" in
  prod)
    manifest_files=("dist/release.json")
    ;;
  dev)
    manifest_files=("dist/release-dev.json")
    ;;
  all)
    manifest_files=("dist/release.json" "dist/release-dev.json")
    ;;
esac

missing_files=()
for file_path in "${files[@]}"; do
  if [[ ! -f "$file_path" ]]; then
    missing_files+=("$file_path")
  fi
done

for file_path in "${font_files[@]}"; do
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

node "$repo_root/scripts/assert-clean-deploy.mjs" "${manifest_files[@]}"

scp_cmd=(scp -P "$deploy_port")
ssh_cmd=(ssh -p "$deploy_port")
if [[ "$deploy_use_sudo" == "1" ]]; then
  scp_cmd=(sudo "${scp_cmd[@]}")
  ssh_cmd=(sudo "${ssh_cmd[@]}")
fi

target_specs=()
if [[ -n "$deploy_targets_raw" ]]; then
  normalized_targets="${deploy_targets_raw//$'\n'/,}"
  IFS=',' read -r -a raw_target_specs <<< "$normalized_targets"
  for raw_target_spec in "${raw_target_specs[@]}"; do
    target_spec="$(trim_whitespace "$raw_target_spec")"
    if [[ -n "$target_spec" ]]; then
      target_specs+=("$target_spec")
    fi
  done
else
  deploy_base_path="${deploy_path%/}"
  target_specs=("${deploy_user}@${deploy_host}:${deploy_base_path}")
fi

if [[ ${#target_specs[@]} -eq 0 ]]; then
  echo "No deploy targets configured." >&2
  exit 1
fi

remote_logins=()
remote_paths=()
resolved_targets=()
for target_spec in "${target_specs[@]}"; do
  if [[ "$target_spec" != *:* ]]; then
    echo "Invalid DEPLOY_TARGETS entry: $target_spec" >&2
    echo "Expected format: user@host:/absolute/path or host:/absolute/path" >&2
    exit 1
  fi

  remote_login="${target_spec%%:*}"
  remote_path="${target_spec#*:}"
  remote_path="${remote_path%/}"

  if [[ -z "$remote_login" || -z "$remote_path" ]]; then
    echo "Invalid DEPLOY_TARGETS entry: $target_spec" >&2
    exit 1
  fi

  remote_logins+=("$remote_login")
  remote_paths+=("$remote_path")
  resolved_targets+=("${remote_login}:${remote_path}/")
done

build_prune_remote_cmd() {
  local remote_path="$1"
  shift
  local command="rm -f"
  local file_path

  for file_path in "$@"; do
    command+=" '$remote_path/$(basename "$file_path")'"
  done

  printf '%s' "$command"
}

echo "Channel: $channel"
echo "Deploy targets:"
for target in "${resolved_targets[@]}"; do
  echo "  - $target"
done
echo "Files:"
for file_path in "${files[@]}"; do
  echo "  - $(basename "$file_path")"
done
echo "Fonts:"
for file_path in "${font_files[@]}"; do
  echo "  - fonts/$(basename "$file_path")"
done
if [[ ${#prune_files[@]} -gt 0 ]]; then
  echo "Prune opposite-channel files:"
  for file_path in "${prune_files[@]}"; do
    echo "  - $(basename "$file_path")"
  done
fi

if [[ "$dry_run" == "--dry-run" ]]; then
  echo
  echo "Dry run commands:"
  for index in "${!remote_logins[@]}"; do
    remote_login="${remote_logins[$index]}"
    remote_path="${remote_paths[$index]}"
    target="${resolved_targets[$index]}"
    font_target="${remote_login}:${remote_path}/fonts/"

    echo "  # $target"
    printf '  %q' "${ssh_cmd[@]}" "$remote_login" "mkdir -p '$remote_path/fonts'"
    echo
    printf '  %q' "${scp_cmd[@]}" "${files[@]}" "$target"
    echo
    printf '  %q' "${scp_cmd[@]}" "${font_files[@]}" "$font_target"
    echo
    if [[ ${#prune_files[@]} -gt 0 ]]; then
      prune_cmd="$(build_prune_remote_cmd "$remote_path" "${prune_files[@]}")"
      printf '  %q' "${ssh_cmd[@]}" "$remote_login" "$prune_cmd"
      echo
    fi
  done
  exit 0
fi

for index in "${!remote_logins[@]}"; do
  remote_login="${remote_logins[$index]}"
  remote_path="${remote_paths[$index]}"
  target="${resolved_targets[$index]}"
  font_target="${remote_login}:${remote_path}/fonts/"

  echo
  echo "Deploying to $target"
  "${ssh_cmd[@]}" "$remote_login" "mkdir -p '$remote_path/fonts'"
  "${scp_cmd[@]}" "${files[@]}" "$target"
  "${scp_cmd[@]}" "${font_files[@]}" "$font_target"
  if [[ ${#prune_files[@]} -gt 0 ]]; then
    prune_cmd="$(build_prune_remote_cmd "$remote_path" "${prune_files[@]}")"
    "${ssh_cmd[@]}" "$remote_login" "$prune_cmd"
  fi
done

echo
echo "Deploy finished."

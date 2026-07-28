#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash ./scripts/deploy-lk-topology.sh <prod|dev|all> [--dry-run]

Topology defaults:
  prod -> lk-primary-147:/var/www/html/lk
  dev  -> lk-reserve-89:/var/www/html/lk
  all  -> prod to 147, dev to 89

Environment overrides:
  DEPLOY_TARGETS_PROD=lk-primary-147:/var/www/html/lk
  DEPLOY_TARGETS_DEV=lk-reserve-89:/var/www/html/lk

Examples:
  bash ./scripts/deploy-lk-topology.sh prod
  bash ./scripts/deploy-lk-topology.sh dev
  bash ./scripts/deploy-lk-topology.sh all
  DEPLOY_TARGETS_DEV='reserve.example:/srv/lk' bash ./scripts/deploy-lk-topology.sh dev --dry-run
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

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deploy_script="$script_dir/deploy-lk.sh"

prod_targets="${DEPLOY_TARGETS_PROD:-lk-primary-147:/var/www/html/lk}"
dev_targets="${DEPLOY_TARGETS_DEV:-lk-reserve-89:/var/www/html/lk}"
prune_opposite_channel="${DEPLOY_PRUNE_OPPOSITE_CHANNEL:-1}"

run_channel() {
  local target_channel="$1"
  local target_specs="$2"
  local args=("$target_channel")

  if [[ -n "$dry_run" ]]; then
    args+=("$dry_run")
  fi

  DEPLOY_TARGETS="$target_specs" DEPLOY_PRUNE_OPPOSITE_CHANNEL="$prune_opposite_channel" bash "$deploy_script" "${args[@]}"
}

case "$channel" in
  prod)
    run_channel "prod" "$prod_targets"
    ;;
  dev)
    run_channel "dev" "$dev_targets"
    ;;
  all)
    run_channel "prod" "$prod_targets"
    echo
    run_channel "dev" "$dev_targets"
    ;;
esac

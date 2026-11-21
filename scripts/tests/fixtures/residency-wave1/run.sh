#!/usr/bin/env bash
set -euo pipefail
umask 077

fixture_dir=$(cd "$(dirname "$0")" && pwd)
lk=$(cd "$fixture_dir/../../../.." && pwd)
work=$(dirname "$lk")
cup="$work/cup"
runtime="$work/runtime"
mongo_port=${RESIDENCY_STAND_MONGO_PORT:-24643}
lk_port=${RESIDENCY_STAND_LK_PORT:-24641}
cup_port=${RESIDENCY_STAND_CUP_PORT:-24642}
cup_sha=614258018b54c854aedd3f9fcb749bdeb77bcd73
container="padlhub-residency-wave1-${mongo_port}"
for port in "$mongo_port" "$lk_port" "$cup_port"; do
  [[ "$port" =~ ^[1-9][0-9]{3,4}$ ]] && (( port <= 65535 ))
done
[[ "$mongo_port" != "$lk_port" && "$mongo_port" != "$cup_port" && "$lk_port" != "$cup_port" ]]

if [[ ! -d "$cup" ]]; then
  git clone --quiet --no-checkout https://github.com/Z6v6e6r/ph-admin.git "$cup"
  git -C "$cup" fetch --quiet origin refs/pull/134/head
  git -C "$cup" checkout --quiet --detach "$cup_sha"
fi
[[ $(git -C "$cup" rev-parse --verify HEAD) == "$cup_sha" ]]
[[ -z $(git -C "$cup" status --porcelain --untracked-files=no) ]]

if [[ ! -f "$cup/node_modules/@nestjs/core/package.json" ]]; then
  npm --prefix "$cup" ci --ignore-scripts --no-audit --no-fund
fi
if [[ ! -f "$lk/node_modules/typescript/package.json" ]]; then
  npm --prefix "$lk" ci --ignore-scripts --no-audit --no-fund
fi
if [[ ! -f "$runtime/node_modules/node-red/package.json" ]]; then
  mkdir -p "$runtime"
  npm --prefix "$runtime" install --ignore-scripts --no-save --package-lock=false --no-audit --no-fund node-red@4.0.9
fi
node -e 'if (require(process.argv[1]).version !== "4.0.9") process.exit(1)' "$runtime/node_modules/node-red/package.json"

if ! docker container inspect "$container" >/dev/null 2>&1; then
  docker run -d --label 'padlhub.isolated=residency-wave1' --name "$container" \
    -p "127.0.0.1:$mongo_port:27017" mongo:8.0.5 >/dev/null
else
  [[ $(docker inspect --format '{{index .Config.Labels "padlhub.isolated"}}' "$container") == residency-wave1 ]]
  [[ $(docker inspect --format '{{.Config.Image}}' "$container") == mongo:8.0.5 ]]
  mapping=$(docker inspect --format '{{json .HostConfig.PortBindings}}' "$container")
  [[ "$mapping" == '{"27017/tcp":[{"HostIp":"127.0.0.1","HostPort":"'"$mongo_port"'"}]}' ]]
  docker start "$container" >/dev/null
fi
echo "Local Mongo container: $container. Stop with docker stop $container."
user_dir=$(mktemp -d "$work/nodered.XXXXXX")
exec node --experimental-strip-types "$fixture_dir/serve.cjs" "$cup" "$runtime" "$user_dir" "$mongo_port" "$lk_port" "$cup_port"

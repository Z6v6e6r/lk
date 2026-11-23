#!/bin/sh
set +x
set -eu
node=/usr/local/bin/node
selector=/opt/padlhub/lk147-node-red-launcher/select-profile.cjs

if [ "$#" -ne 0 ]; then
  printf '%s\n' 'LK147 launcher refuses unexpected arguments.' >&2
  exit 78
fi

unset TOURNAMENT_OWNER_RECOVERY_ONLY TOURNAMENT_OWNER_API_BASE TOURNAMENT_OWNER_INTEGRATION_TOKEN
profile=$("$node" "$selector" select) || exit 78
case "$profile" in
  source)
    ;;
  candidate|pilot)
    owner_token=$("$node" "$selector" "read-$profile-token") || exit 78
    export TOURNAMENT_OWNER_RECOVERY_ONLY=true
    export TOURNAMENT_OWNER_API_BASE=https://padlhub.su/api
    export TOURNAMENT_OWNER_INTEGRATION_TOKEN="$owner_token"
    unset owner_token
    ;;
  *)
    printf '%s\n' 'LK147 launcher has no reviewed profile for this graph.' >&2
    exit 78
    ;;
esac
if [ "$profile" = pilot ]; then
  set -- --env-file=/opt/padlhub/lk147-node-red-launcher/residency-preview.env
fi
export CUP_API_BASE_URL=http://127.0.0.1:3000/api
cd /root
exec "$node" --disable-warning=DEP0170 \
  --env-file=/etc/phab-traffic/subscriptions-residency-node-red.env \
  --env-file=/etc/phab-traffic/subscriptions-residency-node-red-flags.env \
  "$@" /usr/local/bin/node-red -v

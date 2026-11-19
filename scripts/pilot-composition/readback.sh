#!/bin/bash
# Read-only post-install readback. Usage:
#   BASE_URL=https://padlhub.su BEARER='<pilot token>' ./readback.sh
# The token is only sent in the Authorization header and is never printed.
set -u
BASE=${BASE_URL:?BASE_URL is required}
TOKEN=${BEARER:?BEARER is required}
fail=0
check() {
  local label="$1" method="$2" path="$3" extra="${4:-}"
  local code
  code=$(curl -sS -o /tmp/readback-body.json -w '%{http_code}' -X "$method" "$BASE$path" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' $extra 2>/dev/null || echo 000)
  local body
  body=$(head -c 220 /tmp/readback-body.json 2>/dev/null | tr '\n' ' ')
  echo "$label: HTTP $code $body"
  if [ "$label" = "catalog" ] || [ "$label" = "status" ] || [ "$label" = "orders" ]; then
    [ "$code" = "200" ] || fail=1
  fi
}
options_code=$(curl -sS -o /dev/null -w '%{http_code}' -X OPTIONS "$BASE/lk/residency/catalog" 2>/dev/null || echo 000)
echo "OPTIONS catalog: HTTP $options_code"
[ "$options_code" = "204" ] || fail=1
check catalog GET /lk/residency/catalog
check status GET /lk/residency/status
check orders GET '/lk/residency/orders?state=unresolved'
# A create without Idempotency-Key must be refused before any body/order/provider work.
create_code=$(curl -sS -o /tmp/readback-create.json -w '%{http_code}' -X POST "$BASE/lk/residency/orders" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' 2>/dev/null || echo 000)
create_body=$(head -c 220 /tmp/readback-create.json 2>/dev/null | tr '\n' ' ')
echo "create without key: HTTP $create_code $create_body"
case "$create_code" in
  400|403|503) ;;
  *) fail=1 ;;
esac
if [ "$fail" = "0" ]; then echo "READBACK_OK"; else echo "READBACK_FAILED"; exit 1; fi

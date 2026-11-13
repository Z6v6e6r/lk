#!/usr/bin/env bash
set -euo pipefail
container_name="padlhub-guard-repair-rs-test-$$"
cleanup() { docker stop "$container_name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run --rm -d --name "$container_name" -p 127.0.0.1::27017 mongo:7.0.16 \
  mongod --replSet rs0 --bind_ip_all >/dev/null
for _attempt in $(seq 1 60); do
  if docker exec "$container_name" mongosh --quiet --eval 'db.adminCommand({ping:1}).ok' 2>/dev/null | grep -q '^1$'; then break; fi
  sleep 1
done
docker exec "$container_name" mongosh --quiet --eval \
  'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})' >/dev/null
for _attempt in $(seq 1 60); do
  if docker exec "$container_name" mongosh --quiet --eval 'db.hello().isWritablePrimary' 2>/dev/null | grep -q '^true$'; then break; fi
  sleep 1
done
host_port="$(docker port "$container_name" 27017/tcp | awk -F: 'NR==1 {print $NF}')"
[[ "$host_port" =~ ^[0-9]+$ ]] || { echo 'Disposable Mongo port unavailable' >&2; exit 1; }
LK1_GUARD_REPAIR_TEST_MONGO_URI="mongodb://127.0.0.1:${host_port}/?directConnection=true" \
  node --test scripts/tests/dailyGuardRepair.test.mjs

#!/usr/bin/env bash
set -euo pipefail
test_container="padlhub-split-publication-test-${PPID:-0}-$$"
created=false
cleanup() { if [[ "$created" == true ]]; then docker stop "$test_container" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT
if docker inspect "$test_container" >/dev/null 2>&1; then exit 1; fi
docker run --rm -d --name "$test_container" -p 127.0.0.1::27017 mongo:7 \
  mongod --replSet rs0 --bind_ip_all >/dev/null
created=true
for _attempt in $(seq 1 30); do
  if docker exec "$test_container" mongosh --quiet --eval 'db.adminCommand({ping:1}).ok' 2>/dev/null | rg -q '^1$'; then break; fi
  sleep 1
done
docker exec "$test_container" mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})' >/dev/null
for _attempt in $(seq 1 30); do
  if docker exec "$test_container" mongosh --quiet --eval 'db.hello().isWritablePrimary' 2>/dev/null | rg -q '^true$'; then break; fi
  sleep 1
done
test_port="$(docker port "$test_container" 27017/tcp | awk -F: 'NR==1 {print $NF}')"
[[ "$test_port" =~ ^[0-9]+$ ]]
SPLIT_PUBLICATION_TEST_MONGO_URI="mongodb://127.0.0.1:${test_port}/?directConnection=true" \
  node --test scripts/tests/splitGamePublication.mongo.test.mjs

#!/usr/bin/env bash
set -euo pipefail

container_name="padlhub-viva-projection-rs-test"
image_name="${VIVA_GAME_PROJECTION_MONGO_TEST_IMAGE:-mongo:7}"

cleanup() {
  docker stop "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if docker inspect "$container_name" >/dev/null 2>&1; then
  echo "Refusing to reuse existing container $container_name" >&2
  exit 1
fi

docker run --rm -d \
  --name "$container_name" \
  -p 127.0.0.1::27017 \
  "$image_name" \
  mongod --replSet rs0 --bind_ip_all --setParameter enableTestCommands=1 >/dev/null

for _attempt in $(seq 1 60); do
  if docker exec "$container_name" mongosh --quiet --eval 'db.adminCommand({ping:1}).ok' 2>/dev/null | grep -q '^1$'; then
    break
  fi
  sleep 1
done

docker exec "$container_name" mongosh --quiet --eval \
  'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})' >/dev/null

for _attempt in $(seq 1 60); do
  if docker exec "$container_name" mongosh --quiet --eval 'db.hello().isWritablePrimary' 2>/dev/null | grep -q '^true$'; then
    break
  fi
  sleep 1
done

host_port="$(docker port "$container_name" 27017/tcp | awk -F: 'NR==1 {print $NF}')"
if [[ ! "$host_port" =~ ^[0-9]+$ ]]; then
  echo "Unable to resolve disposable Mongo host port" >&2
  exit 1
fi

VIVA_GAME_PROJECTION_TEST_MONGO_URI="mongodb://127.0.0.1:${host_port}/?directConnection=true" \
  node --test scripts/tests/vivaGameProjectionCutover.mongo.test.mjs

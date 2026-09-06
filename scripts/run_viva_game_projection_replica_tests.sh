#!/usr/bin/env bash
set -euo pipefail

run_suffix="${PPID:-0}-$$"
container_name="padlhub-viva-projection-rs-test-${run_suffix}"
image_name="${VIVA_GAME_PROJECTION_MONGO_TEST_IMAGE:-mongo:7}"
key_volume="padlhub-viva-projection-rs-key-${run_suffix}"
root_password="fixture-root-password"
application_password="fixture-application-password"
migration_password="fixture-migration-password"
migration_role="padlhubVivaProjectionMigration_fixture01"
container_created=false
volume_created=false

cleanup() {
  if [[ "$container_created" == true ]]; then docker stop "$container_name" >/dev/null 2>&1 || true; fi
  if [[ "$volume_created" == true ]]; then docker volume rm "$key_volume" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

if docker inspect "$container_name" >/dev/null 2>&1; then
  echo "Refusing to reuse existing container $container_name" >&2
  exit 1
fi
if docker volume inspect "$key_volume" >/dev/null 2>&1; then
  echo "Refusing to reuse existing volume $key_volume" >&2
  exit 1
fi

docker volume create "$key_volume" >/dev/null
volume_created=true
docker run --rm -v "${key_volume}:/key" --entrypoint bash "$image_name" -c \
  'head -c 756 /dev/urandom | base64 > /key/keyfile && chown mongodb:mongodb /key/keyfile && chmod 400 /key/keyfile'

docker run --rm -d \
  --name "$container_name" \
  -p 127.0.0.1::27017 \
  -v "${key_volume}:/key:ro" \
  "$image_name" \
  mongod --replSet rs0 --bind_ip_all --auth --keyFile /key/keyfile --setParameter enableTestCommands=1 >/dev/null
container_created=true

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

docker exec "$container_name" mongosh --quiet --eval \
  "db.getSiblingDB('admin').createUser({user:'root',pwd:'${root_password}',roles:[{role:'root',db:'admin'}]})" >/dev/null

docker exec "$container_name" mongosh --quiet --username root --password "$root_password" --authenticationDatabase admin --eval \
  "db.getSiblingDB('admin').createUser({user:'application',pwd:'${application_password}',roles:[{role:'readWrite',db:'PadlhUBScore'},{role:'readWrite',db:'dialog'},{role:'readWrite',db:'events'},{role:'readWrite',db:'games'},{role:'readWrite',db:'games_chat'}]})" >/dev/null

container_ip="$(docker inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$container_name")"
bridge_gateway="$(docker inspect -f '{{range.NetworkSettings.Networks}}{{.Gateway}}{{end}}' "$container_name")"
if [[ -z "$container_ip" || -z "$bridge_gateway" ]]; then
  echo "Unable to resolve exact disposable Mongo network identities" >&2
  exit 1
fi

docker exec "$container_name" mongosh --quiet --username root --password "$root_password" --authenticationDatabase admin --eval \
  "db.getSiblingDB('admin').createRole({role:'${migration_role}',privileges:[{resource:{db:'games',collection:'lk_games'},actions:['find','update','bypassDocumentValidation','collMod']},{resource:{db:'games',collection:''},actions:['listCollections','grantRole','revokeRole']},{resource:{cluster:true},actions:['inprog']},{resource:{db:'admin',collection:''},actions:['viewUser']},{resource:{db:'PadlhUBScore',collection:''},actions:['grantRole','revokeRole']},{resource:{db:'dialog',collection:''},actions:['grantRole','revokeRole']},{resource:{db:'events',collection:''},actions:['grantRole','revokeRole']},{resource:{db:'games_chat',collection:''},actions:['grantRole','revokeRole']}],roles:[]}); db.getSiblingDB('admin').createUser({user:'${migration_role}',pwd:'${migration_password}',roles:[{role:'${migration_role}',db:'admin'}],mechanisms:['SCRAM-SHA-256'],authenticationRestrictions:[{clientSource:['${bridge_gateway}'],serverAddress:['${container_ip}']}]})" >/dev/null

host_port="$(docker port "$container_name" 27017/tcp | awk -F: 'NR==1 {print $NF}')"
if [[ ! "$host_port" =~ ^[0-9]+$ ]]; then
  echo "Unable to resolve disposable Mongo host port" >&2
  exit 1
fi

VIVA_GAME_PROJECTION_TEST_MONGO_URI="mongodb://root:${root_password}@127.0.0.1:${host_port}/?directConnection=true&authSource=admin" \
VIVA_GAME_PROJECTION_TEST_APPLICATION_MONGO_URI="mongodb://application:${application_password}@127.0.0.1:${host_port}/?directConnection=true&authSource=admin" \
VIVA_GAME_PROJECTION_TEST_MIGRATION_MONGO_URI="mongodb://${migration_role}:${migration_password}@127.0.0.1:${host_port}/?directConnection=true&authSource=admin" \
VIVA_GAME_PROJECTION_TEST_MIGRATION_AUTH_RESTRICTIONS="[{\"clientSource\":[\"${bridge_gateway}\"],\"serverAddress\":[\"${container_ip}\"]}]" \
  node --test scripts/tests/vivaGameProjectionCutover.mongo.test.mjs

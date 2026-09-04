# Локальный source-пакет DEV fixture runtime

Этот пакет делает локально проверяемыми schema/read-only evidence и synthetic
in-memory CUP managed contract для двух подписок. Он не является установленным
DEV runtime и не доказывает доступность
host, ingress, Node-RED, CUP, provider, identity или managed-entitlement flow.

## Реализованная граница

- CUP fixture на `https://127.0.0.1:3037` реализует `healthz`, release identity,
  system evidence, runtime context, run-scoped observability и synthetic in-memory
  reserve/confirm/release/activate-first-use для exact canary A/B.
- Provider и identity fixtures на `127.0.0.1:3038/3039` реализуют только
  `healthz`; остальные пути отвечают fail-closed `503`.
- Минимальный Node-RED flow реализует только `GET /lk/release-dev.json` и читает
  root-owned receipt `/srv/lk1-subscription-dev/node-red/release-identity.json`.
  Отсутствующий или некорректный receipt даёт `503`.
- Provider booking, payment и create/join отсутствуют. CUP entitlement/activation
  меняют только process-local synthetic state, не являются host/UAT evidence и не
  получают доступ к внешним или production системам.
- System evidence помечено `FIXTURE_NON_AUTHORIZING` и намеренно не подтверждает
  runtime flags, indexes, projection, canary или no-write counters. Поэтому
  стандартный runner обязан вернуть `BLOCKED`, а не `READY`. Нулевой fixture
  observability проверяет лишь схему и HMAC, но не является runtime/no-write proof.

Fixture runtime не стартует без отдельного marker
`/srv/lk1-subscription-dev/authorization/service-start.approved` и приватного
config через `LK1_SUBSCRIPTION_DEV_FIXTURE_CONFIG_FILE`. HTTPS key/certificate
передаются только через exact root-owned group-readable paths в
`/srv/lk1-subscription-dev/tls`; TLS material не входит в bundle. Config не входит в
bundle, обязан быть обычным non-symlink файлом `0600`, содержать только
`fixture-*` identities/credentials и exact A=V1/B=V2/control evidence. Bearer,
JWT и иные production-like credentials schema не принимает.

## Локальная проверка

```bash
npm run test:lk1-subscription-dev-runtime-source
node scripts/lk1_subscription_dev_runtime/fixture_runtime.mjs --self-check
```

Immutable source bundle разрешено собирать только из clean exact HEAD в новую
директорию под `/private/tmp` или `/tmp`:

```bash
source_sha="$(git rev-parse HEAD)"
bundle_dir="$(mktemp -d /private/tmp/lk1-dev-runtime.XXXXXX)/bundle"
node scripts/build_lk1_subscription_dev_runtime_source.mjs \
  --output "$bundle_dir" \
  --source-commit "$source_sha"
```

Manifest и payload self-verify по SHA-256 и file modes. Manifest явно запрещает
host install, service start/enable, ingress, activation, canary IDs, secrets и
external writes. В bundle нет installer.

## Что остаётся отдельным этапом

Любые host install, создание приватного fixture config, запись release receipt,
start/enable units, ingress, выдача canary IDs, activation и ручной UAT требуют
новой точной авторизации. Synthetic in-memory managed entitlement и activation
реализованы и локально проверены; provider/identity create/join остаются
health-only и host runtime не запускался.

`IPAddressDeny=any`/`IPAddressAllow=localhost` остаются defense-in-depth в unit
candidates, но их фактическое kernel/eBPF enforcement не доказано read-only
preflight. Поэтому `serviceStartBlocked=true` до отдельно авторизованного
`STARTED_DEFAULT_OFF` gate с отрицательной non-loopback пробой.

Historical stopped bootstrap оставил каталог `authorization` под
`root:root 0700`. Будущий отдельно авторизованный stopped-install должен сменить
его custody на `root:lk1-subscription-dev 0750`, а marker создавать как
`root:lk1-subscription-dev 0440`. Runtime принимает только exact source path и
проверяет всю цепочку каталогов; Node-RED использует тот же validator через
`ExecCondition`. Source остаётся fail-closed без будущего install/start-stage.

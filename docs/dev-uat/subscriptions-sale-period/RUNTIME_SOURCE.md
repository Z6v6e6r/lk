# Локальный source-пакет DEV fixture runtime

Этот пакет делает локально проверяемой только schema/read-only evidence-часть UAT двух
подписок. Он не является установленным DEV runtime и не доказывает доступность
host, ingress, Node-RED, CUP, provider, identity или managed-entitlement flow.

## Реализованная граница

- CUP fixture на `127.0.0.1:3037` реализует только `healthz`, release identity,
  system evidence, runtime context и run-scoped observability.
- Provider и identity fixtures на `127.0.0.1:3038/3039` реализуют только
  `healthz`; остальные пути отвечают fail-closed `503`.
- Минимальный Node-RED flow реализует только `GET /lk/release-dev.json` и читает
  root-owned receipt `/srv/lk1-subscription-dev/node-red/release-identity.json`.
  Отсутствующий или некорректный receipt даёт `503`.
- Все mutation, create/join, provider booking, payment, entitlement и activation
  capabilities отсутствуют.
- System evidence помечено `FIXTURE_NON_AUTHORIZING` и намеренно не подтверждает
  runtime flags, indexes, projection, canary или no-write counters. Поэтому
  стандартный runner обязан вернуть `BLOCKED`, а не `READY`. Нулевой fixture
  observability проверяет лишь схему и HMAC, но не является runtime/no-write proof.

Fixture runtime не стартует без отдельного marker
`/srv/lk1-subscription-dev/authorization/service-start.approved` и приватного
config через `LK1_SUBSCRIPTION_DEV_FIXTURE_CONFIG_FILE`. Config не входит в
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
новой точной авторизации. Полный managed-entitlement или create/join flow в этом
source-пакете не реализован.

Historical stopped bootstrap оставил каталог `authorization` под
`root:root 0700`. Поэтому runtime process не сможет сам прочитать будущий marker:
до start-stage нужен отдельный проверенный механизм marker custody (и новая
авторизация на соответствующее host-изменение). Текущий source намеренно остаётся
fail-closed при этой несовместимости.

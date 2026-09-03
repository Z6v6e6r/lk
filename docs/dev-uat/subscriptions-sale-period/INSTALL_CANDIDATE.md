# Immutable DEV runtime install candidate

Пакет подготавливает только локальный, проверяемый набор runtime payload и
systemd unit candidates. Он не содержит install executor и не даёт полномочий на
host read/install, `daemon-reload`, start/enable, ingress, activation, canary IDs,
secrets или внешние записи.

## Marker custody

Source marker остаётся в закрытом `root:root 0700` каталоге. Unit candidates
используют `LoadCredential`, поэтому marker читает systemd manager, а процесс
получает приватную read-only копию как
`$CREDENTIALS_DIRECTORY/service-start.approved`. Runtime принимает только точный
`/run/credentials/<unit>` для своей роли, проверяет root-owned `/run/credentials`,
read-only mount каталога unit и private regular credential. Произвольный файл из
`/tmp` не является разрешением запуска. Node-RED проходит ту же проверку через
`ExecCondition` до старта процесса.

Runtime принимает credential только при одновременном выполнении условий:

- exact JSON schema, `environment=DEV`;
- exact совпадение `sourceCommit` и `runtimeManifestSha256` с root-owned
  `install-identity.env`, который systemd читает через `EnvironmentFile`;
- exact роли `cup`, `provider`, `identity`, `nodered`;
- private regular non-symlink credential;
- `issuedAt <= now < expiresAt`, срок не более одного часа;
- 64-hex `authorizationId` (идентификатор короткоживущего многостартового окна,
  не anti-replay nonce).

Это устраняет необходимость чтения закрытого source marker service user-ом, но
не доказывает поддержку `LoadCredential` конкретным host. Контракт оставляет
`hostSupportVerified=false`; fresh read-only host preflight является отдельным
будущим gate.

## Почему candidate нельзя запустить

- Все unit candidates содержат `RefuseManualStart=yes`.
- В них отсутствует `[Install]`/`WantedBy`.
- Fixture config, release receipt и service-start credential не входят в пакет.
- Install executor и `install-identity.env` отсутствуют.
- Loopback-only/editor-disabled Node-RED settings входят как exact hashed payload.
- Manifest и contract оставляют все host/live authority в `false`.
- Provider/identity остаются health-only, а system evidence —
  `FIXTURE_NON_AUTHORIZING`; обычный UAT остаётся `BLOCKED`.

При этом packaged Node-RED flow — не read-only release flow, а dormant
write-capable source graph: он содержит POST route, два outbound HTTP nodes и
Mongo `find`/`insertOne`/`updateOne`. Contract перечисляет эти возможности явно.
Отсутствие installer/config/receipt/credential и закрытый listener делают пакет
неисполняемым на этом этапе, но будущий start или positive UAT требуют отдельного
payment/provider/mutation review и новой точной авторизации.

## Локальная проверка

```bash
npm run test:lk1-subscription-dev-runtime-source
npm run test:lk1-subscription-dev-runtime-install-candidate
```

После checkpoint-коммита candidate собирается только из clean exact HEAD в новую
временную директорию:

```bash
source_sha="$(git rev-parse origin/main)"
candidate_dir="$(mktemp -d /private/tmp/lk1-runtime-install.XXXXXX)/bundle"
node scripts/build_lk1_subscription_dev_runtime_install_candidate.mjs \
  --output "$candidate_dir" \
  --source-commit "$source_sha"
```

Builder берёт function-source только из frozen `origin/main`, а runtime tooling —
из clean checkpoint `HEAD`; manifest хранит эти commits раздельно. Он сравнивает
каждый упаковываемый byte с соответствующим committed blob. Bundled
verifier проверяет manifest `0600`, exact inventory, file modes/hashes, отсутствие
symlink/special/unexpected files, canonical contract/unit/flow digests и
отсутствие install executor.

## Следующий отдельный gate

До любого host install требуется отдельная авторизация, fresh read-only host
readback и новый reviewed executor/rollback plan. Даже установка payload не должна
создавать marker/config/receipt, выполнять `daemon-reload`, запускать или включать
units либо менять ingress/activation.

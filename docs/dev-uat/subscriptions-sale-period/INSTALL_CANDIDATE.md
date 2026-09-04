# Immutable DEV runtime install candidate

Пакет подготавливает локальный, проверяемый набор runtime payload, systemd unit
candidates и exact stopped-install executor. Новый executor разрешает только
атомарную установку шести manifest-bound файлов с сохранением точных preimage.
Он не выполняет `daemon-reload`, start/enable, ingress, activation, передачу
canary IDs/secrets или provider/database/payment writes. Ручной rollback требует
отдельной точной авторизации; автоматический rollback выполняется только при
ошибке частично начатой установки.

## Marker custody

Target host использует systemd 245, поэтому unit candidates не зависят от
`LoadCredential` (появился в systemd 247). Короткоживущий marker должен быть
точным regular file `root:lk1-subscription-dev 0440` в каталоге
`root:lk1-subscription-dev 0750`; runtime принимает только фиксированный путь
`/srv/lk1-subscription-dev/authorization/service-start.approved`, проверяет
root custody всей цепочки каталогов, отсутствие symlink/group-write/world-write
и exact file owner/group/mode. Произвольный файл из `/tmp` не является
разрешением запуска. Node-RED проходит ту же проверку через `ExecCondition` до
старта процесса.

Runtime принимает credential только при одновременном выполнении условий:

- exact JSON schema, `environment=DEV`;
- exact совпадение `sourceCommit` и `runtimeManifestSha256` с root-owned
  `install-identity.env`, который systemd читает через `EnvironmentFile`;
- exact роли `cup`, `provider`, `identity`, `nodered`;
- root-owned dedicated-group-read-only regular non-symlink marker;
- `issuedAt <= now < expiresAt`, срок не более одного часа;
- 64-hex `authorizationId` (идентификатор короткоживущего многостартового окна,
  не anti-replay nonce).

Fresh read-only preflight подтвердил systemd 245 и совместимость этого
file-custody transport. Он не подтверждает фактическое kernel/eBPF enforcement
`IPAddressDeny`; service start остаётся заблокирован до отдельной отрицательной
non-loopback пробы. Историческое подтверждение не заменяет повторный
preflight непосредственно перед будущей установкой.

## Почему candidate нельзя запустить

- Все unit candidates содержат `RefuseManualStart=yes`.
- В них отсутствует `[Install]`/`WantedBy`.
- Fixture config, TLS key/certificate, release receipt и service-start credential
  не входят в пакет.
- `install-identity.env` отсутствует, поэтому runtime не проходит conditions запуска.
- Loopback-only/editor-disabled Node-RED settings входят как exact hashed payload.
- Node-RED доверяет только exact private CA path через `NODE_EXTRA_CA_CERTS`; CA
  material отсутствует в bundle и требует отдельной custody/start проверки.
- Manifest и contract разрешают только `hostRead` и `hostInstall`; все
  start/enable/reload/ingress/activation/secrets/external-write authority остаются `false`.
- CUP managed entitlement/activation реализованы только как synthetic in-memory
  source и физически проверены на fixture-owned loopback; host runtime не запускался.
- Provider/identity остаются health-only, а system evidence —
  `FIXTURE_NON_AUTHORIZING`; обычный UAT остаётся `BLOCKED`.

При этом packaged Node-RED flow — не read-only release flow, а dormant
write-capable source graph: он содержит POST route, два outbound HTTP nodes и
Mongo `find`/`insertOne`/`updateOne`. Contract перечисляет эти возможности явно.
Отсутствие config/receipt/credential и закрытый listener делают установленный
payload незапускаемым. Будущий start или positive UAT требуют отдельного
payment/provider/mutation review и новой точной авторизации.

## Локальная проверка

```bash
npm run test:lk1-subscription-dev-runtime-source
npm run test:lk1-subscription-dev-runtime-install-candidate
npm run test:lk1-subscription-dev-stopped-install
```

После checkpoint-коммита candidate собирается только из clean exact HEAD в новую
временную директорию:

```bash
source_sha="$(node -p \"require('./scripts/lk1_subscription_dev_candidate_binding.json').source.sourceCommit\")"
candidate_dir="$(mktemp -d /private/tmp/lk1-runtime-install.XXXXXX)/bundle"
node scripts/build_lk1_subscription_dev_runtime_install_candidate.mjs \
  --output "$candidate_dir" \
  --source-commit "$source_sha"
```

Builder берёт function-source только из frozen source-base, а runtime tooling —
из clean checkpoint `HEAD`; текущий `origin/main` должен быть предком `HEAD`, а
frozen source-base — предком текущего `origin/main`. Manifest хранит source и
tooling commits раздельно. Builder сравнивает
каждый упаковываемый byte с соответствующим committed blob. Bundled
verifier проверяет manifest `0600`, exact inventory, file modes/hashes, отсутствие
symlink/special/unexpected files, canonical contract/unit/flow digests, exact
installer SHA, out-of-bundle launcher SHA, pinned host-key fingerprint и
capture-tool identity.

## Следующий отдельный gate

До любого host install требуется отдельная авторизация и fresh read-only host
readback. Checked-in schema-v1 evidence является только историческим архивом;
install gate требует отдельный schema-v2 direct-SSH capture через exact pinned
ED25519 host key, связанный с clean exact HEAD/tree, release tuple и capture hashes.
Executor принимает только fresh evidence с TTL 3600 секунд, exact manifest SHA и
bundle в root-private
`/srv/lk1-subscription-dev/.stopped-install-<manifest-sha256>/bundle`.
Перед исполнением весь bundle tree должен принадлежать root, иметь private
directories `0700`, exact manifest-declared file modes и single-link regular files.
Launcher не входит в bundle: его exact SHA находится в manifest, а перед запуском
он должен быть независимо сверен системным `sha256sum`. Только после этого launcher
повторно проверяет manifest и каждый payload byte, берёт kernel-released exclusive
`flock` и запускает bundled executor через bootstrap Node runtime.
Даже установка payload не должна
создавать marker/config/receipt, выполнять `daemon-reload`, запускать или включать
units либо менять ingress/activation.

Install требует новый 32-hex attempt ID, сохраняет evidence под
`<evidenceRoot>/<manifest-sha256>/<attempt-id>/` и пишет `preimage.json` до первой
замены. Exact preimage включает SHA-256, uid, gid, mode и nlink. Каждый файл пишется через
single-link temporary file + `fsync` + atomic rename, проверяет postimage SHA и
получает durable per-target progress journal; затем выполняется повторный
stopped/listener/shared-flow postcheck. Ошибка после первой замены
восстанавливает exact preimage либо исходное отсутствие и сохраняет
`failure.json`. Успех создаёт `install.json` со state `INSTALLED_STOPPED`.
Ручной режим rollback отказывается работать без отдельного confirmation и
выполняет stopped-state precheck до первой записи. Отдельный `recover` завершает
idempotent restore после crash/`AUTO_ROLLBACK_INCOMPLETE`, включая очистку только
attempt-bound temporary files. Новый attempt ID позволяет повторить install того
же manifest после подтверждённого rollback. Mongo/data/evidence не удаляются.

## Future authorized operator sequence

Ниже — runbook для отдельного будущего разрешения. Его нельзя выполнять в рамках
подготовки candidate. Значения manifest, launcher и preflight SHA фиксируются из
локально проверенного clean checkpoint; подстановка другого SHA останавливает gate.

```bash
lk1_manifest_sha="<64-hex manifestSha256 from builder>"
lk1_launcher_sha="<manifest.trustedLauncher.sha256>"
lk1_preflight_sha="<sha256 of fresh schema-v2 evidence.json>"
lk1_attempt_id="<new random 32-hex>"
lk1_candidate_parent="/srv/lk1-subscription-dev/.stopped-install-${lk1_manifest_sha}"
lk1_bundle_remote="${lk1_candidate_parent}/bundle"
lk1_launcher_remote="${lk1_candidate_parent}/launcher.mjs"
lk1_evidence_remote="${lk1_candidate_parent}/evidence.json"
```

До transfer оператор создаёт local `known_hosts` file с ровно одной ED25519
записью для `89.108.64.209`, проверяет fingerprint
`SHA256:LP1OQP7TkwpzFQzJZMrKLiaFVwJYd71VeliwfMs6krk` и использует его во всех
`scp`/`ssh` вызовах вместе с `HostKeyAlias=89.108.64.209`,
`HostKeyAlgorithms=ssh-ed25519`, `StrictHostKeyChecking=yes` и
`UpdateHostKeys=no`. На хосте bundle, launcher и evidence должны быть root-owned;
launcher получает mode `0500`, evidence `0600`, bundle dirs `0700`, а payload
сохраняет manifest modes. До запуска системным `/usr/bin/sha256sum` независимо
сверяются manifest, launcher и evidence SHA.

После отдельного разрешения на read-only capture и staging оператор выполняет
следующую точную последовательность из clean checkpoint. `lk1_known_hosts`
создаётся самим schema-v2 validator как private single-entry файл и удаляется им
после capture; для transfer создаётся новый эквивалентный private файл из той же
проверенной строки. Никакая из команд ниже не запускает сервисы:

```bash
npm run nodered:lk1-subscription-dev:host-preflight -- --capture-via-ssh
lk1_evidence_local="<EVIDENCE_PATH printed by the PASS_CURRENT capture>"
lk1_preflight_sha="$(/usr/bin/shasum -a 256 "$lk1_evidence_local" | /usr/bin/awk '{print $1}')"

lk1_known_hosts_dir="$(mktemp -d /private/tmp/lk1-dev-known-host.XXXXXX)"
/bin/chmod 700 "$lk1_known_hosts_dir"
lk1_known_hosts="$lk1_known_hosts_dir/known_hosts"
/usr/bin/ssh-keygen -F 89.108.64.209 -f "$HOME/.ssh/known_hosts" \
  | /usr/bin/awk '$2 == "ssh-ed25519" { print }' >"$lk1_known_hosts"
/bin/chmod 600 "$lk1_known_hosts"
test "$(/usr/bin/wc -l <"$lk1_known_hosts" | /usr/bin/tr -d ' ')" = 1
/usr/bin/ssh-keygen -lf "$lk1_known_hosts" \
  | /usr/bin/grep -F 'SHA256:LP1OQP7TkwpzFQzJZMrKLiaFVwJYd71VeliwfMs6krk'

lk1_ssh_options=(
  -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes
  -o HostKeyAlgorithms=ssh-ed25519 -o UpdateHostKeys=no
  -o HostKeyAlias=89.108.64.209 -o UserKnownHostsFile="$lk1_known_hosts"
)
/usr/bin/ssh "${lk1_ssh_options[@]}" lk-reserve-89 -- /bin/sh -ceu '
  parent=$1
  test ! -e "$parent" && test ! -L "$parent"
  /bin/mkdir -m 0700 "$parent"
  /bin/chown root:root "$parent"
  test "$(/usr/bin/stat -c %U:%G:%a "$parent")" = root:root:700
' sh "$lk1_candidate_parent"
/usr/bin/scp "${lk1_ssh_options[@]}" -pr "$candidate_dir" \
  "lk-reserve-89:$lk1_bundle_remote"
/usr/bin/scp "${lk1_ssh_options[@]}" -p \
  scripts/launch_lk1_subscription_dev_stopped_candidate.mjs \
  "lk-reserve-89:$lk1_launcher_remote"
/usr/bin/scp "${lk1_ssh_options[@]}" -p "$lk1_evidence_local" \
  "lk-reserve-89:$lk1_evidence_remote"
/usr/bin/ssh "${lk1_ssh_options[@]}" lk-reserve-89 -- /bin/sh -ceu '
  parent=$1; bundle=$2; launcher=$3; evidence=$4
  manifest_sha=$5; launcher_sha=$6; evidence_sha=$7
  test "$(/usr/bin/stat -c %U:%G:%a "$parent")" = root:root:700
  /bin/chown -R root:root "$bundle"
  /usr/bin/find "$bundle" -type d -exec /bin/chmod 0700 {} +
  /bin/chown root:root "$launcher" "$evidence"
  /bin/chmod 0500 "$launcher"
  /bin/chmod 0600 "$evidence"
  test "$(/usr/bin/sha256sum "$bundle/manifest.json" | /usr/bin/cut -d" " -f1)" = "$manifest_sha"
  test "$(/usr/bin/sha256sum "$launcher" | /usr/bin/cut -d" " -f1)" = "$launcher_sha"
  test "$(/usr/bin/sha256sum "$evidence" | /usr/bin/cut -d" " -f1)" = "$evidence_sha"
' sh "$lk1_candidate_parent" "$lk1_bundle_remote" "$lk1_launcher_remote" \
  "$lk1_evidence_remote" "$lk1_manifest_sha" "$lk1_launcher_sha" "$lk1_preflight_sha"
```

Первый remote `mkdir` атомарно резервирует весь manifest-bound root-private parent
и падает, если он уже существует; поэтому последующие `scp` не имеют общих final
paths с конкурентной попыткой. Любой partial transfer оставляет parent занятым и
останавливает gate: повторное использование или удаление запрещены без отдельного
cleanup-решения. Перед install повторяются три system `sha256sum` сравнения на
final paths. Удаление private known-hosts и любого failed-staging parent не входит
в install authority.

Только после отдельной install-authority запускается:

```bash
/usr/bin/env -i PATH=/usr/bin:/bin LANG=C \
  LK1_SUBSCRIPTION_DEV_STOPPED_INSTALL=CONFIRM_EXACT_STOPPED_INSTALL \
  /srv/lk1-subscription-dev/runtime/node/bin/node "$lk1_launcher_remote" \
  --mode install --bundle "$lk1_bundle_remote" \
  --manifest-sha256 "$lk1_manifest_sha" \
  --preflight-evidence "$lk1_evidence_remote" \
  --preflight-sha256 "$lk1_preflight_sha" \
  --attempt-id "$lk1_attempt_id"
```

Rollback и incomplete recovery являются другими gates и требуют соответственно:

```bash
/usr/bin/env -i PATH=/usr/bin:/bin LANG=C \
  LK1_SUBSCRIPTION_DEV_STOPPED_ROLLBACK=CONFIRM_EXACT_STOPPED_ROLLBACK \
  /srv/lk1-subscription-dev/runtime/node/bin/node "$lk1_launcher_remote" \
  --mode rollback --bundle "$lk1_bundle_remote" \
  --manifest-sha256 "$lk1_manifest_sha" --evidence-directory "<exact attempt directory>"

/usr/bin/env -i PATH=/usr/bin:/bin LANG=C \
  LK1_SUBSCRIPTION_DEV_STOPPED_RECOVERY=CONFIRM_EXACT_STOPPED_RECOVERY \
  /srv/lk1-subscription-dev/runtime/node/bin/node "$lk1_launcher_remote" \
  --mode recover --bundle "$lk1_bundle_remote" \
  --manifest-sha256 "$lk1_manifest_sha" --evidence-directory "<exact attempt directory>"
```

Ни одна команда не выполняет `daemon-reload`, start/enable, ingress/activation,
не устанавливает secrets/config/receipt и не вызывает provider/database/payment writes.

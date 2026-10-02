# Runbook: переиздание security evidence партнёрского API

Статус: черновик процедуры. Правки кода в этом документе не выполняются, и сам
документ ничего не разрешает. Это операционная задача в контролируемой среде, а
не правка репозитория.

## 1. Зачем

`npm run test:partner-game-membership-api` даёт 25 падений, а
`npm run validate:partner-game-membership-runtime` — `Partner runtime immutable
closure hash mismatch`. Из-за этого шаг CI `Run Partner membership R4 gates`
(`check_13`) красный, и следующие шаги конвейера не достигаются.

Причина — коммит `bd52a95` «Add guarded shared Node-RED partner API flow»
(2026-09-10, уже в `main`). Он изменил аудированный артефакт, но не переиздал
его security evidence:

| Файл | записано в evidence | текущий |
| --- | --- | --- |
| `partner-game-membership-node.cjs` | `196bddb4df611636…` | `083060dd19a5ca83…` |
| `partner-game-membership-node.html` | `dbfe619f98c94884…` | `72c9699d92a1089b…` |
| `partner-game-membership-ingress.cjs` | отсутствует в evidence | `66634f6ac8fe9c6e…` |
| `partner-game-membership-core.mjs` | `69781e532d5398ff…` | совпадает |
| `partner_game_membership_sidecar/settings.cjs` | `37e675a39f12d2a2…` | совпадает |
| `partner_game_membership_production_controls.json` | `6226f692004944a0…` | совпадает |

Изменение в `.cjs` не косметическое: добавлен ingress-proof
(`consumePartnerIngress`), guard закрытия store (`PARTNER_API_CLOSING`) и учёт
in-flight операций.

Последствия: preflight сравнивает поданный sidecar с пином
(`scripts/partner_game_membership_nginx_preflight.mjs:51`) и падает
`NGINX_SIDECAR_SOURCE_DRIFT` на текущем исходнике — включая три негативных
теста, которые из-за этого не доходят до своей настоящей проверки.

## 2. Почему нельзя просто обновить хэши

`scripts/validate_partner_game_membership_runtime.mjs:178` запечатывает весь
блок `auditExecution`:

```js
// Exact reviewed CLI readback, not a caller-resealable assertion. A future audit
// needs new observed evidence and review; changing its date is not a refresh.
if (sha256(Buffer.from(`${JSON.stringify(auditExecution, null, 2)}\n`)) !== "2199b408…")
```

`auditExecution` включает `sourceHashes`. Поэтому:

- правка хэша в `audit-report.json` ломает seal;
- обновление самой seal-константы без нового наблюдения — это ровно тот
  «caller-resealable assertion», который код запрещает, и фактическая подделка
  security-доказательства.

Дополнительно evidence привязан к физическому прогону: `functional-rehearsal.json`
фиксирует `capturedAt 2026-09-05T06:49:04.000Z`, `sourceBaseCommit 26f90b6d…`,
`customNodeReleaseSha256`, а audit выполняется в Docker `--platform linux/amd64`
с проверкой `image.Os === "linux"` и `image.Architecture === "amd64"`.
Прогон на Darwin/arm64 под эмуляцией не эквивалентен review'енному.

## 3. Предусловия

- Контролируемая linux/x64 среда с Docker, способная запускать `linux/amd64`
  без эмуляции (иначе observed image ID и receipts не совпадут с ожидаемыми).
- Точный исходный коммит для аудита (полный SHA) и отсутствие локальных
  незакоммиченных правок в аудируемом наборе.
- Приватный каталог для результатов аудита (вне репозитория).
- Ревьюер безопасности для seal-константы и `SOURCE_PINS` (это trust boundary).
- Свежий live workspace, если переиздаётся и packet: `--workspace
  /absolute/fresh-live-workspace`.

## 4. Порядок операций

1. Зафиксировать исходный коммит и убедиться, что рабочее дерево чистое.
2. Прогнать аудит (обязателен явный флаг):

   ```bash
   node scripts/audit_partner_game_membership_runtime.mjs --install-and-audit-locked-runtime
   ```

   Аудируемый набор уже включает `partner-game-membership-ingress.cjs`
   (`scripts/audit_partner_game_membership_runtime.mjs:24`), поэтому новый прогон
   запишет все восемь файлов custom-node. Ожидаемые артефакты: `results/audit-observation.json`,
   `results/container.log`, `results/recovery.json`, `results/<command>.stdout|stderr`,
   а также `sourceHashes` и `inputHashes` в наблюдении.
3. Пересобрать packet из свежего live workspace:

   ```bash
   node scripts/prepare_partner_game_membership_v02_packet.mjs \
     --workspace /absolute/fresh-live-workspace --out /absolute/new-private-packet
   ```

4. Если требуется Mongo-репетиция:

   ```bash
   npm run mongo:partner-game-membership:rehearse
   ```

5. Переиздать tracked evidence в `scripts/partner_game_membership_runtime/`
   **из новых наблюдений, а не правкой чисел**: `audit-report.json`,
   `runtime-manifest.json`, `functional-rehearsal.json` (и `dependency-tree.json`
   / `package-lock.json` / `package.json`, если менялся изолированный рантайм).
6. Reviewed-обновление пинов и seal (каждый пункт — отдельное подтверждение):
   - `scripts/validate_partner_game_membership_runtime.mjs:178` — новая seal-константа `auditExecution`;
   - `scripts/partner_game_membership_nginx_preflight.mjs:8` — `SOURCE_PINS`;
   - `scripts/partner_game_membership_production_controls.json` — только если менялись controls;
   - перечисленные ниже модули, каждый из которых ссылается на хэши ноды/релиза:
     `scripts/prepare_partner_game_membership_v02_packet.mjs`,
     `scripts/rehearse_partner_game_membership_guarded_startup.mjs`,
     `scripts/rehearse_partner_game_membership_raw_guard.mjs`,
     `scripts/validate_partner_game_membership_production_binding.mjs`,
     `scripts/validate_partner_game_membership_production_controls.mjs`,
     `scripts/audit_partner_game_membership_runtime.mjs`.
7. Обновить evidence-документацию и запись в `docs/WORKLOG.md`, зафиксировав
   исходный коммит, наблюдённые хэши и объём переиздания.

Важно: обновление пина **не повышает** статус доказательства. Результат
`NOT_PROVEN` от этого не становится `PROVEN`, и production import по-прежнему
не разрешается этим runbook'ом.

## 5. Верификация

```bash
npm run validate:partner-game-membership-runtime
npm run validate:partner-game-membership-production-controls
npm run validate:partner-game-membership-production-binding
npm run test:partner-game-membership-api
```

Ожидание: три валидатора проходят; 702 теста без падений (сейчас 677/25).
Затем прогнать шаг CI целиком и только после этого проверять `check_14+`,
которые до сих пор ни разу не достигались.

## 6. Стоп-сигналы и откат

- Прогон аудита на arm64/эмуляции, либо иной host architecture — стоп: evidence
  не эквивалентен review'енному.
- Любая попытка «починить» seal или хэши без нового наблюдения — стоп.
- Расхождение `inputHashes`/`sourceHashes` с фактическими байтами — стоп.
- Откат: изменения касаются только перечисленных записей evidence и пинов;
  откат — возврат файлов к предыдущему коммиту. Живые Node-RED, Nginx, Mongo и
  Viva этим runbook'ом не изменяются, поэтому отдельный откат данных не нужен.

## 7. Открытый архитектурный вопрос

`bd52a95` изменил уже аудированную ноду вместо расширения отдельным
артефактом, из-за чего замороженное evidence разъехалось. Стоит решить, должно
ли ingress-proof жить в той же ноде (тогда каждое изменение требует переиздания
evidence) или в отдельном модуле с собственным evidence.

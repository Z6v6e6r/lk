# Годовая ХАБ: результат выкладки фикса отпечатков (2026-09-17)

Дополняет `docs/ANNUAL_FINGERPRINT_WHITESPACE_FIX_20260917.md`. Кодовый фикс влит в
`main`, выложен на `lk-primary-147` и проверен; данные леджера нормализованы полностью.

## Источник

- PR [#108](https://github.com/Z6v6e6r/lk/pull/108), коммит `afa36e8d`, merge `47d159d0`.
- Exact-head CI `LK1 exact-head enforcement gate` — pass (run 35240252855).

## Пакет выкладки

Фокусная замена одного тела функции на свежем live-preimage:

| Параметр | Значение |
| --- | --- |
| deploymentId | `annual-fingerprint-trim-20260917` |
| preimage (live flow) | `6d9fb71284433719b87be111ca6653726c7011adc672f159e2bd77f70a2ea42e` |
| preimage узла `piter_atomic_router_20260903.func` | `4240860434d637e0e0a6c24719d7504668e45fa0370aad472533c53790ddb7e7` |
| source (merged) | `10a86299f807943f905cfd9846d35875b370cd94c186205c4eefd6f2e764760e` |
| candidate (live flow) | `eca9e65708f6a5946c8bb3804cccfe4165ffa6fa9e5c4d8f4e78b2c66f3c233f` |
| изменённых узлов | 1 (`changedNodeCount: 1`) |

Кандидат собран только заменой `func` этого узла; идентичность узла (tab, name, outputs,
wires, initializer, libs) проверена до записи, а несовпадение preimage-поколения или
отсутствие ровно одной замены — fail-closed. Контракт построен независимым
`prepare_contract.mjs` (function-only exact-graph), а не патчером.

## Ход выкладки

1. Первый preflight отказал по чужой активной lease: `lk1-target-diagnostics`,
   `phase: soaking` до `2026-09-17T17:33:25Z`. Аренда не снималась принудительно;
   ожидание ~14 минут. Preimage, снятый в 17:19Z, уже совпадал с результатом того
   деплоя (`candidateSha256 = 6d9fb712…`), то есть кандидат строился поверх актуального
   live.
2. Apply (одна попытка, без ретраев):

```json
{"ok": true, "action": "apply", "deploymentId": "annual-fingerprint-trim-20260917",
 "sourceSha256": "6d9fb712…", "candidateSha256": "eca9e657…",
 "activeFlowSha256": "eca9e657…", "nodeRedOnline": true, "nodeRedPid": 793776,
 "nodeRedRestartCount": 201, "deploymentLeaseExpiresAt": "2026-09-17T17:49:17.124Z"}
```

3. Независимый readback установленного файла: `installedFlowSha256 = eca9e657…` —
   совпадает с кандидатом.

Backups (0600) на хосте:

- `/root/.node-red/.padlhub-reviewed-flow-backups/flows-pre-annual-fingerprint-trim-20260917-20260917T203352+0300.json`
- `.../contract-annual-fingerprint-trim-20260917-20260917T203352+0300.json`
- `.../candidate-annual-fingerprint-trim-20260917-20260917T203352+0300.flow.json`

Откат: `node deploy_reviewed_flow_147_remote.mjs rollback --deployment-id
annual-fingerprint-trim-20260917 --flow-backup <flows-pre…> --contract-backup <contract…>`.

## Проверки после выкладки

- Установленное тело узла: `sha256 = 10a86299…` = reviewed fix; оба билдера содержат
  `.join("\n").trim()` (2 вхождения).
- Леджер `inventory:network_friendship_12m_20260910_epoch`: `ready`, `validate` = true,
  `admissionReady` = true, счётчики согласованы.
- Публичный статус: `canPurchase: true`, `managedSaleReady: true`, `managedSaleError: null`,
  `remainingCount: 1`, `price: 98000`.
- Витрина `https://padlhub.ru/sub_hab`, вариант «год»: «98 000 ₽ / год», «Осталось: 1 / 1»,
  кнопка «Оформить подписку» активна.
- Soak 15 минут, 10 сэмплов: во всех успешных чтениях `flowSha = eca9e657…`,
  `pm2 online restarts=201`, `canPurchase: true`. Семь «фейлов» сэмплинга — таймауты
  SSH/curl на стороне оператора; ни один успешный сэмпл не показал иной хеш потока или
  закрытый счётчик.

## Нормализация данных (до выкладки, авторизована владельцем)

| Шаг | Документ | Изменение | Revision | Backup |
| --- | --- | --- | --- | --- |
| 1 | `inventory:network_friendship_12m_20260910_epoch` | `reservations[15].intentFingerprint`, `.requestFingerprint` → trim | 182 → 183 | `preimage-inventory_network_friendship_12m_20260910_epoch-2026-09-17T15-13-27-009Z.json` |
| 2 | тот же леджер | `reservations[15].saleRecord.requestFingerprint` → trim | 189 → 190 | `preimage-cleanup-9761cd7c4946-2026-09-17T17-16-26-559Z.json` |
| 3 | `hub-sale:network_friendship_12m_20260910_epoch:…` (тот же мёртвый чекаут) | `requestFingerprint` → trim | — | `preimage-cleanup-206db6dae7ee-2026-09-17T17-16-26-559Z.json` |

Все три записи — CAS с exact-фильтром (`matched 1 / modified 1`), preimage-бэкапы 0600 в
`/root/.node-red/.padlhub-annual-ledger-repairs-20260917/`. Postcheck: `validate = true`,
revision 190, `remainingLegacy = 0` по всей коллекции (4669 документов). Квоты, статусы
броней, суммы и провайдерские данные не менялись.

## Границы

- Менялся ровно один узел (`piter_atomic_router_20260903.func`); граф, HTTP-входы и прочие
  узлы не затронуты (exact-graph контракт + readback).
- Платёжных/провайдерских операций, смены флагов выпуска, квот и других деплоев не
  выполнялось. Чужая аренда `lk1-target-diagnostics` не снималась.

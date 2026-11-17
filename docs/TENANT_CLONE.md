# Клон LK1 под второго тенанта (игровой контур)

Runbook для сборки изолированного игрового/сообщественного среза LK1 под второго
клубного тенанта VivaCRM. Первый тенант — `pade_prime` (Viva `Dvjlor`, Красноярск,
UTC+07:00).

## Что делает инструмент

`scripts/tenant_clone_flow.mjs` берёт **живой** flow с `lk-primary-147` и собирает
кандидат — изолированный набор табов для второго тенанта:

- новые id всех узлов (детерминированно: `sha1("<slug>:<oldId>")`);
- свои http-пути с префиксом `<pathPrefix>`;
- свои Mongo-коллекции с префиксом `<collectionPrefix>` (та же база и тот же
  `mongodb4-client`, узел переиспользуется, секреты в кандидат не попадают);
- подмена тенанта Viva, часового пояса и словарных id Viva по профилю;
- вырезание того, чего у клуба нет (абонементы, сплит-оплата, trial, staff).

Инструмент **не пишет** flow на хост. Он выдаёт кандидат и отчёт; применение —
через guarded installer (`allowedAdditionIds`), отдельным решением владельца.

## Входные данные

```bash
npm run nodered:modular:pull-147 -- /absolute/private/workspace
npm run tenant:clone-flow -- \
  --source /absolute/private/workspace/input/source.flow.json \
  --profile tenants/pade_prime.json \
  --out /absolute/private/workspace/candidate.flow.json \
  --report /absolute/private/workspace/report.json
```

`pull-147` использует обычный `scp`: если прямой маршрут до 147 закрыт, добавь
`ProxyCommand` в `~/.ssh/config` для `lk-primary-147` (на рабочей машине владельца это
локальный SOCKS5-прокси), иначе скрипт упадёт по таймауту.

## Профиль тенанта (`tenants/<slug>.json`)

| Поле | Назначение |
| --- | --- |
| `slug` | `^[a-z][a-z0-9_]{2,31}$`, основа детерминированных id |
| `vivaTenant` | tenant key нового клуба; подменяет `sourceVivaTenant` |
| `pathPrefix` | `/pade-prime` — префикс всех http-путей (`/pade-prime/lk/games`) |
| `collectionPrefix` | `pp_` — префикс коллекций (`pp_lk_games`) |
| `timezone` | `sourceOffset/offset` и `sourceIana/iana` — в LK1 захардкожено `+03:00` и `Europe/Moscow` |
| `tabs` | табы-источники: `LK Games`, `LK Composite game_create2`, `LK Communities` |
| `reuseConfigNodeIds` | живые конфиг-узлы, которые не клонируются (mongo client) |
| `dropHttpIn` | regex-ы вырезаемых эндпоинтов (абонементы, split, trial, staff) |
| `vivaIds` | словарные id Viva (`4588` направление клубной игры, `1613` тип) → id клуба |
| `bodyReplacements` | точные строки в телах функций (константы-списки классификации); отсутствие обязательной замены — ошибка |
| `blockers` | действия владельца/тенанта, без которых кандидат остаётся `deployable=false` |
| `globalKeyMap` | переименование ключей `global` в телах функций |

## Словарь тенанта из end-user API

Админского токена нет, поэтому справочники восстановлены анонимными end-user ручками
(2026-11-17, `tenants/pade_prime.dictionary.json`):

- `GET /end-user/api/v1/<key>/exercises/directions?size=200` — полный справочник направлений
  клуба (33 записи для `Dvjlor`); это недокументированная, но публичная ручка.
- `GET /end-user/api/v1/<key>/exercises?date=YYYY-MM-DD` — занятия дня с парами
  `direction.id/name` + `type.id/name`; за 14 дней у клуба наблюдался только тип `524 «Мастер-классы»`.
- `GET /end-user/api/v1/<key>/studios?size=1000` — станции, корты, город, часовой пояс.
- Не отвечают анонимно: `/directions`, `/types`, `/exercise-types`, `/dictionaries/*`
  (404), `/one-times` (401), `/products/master-services` (404). Справочник **типов занятий**
  целиком доступен только с админским токеном.

Что сопоставлено для `pade_prime` (в `bodyReplacements`):

| Константа LK1 | ПадлХАБ | Падел Прайм |
| --- | --- | --- |
| `OPEN_GAME_DIRECTION_IDS` | `[4588]` «Открытая игра на 4-ых человек.» | `[]` — направления нет, нужно создать |
| `OPEN_GAME_TYPE_IDS` | `[1613]` | `[]` — типа нет, нужно создать |
| `GROUP_TRAINING_TYPE_IDS` | `[605, 847, 963, 1208]` | `[524]` «Мастер-классы» (единственный наблюдаемый тип) |
| `TOURNAMENT_DIRECTION_IDS` | `[2617, 3284, 4769]` | `[1578, 1580, 2433, 2434, 2435, 2436, 6775]` |
| `TOURNAMENT_TYPE_IDS` | `[839, 1013]` | `[]` — тип турнира не наблюдался, классификация по названию |

Проверено, что id-пространства не пересекаются: ни один id направления клуба не совпадает
с числами из списков ПадлХАБа, поэтому «пустые» списки не дают ложных срабатываний —
классификация падает на маркеры названий (`игра`, `турнир`, `аренда`, `мастер-класс`).

## Обязательные гейты перед применением

Инструмент выходит с `deployable=false`, если:

- в кандидате остался исходный tenant-токен;
- осталась ссылка на узел, который вырезан;
- http-путь без `<pathPrefix>` или коллекция без `<collectionPrefix>`;
- тело функции не парсится после подстановок;
- клонируемый узел несёт секрет (`uri`, `password`, `token`, …);
- не заполнены `vivaIds` (словарные id чужого клуба нельзя угадывать).

Проверено на живом flow от 2026-11-17 (`sha256 a756904a…`): 5048 узлов на входе →
621 узел кандидата, 114 вырезано, 16 эндпоинтов отброшено, 66 http-путей, 25 коллекций,
0 ошибок, 0 предупреждений, 5 замен словаря применены. `deployable=false` остаётся
только из-за блокера: у клуба нет направления/типа открытой игры.

## Применение на 147 (additive, без правки живых узлов)

```bash
# 1. свежий live-преimage + фрагмент
npm run nodered:modular:pull-147 -- /abs/private/ws
npm run tenant:clone-flow -- --source /abs/private/ws/input/source.flow.json \
  --profile tenants/pade_prime.json --out /abs/private/ws/fragment.json --report /abs/private/ws/report.json

# 2. кандидат = живой flow + фрагмент, контракт только на добавления
node scripts/tenant_assemble_candidate.mjs --live /abs/private/ws/input/source.flow.json \
  --fragment /abs/private/ws/fragment.json --out /abs/private/ws/candidate.final.json \
  --contract /abs/private/ws/contract.json --deployment-id <id>

# 3. стейдж 0700 на 147 + preflight, затем apply со --stamp
#    (apply без --stamp падает: safeTimestamp требует YYYYMMDDTHHMMSS+ZZZZ)
node deploy_reviewed_flow_147_remote.mjs preflight --candidate … --contract … --deployment-id <id>
node deploy_reviewed_flow_147_remote.mjs apply     --candidate … --contract … --deployment-id <id> --stamp 20261117T123500+0300
```

`preflight` печатает `changedNodeCount: 0` и `addedNodeCount: N` — любое изменение живого
узла там же и обрывает применение. После `apply` скрипт сам делает бэкап, рестарт и
откат при сбое; успешный apply оставляет `soaking`-лиз на ~15 минут, который блокирует
следующий preflight.

### nginx

Маршрут `/pade-prime` — копия проверенного `/seliger`:

- 147: `location ^~ /pade-prime/ { proxy_pass http://127.0.0.1:1880; … CORS … }`;
- 89: `location ~ ^/pade-prime(/|$) { … proxy_pass https://padlhub.su; }` → цепочка
  89 → padlhub.su → 147 → Node-RED.

Обязательно `(/|$)` без `?`: иначе `/pade-prime-test/` попадает под тот же regex и
тестовая страница начинает отдавать 404 из чужого контура. Бэкап конфига держать
**вне** `sites-enabled` — файлы оттуда тоже грузятся и дают duplicate server_name.

### Что проверять после применения

| Проверка | Ожидание |
| --- | --- |
| `GET /lk/games?public=find&limit=1` (прод) | тот же статус и размер, что до применения |
| `GET /pade-prime/lk/games?public=find&limit=1` | `200`, `total: 0` (данные клуба пустые) |
| `GET /pade-prime/lk/chats/by-phone?phone=…` | `401 CHAT_AUTH_TOKEN_REQUIRED` |
| узлы в табах клона | 0 `mongodb4` без префикса `pp_`, 0 `http in` без `/pade-prime`, 0 `inject` |

## Что остаётся сделать вручную

1. Словарные id Viva нового клуба (направление клубной игры, тип занятия) — читаются
   админским токеном на 147, анонимные `/directions` и `exercises` для этого не годятся.
2. nginx: location `<pathPrefix>` → апстрим, `Access-Control-Allow-Origin` для домена
   Тильды клуба, `Access-Control-Allow-Headers: Authorization, Content-Type`.
3. Keycloak: домен клуба в allowlist `client_id=widget` (PKCE), иначе вход не работает,
   даже если OPTIONS отвечает 200.
4. Фронт: `.env.<slug>`, `vite.config.<slug>.ts`, отдельный `release-<slug>.json`,
   каталог на статик-хосте, блок T123 в их Тильде.
5. Коллекции `pp_*` создаются первым запросом; индексы выставить те же, что у `lk_*`
   (телефон, станция, даты, чат) — до первого реального трафика клуба.

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
| `globalKeyMap` | переименование ключей `global` в телах функций |

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
0 ошибок, 1 предупреждение (словарные id `1613`, `4588`).

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

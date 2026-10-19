# «Дружба.Пулково»: включение в контур обычной «Дружбы»

## Область и состояние

Владелец: Alexey. Аудитория: владельцы Viva-продукта
`d84534c8-aad1-46e1-ac6a-70296f319a3f` («Дружба.Пулково»).
Это критическое изменение расчёта скидок/бронирований, не изменение продажи продукта.
На этапе подготовки production не изменяется; включение, restart и merge не выполнены.

Read-only PRODUCTION-проверка 2026-10-16: каталог Viva вернул все 43/43 продукта;
Пулково — 30 дней/30 посещений, направления 4588, 6182, 6246; типы 1613, 2349.
Продукт отсутствовал в девяти установленных правилах `subscriptions_lk1_plan_rules`.

Копируется **установленное**, а не историческое source-правило обычной «Дружбы»:

| Свойство | Значение |
| --- | --- |
| `planKey` | `friendship` |
| `enforceFrom` | `2026-09-01` |
| `maxActiveBookings` | 8 |
| `freeGameMinutesPerDay` | 60 |
| `gameOverageDiscountPercent` | 30 |
| `groupTrainingDiscountPercent` | 50 |
| `tournamentDiscountPercent` | 50 |

Покупки до 2026-09-01 сохраняют legacy-поведение. Неустановленная дата покупки
отвергается действующим resolver. Порог 8 не является запретом девятой записи:
сверх порога бесплатные минуты не предоставляются, остаётся скидка на платную игру.
В legacy-ветке сохраняется `shared_day` и отказ повторного использования за день.
В enforced-когорте `ctx.lk1` направляет историю в учёт дневных бесплатных минут:
после использования 60 минут следующая игра в тот же день разрешена без бесплатных
минут, со скидкой 30%. Это действующее поведение обычной «Дружбы», а не новый запрет
или новая льгота Пулково. Группа/турнир не получают новый бесплатный визит.
Viva scope/стоимость/продажа, HUB и прочие продукты не меняются.

## Изменяемая поверхность

`scripts/patch_live_lk1_pulkovo_friendship.mjs` мигрирует ровно два существующих узла:

- `lk_subscription_booking_router_20260804`: `initialize` и `func`;
- `lk_subscription_price_preview_20260908_router`: `func`.

В `initialize` добавляется к точному prior одно правило с новым productId и всеми
остальными полями обычной «Дружбы». Writer допускает точный prior, своё итоговое
значение и пустой контекст после restart; чужое значение не перезаписывает.
В обоих роутерах UUID-only продукт распознаётся как `friendship`;
`6182/2349` — игра, `6246/2349` — турнир. Остальные corporate-направления не расширяются.
Evaluator, оплаты, HTTP-входы, wires и остальные узлы сохраняются.

Граф-preimage: `b51554ba16bbbc527615badfc437e8962e3d963bf4fe25f3d53879a3176c0f05`,
4822 узла. Не регенерировать его старым общим композитором и не обновлять исторические
пины ради этого включения. Любой drift останавливает подготовку/применение.

## Локальные команды

Новый приватный snapshot вне Git:

```
npm run nodered:modular:pull-147 -- /absolute/new/private/workspace
PULKOVO_LIVE_FLOW=/absolute/new/private/workspace/input/source.flow.json npm run test:lk1-pulkovo-friendship
node scripts/patch_live_lk1_pulkovo_friendship.mjs /absolute/new/private/workspace/input/source.flow.json /absolute/new/private/output
```

Builder не изменяет сервер, пишет candidate/contract/plan-rules вне Git с правами
0600 в новый каталог 0700, отказывается перезаписывать output.
Новый тест включён в автоматический unified-candidate CI. Live-snapshot проверки
в CI без приватного snapshot пропускаются; LOCAL-прогон с snapshot обязателен до apply.

## Исполнение только после разрешения точного пакета

1. Независимое review, проверки, точные source/candidate SHA и отдельное разрешение
   на target `lk-primary-147:/root/.node-red/flows.json`, один штатный restart и recovery.
2. Fresh live identity и lease; без совпадения полного preimage остановиться.
3. Новый защищённый `.padlhub-reviewed-flow-stage-*` (0700 root:root), candidate,
   contract и оба штатных installer-модуля (0600 root:root).
4. `deploy_reviewed_flow_147_remote.mjs preflight`, затем штатный `apply` с
   `deployment-id=lk1-pulkovo-friendship`. Exact backup создаёт installer.
5. Проверить digest кандидата, PM2 online/restart identity, отсутствие новых ошибок,
   фактический глобал правил через существующий авторизованный read-only context API
   либо разрешённый read-only quote. Чтение initialize с диска само по себе не является
   доказательством in-memory global. Сверить неизменность девяти прежних правил.
6. Выдержать штатный 15-минутный soak. Реальные create/booking/payment/cancel не выполнять.

Стоп-сигналы: foreign drift/lease, ошибка writer, неравенство правил, неуспешный PM2,
ошибочный quote, потеря доступности. Стоп-метод: не продолжать при preflight-ошибке;
после apply — только guarded rollback своего deployment из exact backup по
`docs/NODERED_MODULAR_WORKFLOW.md`. Не удалять lease, не возвращать устаревший общий flow,
не отменять реальные брони/платежи. Реальный booking E2E выполняет владелец отдельно.

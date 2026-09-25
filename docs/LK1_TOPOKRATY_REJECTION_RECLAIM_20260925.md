# LK1: отказ провайдера больше не блокирует запись, Топократы вне общих подписок (2026-09-25)

## Что случилось

Запись на тренировку Топократов (направление **6233**, тип 2349, 120 минут, 4 000 ₽,
Нагатинская) по абонементу «РА»:

1. LK1-контур оценивал событие по категории `group_training` и обещал бесплатное первое
   событие дня: `FREE_ENTITLEMENT`, 0 ₽, списание одного посещения.
2. Viva отказывала в записи: `HTTP 400 BAD_REQUEST` «Абонемент «РА» не действует на этом
   занятии: другой тип занятия, другое направление» — проданный абонемент ограничен своими
   направлениями и типами занятий.
3. Документ операции (`games.lk_subscription_daily_booking_ops`,
   `_id = lk1-product:[tenant,actor,operationId]`) оставался в состоянии `FAILED`, а
   `operationId` у клиента **детерминированный**
   (`lk-subscription-<hash(clientId|clientSubscriptionId|exerciseId)>`,
   `src/utils/tournamentSignupApi.ts`).
4. Поэтому каждый следующий POST с тем же id снова попадал в ingress-find и получал
   `202 PENDING_CONFIRMATION` «Запись или доплата требуют безопасной сверки»
   (`LK1_BOOKING_OUTCOME_UNRESOLVED`) — без причины и навсегда. Ни подписка, ни доплата, ни
   разовая оплата по этому событию больше не проходили (живые подтверждения: 18:02:26–18:02:46
   и 18:12:30–18:13:56, документ операции не менялся).

Тот же класс дефекта, что и ПРО-тренировки 2026-09-18: контур решает по категории, а провайдер
проверяет направление и тип абонемента.

## Что меняет поколение

Одно focused-поколение `lk1-topokraty-rejection-reclaim` (две ноды, по одному полю `func`):

### 1. `lk_subscription_booking_router_20260804.func`

* **Исключение Топократов.** Направления **6180** «Топократы игра» и **6233** «Топократы
  тренировка» вне всех не-клубных подписок: `409 TOPOKRATY_SUBSCRIPTION_UNAVAILABLE`
  («доступна разовая оплата или клубная подписка «Дружба Топократы»»). Клубный продукт
  `14692232-12be-4218-9fa1-2d5b79b62035` сохраняет подписной путь — его собственное правило
  несёт доплату за 1/4 корта. Отказ стоит **до** любого решения по подписке и до денежного
  readback. Исходный модуль правила: `scripts/lib/topokratyExclusion.mjs`.
* **Reclaim терминально отказанной операции.** Если сохранённая попытка никогда не доходила до
  брони и её запись в Viva была чисто (4xx) отклонена — либо попытки не было вовсе
  (`PREPARED` без `upstreamAttemptedAt`), — ingress возвращает документ в `PREPARED` тем же
  compare-and-set (`_id`, `operationId`, `actorClientId`, `state`, `attempts`,
  `bookingId`/`upstreamBookingId` пусты), сохраняя прежний отказ в `previousFailure` и
  увеличивая `attempts`, после чего запрос продолжается как новая попытка. Решение принимает
  `lk1ReclaimableAttempt(operation)`; кап — 5 попыток; `split_create_readonly_preflight` никогда
  не пишет. Неоднозначные исходы (`5xx`, транспорт, нет статуса), принятая провайдером запись,
  бронь, денежная нога, `visitJob` и `checkout` по-прежнему не переигрываются и остаются на
  прежнем пути сверки.
* Ручная разблокировка зависших операций **не требуется**: reclaim срабатывает на следующем же
  POST клиента.

### 2. `lk_subscription_price_preview_20260908_router.func`

Превью не котирует исключённые подписки: для не-клубной строки отвечает
`UNAVAILABLE / TOPOKRATY_SUBSCRIPTION_UNAVAILABLE`, клубная строка котируется как раньше.
Общий превью-источник (`scripts/nodered_subscription_price_preview_nodes/router.js`,
`scripts/patch_nodered_subscription_price_preview.mjs`) намеренно **не изменён**: его
пересборка сдвинула бы замороженный candidate уже отревьюенного клубного поколения
(`68debf14…`) и его ordered-rollback контракт. Исключение входит как собственная дельта этого
поколения.

### Виджет

`src/utils/topokratyExclusion.ts` — зеркало серверного правила; `GroupSchedulePage.tsx` при
исключённом событии не запрашивает скидку, не предлагает купленные подписки и пакеты и
оставляет только разовую оплату (как для ПРО). Правило обеих сторон пинится
`scripts/tests/topokratyExclusion.test.ts`.

## Деплой и откат

```bash
# Node-RED (guarded: exact preimage d6df38f3…, preflight, бэкап, readback, постпроверка, smoke)
NODE_RED_LK1_TOPOKRATY_RECLAIM_DEPLOY=CONFIRM_147 npm run nodered:lk1-topokraty-reclaim:deploy-147

# Откат на преimage (обычный restore flow; глобал plan-rules не затрагивается)
NODE_RED_LK1_TOPOKRATY_RECLAIM_ROLLBACK=CONFIRM_147 npm run nodered:lk1-topokraty-reclaim:rollback-147 -- <stamp>
```

Проверки: `npm run test:lk1-topokraty-reclaim`, `scripts/tests/proTrainingExclusion*.test.*`,
`scripts/tests/topokratyFriendshipHotfix.test.mjs` (замороженное клубное поколение обязано
по-прежнему собираться в `68debf14…`), `scripts/tests/subscriptionRejoinGateway.test.mjs`,
`scripts/tests/lk1PlanMoneyFirstUseHotfix.test.mjs`.

## Остаточные риски

* Первый POST до этого поколения маскировал причину отказа в 202 (`finalize.js`): после фикса
  отказ исключения приходит как честный `409`, потому что срабатывает до установки `ctx.lk1`.
* Правило «направление вне подписки» остаётся списком id (6180/6233): новое направление
  Топократов потребует расширения списка в `scripts/lib/topokratyExclusion.mjs` и
  `src/utils/topokratyExclusion.ts` (пинится тестом).
* Клубный путь «Дружба Топократы» с доплатой за 1/4 корта сейчас **откачен** (поколение
  `lk1-topokraty-friendship`); его повторное применение требует отдельного переноса денежного
  мандата из PR #153 (`lk1EventPaymentQuoteBinding` в `event_payments.js`) — вне этого фикса.
  Настоящее поколение этот путь не блокирует: клубная строка проходит guard.
* Покупка абонемента под конкретное занятие создаётся браузером прямо в Viva и этим контуром не
  переносится (тот же остаточный риск, что у ПРО-правила).

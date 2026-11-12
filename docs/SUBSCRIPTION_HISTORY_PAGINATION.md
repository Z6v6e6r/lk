# История записей и срок абонемента

Владелец: PadlHub LK. Аудитория: участники игр с абонементами.
Пагинация использует уже объединённую реализацию main из
[SUBSCRIPTION_BOOKING_PAGINATION.md](SUBSCRIPTION_BOOKING_PAGINATION.md): один
`collectVivaBookingPage`, 10 страниц/10000 строк, общий бюджет25секунд,
проверка actor/stage/URL/полноты, сохранение timeout и старейшего receipt.
Второй механизм чтения истории поверх неё не устанавливается.

Для ACTIVE экземпляра с доказанной expirationDate раньше начала игры preview
возвращает UNAVAILABLE / SUBSCRIPTION_DATE_NOT_COVERED. Виджет выводит:
«Действие абонемента не распространяется на дату игры».
Отсутствие доказательства срока, HTTP ошибка или неполный/устаревший quote batch
сохраняют техническую неопределённость. Причины отдельных абонементов отображаются
только после проверки полного batch. Лимиты, даты и существующие записи не меняются.

`prepare_subscription_history_release.mjs` готовит один focused candidate поверх
fresh private live147 workspace: source-preserving pagination composer при её
отсутствии, затем точная вставка причины даты. Проверяются whole-flow/function SHA,
unique IDs, enabled targets, обратимость дельт и exact graph (только func двух router,
без additions/wires/lifecycle/settings). Уже установленная пагинация сохраняется;
частичная установка или повторная установка date reason отклоняется.

CLI: `node scripts/prepare_subscription_history_release.mjs <private-live-workspace>
<empty-private-output> <clean-source-SHA> <flow-SHA256> <booking-SHA256> <preview-SHA256>`.
Кандидат/contract/report остаются вне Git. Этот preparer не выполняет live apply.
Исполнение — через существующий reviewed-flow runtime с shared flock, matching
lease, durable backups и guarded recovery. Перед restart проверить startup injects.
Публикация frontend требует чистого pushed source, prod config, manifest/hash readback.

При новых5xx/timeout, неправильной цене/допуске или несовпавших хэшах остановить
выкладку и использовать matching rollback без удаления чужого lease. Проверка
исходной ссылки выполняет только preview, без реальной записи/оплаты.
Offset paging не является атомарным Viva snapshot; отдельный confirmation_bookings
read сохраняет прежний single-page контракт. Исторические broad release/rebase
pins не продвигаются новым исходником и продолжают fail-closed.

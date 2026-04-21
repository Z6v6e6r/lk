# Weekly report: ЛК и Админка ЦУП

Период: `2026-04-05` - `2026-04-12`  
Часовой пояс: `Europe/Moscow`

Источник данных:
- `git log` за 7 дней
- текущий `git diff`
- даты изменения файлов (`mtime`)

Важно:
- значимая часть работ за неделю пока находится в рабочем дереве и не зафиксирована коммитами
- там, где нет отдельного коммита, дата и время указаны по `mtime` файлов и помечены как приблизительные
- в текущем diff не выделен отдельный фронт Админки ЦУП, поэтому в блоке ЦУП отражена backend / Node-RED часть, которая ее обслуживает

## ЛК

1. `2026-04-05 21:41` · Overlay игр
   Что изменили: подняли `z-index` overlay игр до `10020`.
   Для чего: overlay игр конфликтовал со стеком слоев ЛК и мог открываться ниже других элементов.
   К чему привело: модуль игр стал открываться поверх интерфейса стабильнее, без наложений по стеку.
   Файлы: `src/MyApp.css`
   Статус: commit `3d07e04`

2. `~2026-04-05 21:29` · Онбординг и hash-навигация
   Что изменили: добавили разбор и повторный запуск hash-действий через `resolveHashActionTarget` и `retriggerHashAction`, привязали это к онбордингу и быстрым действиям кабинета.
   Для чего: чтобы кнопки вида "Играть", "Турниры", "Групповые тренировки" корректно срабатывали даже при повторном входе на тот же hash.
   К чему привело: deeplink-навигация внутри ЛК стала стабильнее, уменьшились тупики при возврате из онбординга.
   Файлы: `src/components/cabinet/OnboardingModal.tsx`, `src/utils/hashActions.ts`, `src/components/cabinet/Cabinet.tsx`
   Статус: WIP

3. `~2026-04-06 15:54-22:23` · Сообщества и лента
   Что изменили: усилили social-layer в сообществах: карточки игр, карточки результатов, расширение feed-типов и адаптера, модальное окно новости с реакциями и комментариями.
   Для чего: превратить блок сообществ из статичного списка в живую ленту событий вокруг игр и контента.
   К чему привело: у ЛК появился более цельный engagement-сценарий вокруг комьюнити, новостей и матчей.
   Файлы: `src/components/cabinet/community-feed/CommunityFeed.tsx`, `src/components/cabinet/community-feed/CommunityGameCard.tsx`, `src/components/cabinet/community-feed/CommunityGameResultCard.tsx`, `src/components/cabinet/community-feed/CommunityNewsModal.tsx`, `src/components/cabinet/community-feed/feedAdapter.ts`, `src/components/cabinet/community-feed/feedTypes.ts`, `src/MyApp.css`
   Статус: WIP

4. `~2026-04-06 23:52-2026-04-07 11:21` · Отдельный кабинет академии
   Что изменили: вынесли академию в отдельный bundle и экранный сценарий с `AcademyApp`, `AcademyCabinet`, отдельным entry-point, контентом и стилями; сборка академии добавлена в pipeline.
   Для чего: дать академии самостоятельный кабинет с авторизацией, своей витриной и собственной логикой данных.
   К чему привело: появился отдельный branded-flow для FFC / academy с загрузкой профиля, записей, абонементов и сообществ.
   Файлы: `vite.config.academy.ts`, `src/academy.tsx`, `src/academy/AcademyApp.tsx`, `src/academy/AcademyCabinet.tsx`, `src/academy/content.ts`, `src/academy/academy.css`, `package.json`
   Статус: WIP

5. `~2026-04-06 23:53` · Чат с администратором из ЛК
   Что изменили: расширили `SupportChatWidget` и клиент API для загрузки станций, диалогов и сообщений, отправки событий в поддержку, выбора станции, polling и fallback-поведения.
   Для чего: нужен прямой канал из кабинета к администратору с сохранением истории по номеру телефона и привязкой к станции.
   К чему привело: в ЛК появился рабочий сценарий общения с администратором и переход в MAX как резервный канал.
   Файлы: `src/components/cabinet/SupportChatWidget.tsx`, `src/utils/apiClient.ts`
   Статус: WIP

6. `~2026-04-10 13:13` · Новые точки входа и overlay-маршруты
   Что изменили: в `MyApp` добавили обработку публичных маршрутов и deep-link сценариев для `/game_join`, `/game_create`, `/community_join`, а также открытие `games`, `tournaments` и `onboarding` как overlay-модулей.
   Для чего: чтобы игрок мог попадать в нужный сценарий из внешней ссылки, invite-link, callback после оплаты или community invite без ручной навигации по кабинету.
   К чему привело: вход в ключевые пользовательские сценарии стал единым и управляемым через URL и overlay.
   Файлы: `src/MyApp.tsx`, `src/games.tsx`, `src/components/games/GameJoinPage.tsx`, `src/context/OverlayScopeContext.tsx`, `src/onboarding.tsx`, `src/tournaments.tsx`
   Статус: WIP

7. `~2026-04-10 14:25` · Игры: создание, оплата, приглашения, результаты
   Что изменили: сильно расширили `GamesPage`: создание игры из существующей брони, payment sync, waitlist, invite-flow, сценарии публичного входа, расчет и показ rating impact, фото результата, шаринг и автопубликация в сообщества после оплаты.
   Для чего: закрыть полный цикл командной игры внутри ЛК от создания и оплаты до результата и социальных последствий.
   К чему привело: модуль игр стал почти end-to-end сценарием, а не только экраном просмотра слотов.
   Файлы: `src/components/games/GamesPage.tsx`, `src/utils/apiClient.ts`, `src/MyApp.css`
   Статус: WIP

8. `~2026-04-10 17:58-2026-04-11 09:16` · Турниры и Americano/Mexicano
   Что изменили: добавили полноценный `TournamentsPage` с выбором формата, настройкой кортов, ручными рейтингами участников, генерацией раундов, частичным сохранением результатов, таблицей standings и подготовкой данных к экспорту.
   Для чего: нужна управляемая турнирная логика прямо в ЛК, без ручной сборки вне системы.
   К чему привело: турнирный сценарий перестал быть черновиком и стал операционным модулем, связанным с backend-history.
   Файлы: `src/components/tournaments/TournamentsPage.tsx`, `src/components/tournaments/americanoLab.ts`, `src/utils/apiClient.ts`, `src/MyApp.css`
   Статус: WIP

9. `~2026-04-12 09:15-10:56` · Турниры в кабинете и сообществах
   Что изменили: кабинет стал подтягивать историю турниров по записям, показывать отдельные карточки турниров в активных и архивных бронированиях, а в сообществах появились турнирные карточки и возможность создавать tournament-post на основе реальных упражнений и участников.
   Для чего: сделать турниры first-class сценарием не только в отдельном модуле, но и в основном кабинете и в комьюнити-слое.
   К чему привело: пользователю теперь проще увидеть турнир в истории, открыть его, а сообществам проще публиковать турнирные события без ручного копирования данных.
   Файлы: `src/components/cabinet/Cabinet.tsx`, `src/components/cabinet/BookingsContainer.tsx`, `src/components/cabinet/BookingHistory.tsx`, `src/components/cabinet/TournamentBookingCard.tsx`, `src/components/cabinet/TournamentBookingCard.module.css`, `src/components/cabinet/CommunitiesSection.tsx`, `src/components/cabinet/community-feed/CommunityTournamentCard.tsx`, `src/components/cabinet/community-feed/CommunityTournamentCard.module.css`, `src/components/cabinet/community-feed/feedAdapter.ts`, `src/components/cabinet/community-feed/feedTypes.ts`, `src/components/cabinet/community-feed/communityMockData.ts`, `src/utils/apiClient.ts`
   Статус: WIP

## Админка ЦУП / backend / Node-RED

1. `~2026-04-05 19:10-19:14` · Результаты игр и окно спора
   Что изменили: добавили маршруты `/lk/games/:gameId/result/state`, `/lk/games/:gameId/result/submit`, `/lk/games/:gameId/result/dispute`, подготовку pending-result, логику подтверждения/оспаривания и обновление рейтингов.
   Для чего: нужна управляемая схема подтверждения результата игры с окном спора и дальнейшим пересчетом.
   К чему привело: backend-часть ЦУП получила жизненный цикл результата матча, а ЛК - API для показа состояния, отправки и dispute-flow.
   Файлы: `scripts/patch_nodered_results_flow.mjs`, `scripts/nodered_result_nodes/fn_result_confirm_apply.js`, `scripts/nodered_result_nodes/fn_result_state_response.js`, `scripts/nodered_result_nodes/fn_result_submit_build_insert.js`, `scripts/nodered_result_nodes/fn_result_submit_build_query.js`, `node-red/lk_game_results_nodes_import.json`, `node-red/ЛК03_03_26.with_games_chat_results.json`
   Статус: WIP

2. `~2026-04-08 15:36` · Autojoin в сообщества после оплаты игры
   Что изменили: собрали Node-RED слой, который определяет оплаченную игру, вычисляет игрока и станцию, находит подходящее сообщество по алиасам станции и обновляет membership, ranking, feed и events.
   Для чего: чтобы оплата игры автоматически вела не только к записи, но и к вовлечению игрока в сообщество станции.
   К чему привело: появился автоматический мост между оплатой игры и ростом сообщества, что важно для ЦУП и retention-механики.
   Файлы: `scripts/nodered_games_nodes/fn_autojoin_prepare.js`, `scripts/nodered_games_nodes/fn_autojoin_apply.js`, `scripts/nodered_games_nodes/fn_autojoin_patch_merge.js`, `scripts/patch_nodered_games_flow.mjs`, `node-red/ЛК03_03_26.with_games.json`
   Статус: WIP

3. `~2026-04-10 13:16-13:21` · Деплой и упаковка LK
   Что изменили: добавили скрипты для деплоя, упаковки и серверной установки bundle-артефактов по каналам `prod`, `dev`, `all`, с dry-run и резервными копиями.
   Для чего: убрать ручные ошибки при выкладке и стандартизировать операционный выпуск.
   К чему привело: релизный процесс стал воспроизводимым и понятным для передачи в ЦУП / админский контур.
   Файлы: `scripts/deploy-lk.sh`, `scripts/package-lk-upload.sh`, `scripts/server-install-lk.sh`, `package.json`
   Статус: WIP

4. `~2026-04-10 13:34-17:58` · Турнирный backend и выгрузка истории
   Что изменили: добавили backend-маршруты `/lk/tournaments/participants`, `/lk/tournaments/americano`, `/lk/tournaments/americano/results`, `/lk/tournaments/americano/history`, `/lk/tournaments/americano/history/export`; в модели появились `standings`, `playerLogs`, `summary`, экспорт CSV/XLSX.
   Для чего: дать турнирам не только UI, но и полноценный серверный слой для пересчета, истории и выгрузки.
   К чему привело: ЦУП/backend теперь может обслуживать турнирные сценарии, хранить историю пересчетов и отдавать выгрузки для анализа.
   Файлы: `scripts/nodered_games_nodes/fn_tournament_prepare.js`, `scripts/nodered_games_nodes/fn_tournament_recalculate.js`, `scripts/nodered_games_nodes/fn_tournament_export.js`, `scripts/patch_nodered_games_flow.mjs`, `node-red/ЛК03_03_26.with_games.json`, `node-red/поток-lk.mongodb4.json`
   Статус: WIP

## Замечания и риски

- За неделю накопилось много полезных изменений, но существенная часть пока не закрыта коммитами. Для следующего weekly это лучше переводить в более мелкие, предметные фиксации.
- Сборка академии уже заведена в `package.json`, но текущие deploy/package/install-скрипты пока ориентированы только на основные LK bundle-файлы и не включают academy-артефакты. Это стоит отдельно закрыть перед выкладкой академии.
- Недельный отчет дальше лучше пополнять через `docs/WORKLOG.md`, чтобы не восстанавливать историю по `mtime`.

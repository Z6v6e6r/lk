import { createRoot, type Root } from 'react-dom/client';
import { useEffect, useState } from 'react';
import './preview.css';
import { readMatrixSettings, type SubscriptionPlan } from './paymentMatrix';
import { PREVIEW_RESIDENCY_PRICE } from './bookingCheckout';
import { DAILY_USAGE, SUBSCRIPTION_PLANS, type DailyUsage } from './privilegeRules';

const screens = [
  ['game-booking', 'Игра', 'Выбор станции, корта и времени'],
  ['training-booking', 'Тренировка', 'Расписание и выбор тренировки'],
  ['tournament-booking', 'Турнир', 'Афиша и выбор турнира'],
  ['game-join', 'К игре', 'Приглашение и состав игроков'],
  ['training-join', 'К тренировке', 'Детали и варианты записи'],
  ['tournament-join', 'К турниру', 'Состав, регламент и запись'],
  ['game-list', 'Поиск игр', 'Открытые игры и игра с тренером'],
  ['matrix', 'Сравнить услуги', 'Все способы записи рядом'],
] as const;
const states = [
  ['ready', 'Есть места'], ['full', 'Нет мест'], ['registered', 'Уже записан'],
  ['guest', 'Гость'], ['loading', 'Загрузка'], ['empty', 'Пусто'], ['error', 'Ошибка'],
];

function Preview() {
  const params = new URLSearchParams(location.search);
  const initialScreen = params.get('screen') || 'game-booking';
  const [screen, setScreen] = useState(screens.some(([key]) => key === initialScreen) ? initialScreen : 'game-booking');
  const [state, setState] = useState(params.get('state') || 'ready');
  const [width, setWidth] = useState(params.get('width') === 'desktop' ? 'desktop' : 'mobile');
  const [revision, setRevision] = useState(0);
  const matrix = readMatrixSettings(params);
  const [subscription, setSubscription] = useState(matrix.profile.subscription);
  const [residency, setResidency] = useState(matrix.profile.residency);
  const [pass, setPass] = useState(matrix.profile.pass);
  const [boost, setBoost] = useState(matrix.boost);
  const [subscriptionPlan, setSubscriptionPlan] = useState<SubscriptionPlan>(matrix.subscriptionPlan === 'daily-hour' || matrix.subscriptionPlan === 'daily-training' ? 'friendship' : matrix.subscriptionPlan);
  const [dailyQuota, setDailyQuota] = useState(matrix.dailyQuota);
  const [activeLimitExceeded, setActiveLimitExceeded] = useState(matrix.activeLimitExceeded);
  const [dailyUsage, setDailyUsage] = useState<DailyUsage>(matrix.dailyUsage || (matrix.dailyQuota === 'used' ? matrix.subscriptionPlan === 'friendship-2' ? 'game-two-hours' : 'game-hour' : 'none'));
  const [groupCategory, setGroupCategory] = useState(matrix.proDirection ? 'pro' : matrix.excludedGroups ? 'excluded' : 'standard');
  const [friendsTournament, setFriendsTournament] = useState(matrix.friendsTournament);
  const [passFits, setPassFits] = useState(matrix.applicability.pass);
  const [passRemaining, setPassRemaining] = useState(params.get('passRemaining') ?? '3');
  const [residencyPrice, setResidencyPrice] = useState(params.get('residencyPrice') ?? String(PREVIEW_RESIDENCY_PRICE));
  const boostAllowed = subscription || residency;
  const standardTournament = (screen === 'tournament-booking' || screen === 'tournament-join') && groupCategory !== 'pro';
  const hasPro = subscription && (subscriptionPlan === 'ra' || subscriptionPlan === 'friendship-2');
  const proQuotaUsed = DAILY_USAGE.some(usage => usage.id === dailyUsage && 'pro' in usage && usage.pro);
  const query = new URLSearchParams({ screen, state, width, subscription: subscription ? '1' : '0', residency: residency ? '1' : '0', pass: pass ? '1' : '0',
    boost: boost && boostAllowed ? '1' : '0', subscriptionFits: '1', passFits: passFits ? '1' : '0', subscriptionPlan, dailyQuota,
    activeLimitExceeded: activeLimitExceeded ? '1' : '0', dailyUsage, proQuotaUsed: proQuotaUsed ? '1' : '0',
    groupCategory, friendsTournament: friendsTournament ? '1' : '0', residencyPrice, raFits: '1', passRemaining });
  const frameUrl = `/dev/booking-preview/frame.html?${query}&reset=${revision}`;
  const serialized = query.toString();
  useEffect(() => { history.replaceState(null, '', `?${serialized}`); }, [serialized]);
  const changeDailyUsage = (value: DailyUsage) => { setDailyUsage(value); setDailyQuota(value === 'none' ? 'available' : 'used'); };
  const changeDailyQuota = (used: boolean) => {
    setDailyQuota(used ? 'used' : 'available');
    setDailyUsage(used ? subscriptionPlan === 'friendship-2' ? 'game-two-hours' : 'game-hour' : 'none');
  };

  return <div className="preview-shell">
    <aside className="preview-sidebar">
      <a className="preview-brand" href="/">padlhub<span>локальная мастерская</span></a>
      <h1>Интерфейсы записи</h1>
      <p>Текущие компоненты ЛК<br />на тестовых данных</p>
      <nav aria-label="Сценарии">
        <h2>Запись</h2>
        {screens.map(([key, title, description], index) => <div key={key}>
          {index === 3 && <h2>Присоединение</h2>}
          {index === 6 && <h2>Дополнительно</h2>}
          <button className={screen === key ? 'is-active' : ''} aria-current={screen === key ? 'page' : undefined}
            onClick={() => setScreen(key)}>
            <strong>{title}</strong><span>{description}</span>
          </button>
        </div>)}
      </nav>
      <small>Запись и оплата имитируются.<br />Изменения компонентов видны сразу.</small>
    </aside>
    <main className="preview-main">
      <header className="preview-toolbar">
        <div><strong>{screens.find(([key]) => key === screen)?.[1]}</strong><span>Локальный просмотр</span></div>
        <div className="preview-controls">
          <label>Состояние <select value={state} onChange={event => setState(event.target.value)}>
            {states.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select></label>
          <div className="preview-size" role="group" aria-label="Размер экрана">
            <button aria-pressed={width === 'desktop'} onClick={() => setWidth('desktop')}>Широкий</button>
            <button aria-pressed={width === 'mobile'} onClick={() => setWidth('mobile')}>390 px</button>
          </div>
          <button className="preview-reset" onClick={() => setRevision(value => value + 1)}>Сбросить</button>
          <a href={frameUrl} target="_blank" rel="noreferrer">Открыть экран ↗</a>
        </div>
      </header>
      <section className="preview-privileges" aria-label="Условия матрицы">
        <div className="preview-products">
          <fieldset className="preview-product preview-product--subscription"><legend>1. Подписка</legend>
            <label className="preview-check"><input type="checkbox" checked={subscription} onChange={event => { setSubscription(event.target.checked); if (!event.target.checked && !residency) setBoost(false); }} />Есть подписка</label>
            <label className="preview-field">Выбор подписки<select value={subscriptionPlan} onChange={event => setSubscriptionPlan(event.target.value as SubscriptionPlan)}>
              {SUBSCRIPTION_PLANS.map(plan => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
            </select></label>
            <p>{SUBSCRIPTION_PLANS.find(plan => plan.id === subscriptionPlan)?.description}</p>
            <label className="preview-check"><input type="checkbox" checked={dailyQuota === 'used'} onChange={event => changeDailyQuota(event.target.checked)} />Занятие в день уже потрачено</label>
            <label className="preview-check"><input type="checkbox" checked={activeLimitExceeded} onChange={event => setActiveLimitExceeded(event.target.checked)} />Больше 8 активных записей</label>
            <small>После лимитов остаётся запись со скидкой 30% / 50%, кроме ПРО.</small>
          </fieldset>
          <fieldset className="preview-product"><legend>2. Резидентство</legend>
            <label className="preview-check"><input type="checkbox" checked={residency} onChange={event => { setResidency(event.target.checked); if (!event.target.checked && !subscription) setBoost(false); }} />Есть Резидентство</label>
            <label className="preview-field">Стоимость Резидентства, ₽<input type="number" min="0.01" step="0.01" value={residencyPrice} onChange={event => setResidencyPrice(event.target.value)} /></label>
          </fieldset>
          <fieldset className="preview-product"><legend>3. Абонемент Энергия 5</legend>
            <label className="preview-check"><input type="checkbox" checked={pass} onChange={event => setPass(event.target.checked)} />Есть Энергия 5</label>
            <label className="preview-field">Остаток тренировок<input type="number" min="0" max="5" step="1" value={passRemaining} onChange={event => setPassRemaining(event.target.value)} /></label>
            <label className="preview-check"><input type="checkbox" checked={standardTournament || passFits} disabled={standardTournament} onChange={event => setPassFits(event.target.checked)} />Энергия 5 подходит к событию</label>
            {standardTournament && <small>Обычные турниры доступны по Энергии 5.</small>}
          </fieldset>
          <fieldset className="preview-product preview-product--boost"><legend>4. РАбуста</legend>
            <label className="preview-check"><input type="checkbox" checked={boost && boostAllowed} disabled={!boostAllowed} onChange={event => setBoost(event.target.checked)} />Есть Буст</label>
            <p>{!boostAllowed ? 'Нужны действующее Резидентство или любая подписка.' : !subscription ? 'С Резидентством — условия РА: 1 час игры или одно событие в день. ПРО не входит.' : subscriptionPlan === 'friendship-2' ? '2 часа игры + тренировка, турнир или ПРО. ПРО — не более 1 события в общем дневном лимите.' : subscriptionPlan === 'ra' ? '2 часа игры или два события, включая игру 1 час + тренировку / турнир. ПРО входит в общий лимит — не более 1 в день.' : '2 часа игры или две тренировки / турнира, либо игра 1 час + тренировка / турнир. ПРО не входит.'}</p>
            {boost && boostAllowed && <label className="preview-field">Уже использовано сегодня<select value={dailyUsage} onChange={event => changeDailyUsage(event.target.value as DailyUsage)}>{DAILY_USAGE.filter(usage => hasPro || !('pro' in usage) || usage.id === dailyUsage).map(usage => <option key={usage.id} value={usage.id}>{usage.name}</option>)}</select></label>}
          </fieldset>
        </div>
        <div className="preview-event-rules"><label className="preview-field">Направление события<select value={groupCategory} onChange={event => setGroupCategory(event.target.value)}>
          <option value="standard">Обычное</option><option value="pro">ПРО</option><option value="excluded">Групповая без подписки и Резидентства</option>
        </select></label><label className="preview-check"><input type="checkbox" checked={friendsTournament} onChange={event => setFriendsTournament(event.target.checked)} />Турнир «Время на друзей»</label></div>
        <span>Корт 4 000 ₽/ч · моя ¼ — 1 000 ₽/ч · тренировка 5 500 ₽ · турнир 8 000 ₽</span>
      </section>
      <div className={`preview-stage preview-stage--${width}`}>
        <iframe key={`${serialized}-${revision}`} src={frameUrl} title="Интерфейс записи PadlHub"
          sandbox="allow-scripts allow-same-origin" />
      </div>
    </main>
  </div>;
}

// Preserve the React root when shared fixture/model edits re-evaluate an entry.
const previewRoot: Root = import.meta.hot?.data.previewRoot || createRoot(document.getElementById('root')!);
if (import.meta.hot) import.meta.hot.data.previewRoot = previewRoot;
previewRoot.render(<Preview />);

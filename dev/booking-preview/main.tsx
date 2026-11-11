import { createRoot, type Root } from 'react-dom/client';
import { useState } from 'react';
import './preview.css';
import { PRIVILEGE_PROFILES, readMatrixSettings } from './paymentMatrix';
import { PREVIEW_RESIDENCY_PRICE } from './bookingCheckout';

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
  const [width, setWidth] = useState(params.get('width') === 'mobile' ? 'mobile' : 'desktop');
  const [revision, setRevision] = useState(0);
  const matrix = readMatrixSettings(params);
  const [privileges, setPrivileges] = useState<string>(matrix.profile.id);
  const [subscriptionFits, setSubscriptionFits] = useState(matrix.applicability.subscription);
  const [passFits, setPassFits] = useState(matrix.applicability.pass);
  const [subscriptionPlan, setSubscriptionPlan] = useState<string>(matrix.subscriptionPlan);
  const [dailyQuota, setDailyQuota] = useState<string>(matrix.dailyQuota);
  const [excludedGroups, setExcludedGroups] = useState(matrix.excludedGroups);
  const [residencyPrice, setResidencyPrice] = useState(params.get('residencyPrice') ?? String(PREVIEW_RESIDENCY_PRICE));
  const query = new URLSearchParams({ screen, state, width, privileges, subscriptionFits: subscriptionFits ? '1' : '0', passFits: passFits ? '1' : '0', subscriptionPlan, dailyQuota, groupCategory: excludedGroups ? 'excluded' : 'standard', residencyPrice });
  const frameUrl = `/dev/booking-preview/frame.html?${query}&reset=${revision}`;
  const updateUrl = (key: string, value: string) => {
    query.set(key, value);
    history.replaceState(null, '', `?${query}`);
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
            onClick={() => { setScreen(key); updateUrl('screen', key); }}>
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
          <label>Состояние <select value={state} onChange={event => { setState(event.target.value); updateUrl('state', event.target.value); }}>
            {states.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select></label>
          <div className="preview-size" role="group" aria-label="Размер экрана">
            <button aria-pressed={width === 'desktop'} onClick={() => { setWidth('desktop'); updateUrl('width', 'desktop'); }}>Широкий</button>
            <button aria-pressed={width === 'mobile'} onClick={() => { setWidth('mobile'); updateUrl('width', 'mobile'); }}>390 px</button>
          </div>
          <button className="preview-reset" onClick={() => setRevision(value => value + 1)}>Сбросить</button>
          <a href={frameUrl} target="_blank" rel="noreferrer">Открыть экран ↗</a>
        </div>
      </header>
      <section className="preview-privileges" aria-label="Условия матрицы">
        <label>Ваши привилегии <select value={privileges} onChange={event => { setPrivileges(event.target.value); updateUrl('privileges', event.target.value); }}>
          {PRIVILEGE_PROFILES.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select></label>
        <div className="preview-applicability">
          <label><input type="checkbox" checked={subscriptionFits} onChange={event => { setSubscriptionFits(event.target.checked); updateUrl('subscriptionFits', event.target.checked ? '1' : '0'); }} />Тариф подходит к событию</label>
          <label><input type="checkbox" checked={passFits} onChange={event => { setPassFits(event.target.checked); updateUrl('passFits', event.target.checked ? '1' : '0'); }} />Абонемент подходит</label>
        </div>
        <div className="preview-subscription-rules">
          <label>Тариф подписки<select value={subscriptionPlan} onChange={event => { setSubscriptionPlan(event.target.value); updateUrl('subscriptionPlan', event.target.value); }}>
            <option value="daily-training">1 бесплатная тренировка в день</option><option value="daily-hour">1 бесплатный час в день</option>
          </select></label>
          <label>Дневной бесплатный лимит<select value={dailyQuota} onChange={event => { setDailyQuota(event.target.value); updateUrl('dailyQuota', event.target.value); }}>
            <option value="available">Доступен</option><option value="used">Уже использован</option>
          </select></label>
          <label>Категория групповых<select value={excludedGroups ? 'excluded' : 'standard'} onChange={event => { setExcludedGroups(event.target.value === 'excluded'); updateUrl('groupCategory', event.target.value); }}>
            <option value="standard">Обычная</option><option value="excluded">Без подписки и Резидентства</option>
          </select></label>
          <label>Стоимость Резидентства, ₽<input type="number" min="0.01" step="0.01" value={residencyPrice} onChange={event => { setResidencyPrice(event.target.value); updateUrl('residencyPrice', event.target.value); }} /></label>
        </div>
        <span>Корт 4 000 ₽/ч · моя ¼ — 1 000 ₽/ч · тренировка 5 500 ₽ · турнир 8 000 ₽</span>
      </section>
      <div className={`preview-stage preview-stage--${width}`}>
        <iframe key={`${screen}-${state}-${revision}-${privileges}-${subscriptionFits}-${passFits}-${subscriptionPlan}-${dailyQuota}-${excludedGroups}-${residencyPrice}`} src={frameUrl} title="Интерфейс записи PadlHub"
          sandbox="allow-scripts allow-same-origin" />
      </div>
    </main>
  </div>;
}

// Preserve the React root when shared fixture/model edits re-evaluate an entry.
const previewRoot: Root = import.meta.hot?.data.previewRoot || createRoot(document.getElementById('root')!);
if (import.meta.hot) import.meta.hot.data.previewRoot = previewRoot;
previewRoot.render(<Preview />);

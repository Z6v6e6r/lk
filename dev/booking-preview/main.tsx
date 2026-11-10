import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import './preview.css';

const screens = [
  ['game-booking', 'Игра', 'Выбор станции, корта и времени'],
  ['training-booking', 'Тренировка', 'Расписание и выбор тренировки'],
  ['tournament-booking', 'Турнир', 'Афиша и выбор турнира'],
  ['game-join', 'К игре', 'Приглашение и состав игроков'],
  ['training-join', 'К тренировке', 'Детали и варианты записи'],
  ['tournament-join', 'К турниру', 'Состав, регламент и запись'],
  ['game-list', 'Поиск игр', 'Открытые игры и игра с тренером'],
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
  const query = new URLSearchParams({ screen, state, width });
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
      <div className={`preview-stage preview-stage--${width}`}>
        <iframe key={`${screen}-${state}-${revision}`} src={frameUrl} title="Интерфейс записи PadlHub"
          sandbox="allow-scripts allow-same-origin" />
      </div>
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<Preview />);

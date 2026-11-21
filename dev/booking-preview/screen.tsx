import { createRoot, type Root } from 'react-dom/client';
import { AuthProvider } from './auth';
import { AppErrorBoundary } from '../../src/components/UI/AppErrorBoundary';
import { OverlayScopeProvider } from '../../src/context/OverlayScopeContext';
import GamesPage from '../../src/components/games/GamesPage';
import FindGamePage from '../../src/components/games/FindGamePage';
import GroupSchedulePage from '../../src/components/group-schedule/GroupSchedulePage';
import TournamentSignupPage from '../../src/components/tournament-signup/TournamentSignupPage';
import { MatrixPaymentOptions } from './MatrixPaymentOptions';
import { SERVICES } from './paymentMatrix';
import { PREVIEW_COURT_HOURLY_PRICE } from './gamePreviewPrice';
import { eventDate, comparisonEventDetails } from './fixtures';
import { navigatePreview, previewScheduleUrl } from './previewNavigation';
import '../../src/index.css';
import '../../src/MyApp.css';
import './lk2-skin.css';

const params = new URLSearchParams(location.search);
const screen = params.get('screen') || 'game-booking';
function navigate(nextScreen: string) {
  params.set('screen', nextScreen);
  location.search = params.toString();
}
// Keep invitation links inside the fixture environment, including links copied
// by product components. The iframe also prevents top navigation and popups.
document.addEventListener('click', event => {
  const anchor = event.target instanceof Element ? event.target.closest('a') : null;
  if (!anchor?.href) return;
  event.preventDefault();
  navigatePreview(anchor.href);
});

function Screen() {
  const back = () => navigate(screen.includes('training') ? 'training-booking' : screen.includes('tournament') ? 'tournament-booking' : 'game-list');
  const state = params.get('state');
  if (state === 'error' || state === 'empty' || state === 'loading') return <section className="matrix-state" aria-busy={state === 'loading'}>
    <h1>{state === 'loading' ? 'Загружаем события…' : state === 'empty' ? 'События не найдены' : 'Не удалось загрузить события'}</h1>
    {state === 'loading' ? <div className="matrix-skeleton" aria-hidden="true"><span /><span /><span /></div> : <p>{state === 'empty' ? 'На выбранную дату нет доступных событий. Выберите другую дату в расписании.' : 'Попробуйте загрузить данные ещё раз.'}</p>}
    <button type="button" onClick={() => { if (state !== 'error') { location.assign(previewScheduleUrl(location.href)); return; } params.set('state', 'ready'); location.search = params.toString(); }}>{state === 'loading' ? 'Вернуться к расписанию' : state === 'empty' ? 'Открыть расписание' : 'Повторить'}</button>
  </section>;
  switch (screen) {
    case 'matrix': return <div className="matrix-comparison"><h1>Способы записи на услуги</h1><p>Выберите привилегии в панели стенда — варианты обновятся для всех трёх услуг.</p><div>{(['game', 'training', 'tournament'] as const).map(service => <MatrixPaymentOptions key={service} service={service} gamePaymentScope={service === 'game' ? 'quarter' : undefined} courtAmount={service === 'game' ? PREVIEW_COURT_HOURLY_PRICE * SERVICES.game.durationMinutes / 60 : undefined} eventKey={`demo-comparison-${service}`} eventDetails={comparisonEventDetails[service]} />)}</div></div>;
    case 'game-booking': return <GamesPage onBack={back} publicCreateEntry />;
    case 'game-join': return <GamesPage onBack={back} openGameId="demo-game" />;
    case 'game-list': return <FindGamePage onBack={back} cabinetUrl="?screen=game-list" includeGamePlusTrainer />;
    case 'training-booking': return <GroupSchedulePage onBack={back} initialDate={eventDate} />;
    case 'training-join': return <GroupSchedulePage onBack={back} initialDate={eventDate} initialExerciseId={params.get('eventId') || "demo-training-1"} />;
    case 'tournament-booking': return <TournamentSignupPage onBack={back} initialDate={eventDate} />;
    case 'tournament-join': return <TournamentSignupPage onBack={back} initialDate={eventDate} initialTournamentId={params.get('eventId') || "demo-tournament-1"} />;
    default: return <p>Выберите экран в меню стенда.</p>;
  }
}

// Preserve the React root when shared fixture/model edits re-evaluate an entry.
const previewRoot: Root = import.meta.hot?.data.previewRoot || createRoot(document.getElementById('root')!);
if (import.meta.hot) import.meta.hot.data.previewRoot = previewRoot;
previewRoot.render(
  <AppErrorBoundary module="booking-preview"><OverlayScopeProvider value={false}>
    <AuthProvider><Screen /></AuthProvider>
  </OverlayScopeProvider></AppErrorBoundary>,
);

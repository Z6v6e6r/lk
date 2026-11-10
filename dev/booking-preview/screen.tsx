import { createRoot } from 'react-dom/client';
import { useAuth, AuthProvider } from './auth';
import { AppErrorBoundary } from '../../src/components/UI/AppErrorBoundary';
import { OverlayScopeProvider } from '../../src/context/OverlayScopeContext';
import { AuthForm } from '../../src/components/auth/AuthForm';
import GamesPage from '../../src/components/games/GamesPage';
import FindGamePage from '../../src/components/games/FindGamePage';
import GroupSchedulePage from '../../src/components/group-schedule/GroupSchedulePage';
import TournamentSignupPage from '../../src/components/tournament-signup/TournamentSignupPage';
import { eventDate } from './fixtures';
import '../../src/index.css';
import '../../src/MyApp.css';

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
  const url = new URL(anchor.href);
  event.preventDefault();
  if (url.pathname.includes('game_join') || url.searchParams.has('joinGame')) navigate('game-join');
  else if (url.pathname.includes('game_create')) navigate('game-booking');
  else if (url.pathname.includes('group')) navigate('training-join');
  else if (url.pathname.includes('tournament')) navigate('tournament-join');
});

function Screen() {
  const { isAuthenticated } = useAuth();
  const back = () => navigate(screen.includes('training') ? 'training-booking' : screen.includes('tournament') ? 'tournament-booking' : 'game-list');
  if (!isAuthenticated && (screen === 'game-booking' || screen === 'game-join')) return <AuthForm onLogin={() => {}} />;
  switch (screen) {
    case 'game-booking': return <GamesPage onBack={back} publicCreateEntry />;
    case 'game-join': return <GamesPage onBack={back} openGameId="demo-game" />;
    case 'game-list': return <FindGamePage onBack={back} cabinetUrl="?screen=game-list" includeGamePlusTrainer />;
    case 'training-booking': return <GroupSchedulePage onBack={back} initialDate={eventDate} />;
    case 'training-join': return <GroupSchedulePage onBack={back} initialDate={eventDate} initialExerciseId="demo-training-1" />;
    case 'tournament-booking': return <TournamentSignupPage onBack={back} initialDate={eventDate} />;
    case 'tournament-join': return <TournamentSignupPage onBack={back} initialDate={eventDate} initialTournamentId="demo-tournament-1" />;
    default: return <p>Выберите экран в меню стенда.</p>;
  }
}

createRoot(document.getElementById('root')!).render(
  <AppErrorBoundary module="booking-preview"><OverlayScopeProvider value={false}>
    <AuthProvider><Screen /></AuthProvider>
  </OverlayScopeProvider></AppErrorBoundary>,
);

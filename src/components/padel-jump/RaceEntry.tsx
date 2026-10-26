import { VivaAuthProvider } from '../../context/VivaAuthProvider';
import { useAuth } from '../../context/authShared';
import { VivaAuthForm } from '../auth/VivaAuthForm';
import RaceJump from './RaceJump';
import './live.css';

function CommunityRace() {
  const { isAuthenticated, needsPhoneVerification, isRestoringSession, logout } = useAuth();
  if (isRestoringSession) return <main className="pj-race-auth"><p role="status">Восстанавливаем вход в ПадлхАБ…</p></main>;
  if (isAuthenticated && !needsPhoneVerification) return <RaceJump onChangeProfile={logout} />;
  return <main className="pj-race-auth"><h1>Jump · заезд команды</h1><p>Войди через Яндекс или по номеру своего профиля ПадлхАБ.</p><VivaAuthForm oauthProviders={["yandex"]} onLogin={() => {}} /><a href="./padel-jump.html">Обычная игра</a></main>;
}

export default function RaceEntry() {
  return <VivaAuthProvider oauthCallbackMode="current-page"><CommunityRace /></VivaAuthProvider>;
}

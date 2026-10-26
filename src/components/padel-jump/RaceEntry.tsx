import { VivaAuthProvider } from '../../context/VivaAuthProvider';
import { useAuth } from '../../context/authShared';
import { VivaAuthForm } from '../auth/VivaAuthForm';
import RaceAdmission from './RaceAdmission';
import { racePageUrl } from './race-navigation';
import './live.css';

function CommunityRace() {
  const { isAuthenticated, needsPhoneVerification, isRestoringSession, logout } = useAuth();
  if (isRestoringSession) return <main className="pj-race-auth"><p role="status">Восстанавливаем вход в ПадлхАБ…</p></main>;
  if (isAuthenticated && !needsPhoneVerification) return <RaceAdmission onChangeProfile={logout} />;
  return <main className="pj-race-auth"><h1>ПадлхАБ Jump - займи свое место в рейтинге</h1><p>Войди через Яндекс или по номеру своего профиля ПадлхАБ.</p><VivaAuthForm oauthProviders={["yandex"]} onLogin={() => {}} /><a href={racePageUrl('practice')}>Обычная игра</a></main>;
}

export default function RaceEntry() {
  return <VivaAuthProvider oauthCallbackMode="current-page"><CommunityRace /></VivaAuthProvider>;
}

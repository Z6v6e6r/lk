import { VivaAuthProvider } from '../../context/VivaAuthProvider';
import { useAuth } from '../../context/authShared';
import { VivaAuthForm } from '../auth/VivaAuthForm';
import RaceJump from './RaceJump';
import './live.css';

function CommunityRace() {
  const { isAuthenticated, needsPhoneVerification, isRestoringSession } = useAuth();
  if (isRestoringSession) return <main className="pj-race-auth"><p role="status">Восстанавливаем вход в ПадлхАБ…</p></main>;
  if (isAuthenticated && !needsPhoneVerification) return <RaceJump />;
  return <main className="pj-race-auth"><h1>Jump · заезд команды</h1><p>Войди по номеру своего профиля ПадлхАБ. Если ты входил на другом сайте клуба, здесь потребуется подтвердить номер ещё раз.</p><VivaAuthForm allowOAuth={false} onLogin={() => {}} /><a href="./padel-jump.html">Обычная игра</a></main>;
}

export default function RaceEntry() {
  return <VivaAuthProvider><CommunityRace /></VivaAuthProvider>;
}

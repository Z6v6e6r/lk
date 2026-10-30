import { useId } from 'react';
import logo from '../../assets/logo-hab-compact.svg';
import { LIVE_LIVES } from './live-contract';
import { racePageUrl } from './race-navigation';
import './jump-start.css';

type Props = {
  profile: { name: string; communityId: string } | null;
  checking: boolean;
  pending: boolean;
  onBegin: () => void;
  onRetryProfile: () => void;
  onChangeProfile?: () => void;
  onCheckAdmission?: () => void;
};

export function RaceStart({ profile, checking, pending, onBegin, onRetryProfile, onChangeProfile, onCheckAdmission }: Props) {
  const titleId = useId(), noteId = useId(), rankedNoteId = useId();
  const initials = profile?.name.trim().split(/\s+/).slice(0, 2).map(part => Array.from(part)[0]).join('').toUpperCase() || '…';
  return <>
    <header className="jump-header">
      <div className="jump-brand"><img src={logo} alt="ПадлхАБ" /><span className="jump-game">Jump</span></div>
      <a className="jump-link" href={racePageUrl('live')}>Общий экран ↗</a>
    </header>
    <section className="jump-body pj-race-profile" aria-labelledby={titleId}>
      <h1 className="jump-title" id={titleId}>Собери больше звёзд</h1>
      <div className="jump-lives"><span className="jump-balls" aria-hidden="true">{Array.from({ length: LIVE_LIVES }, (_, index) => <span key={index} className="jump-ball" />)}</span><span>{LIVE_LIVES} жизней на попытку</span></div>
      <div className="jump-player">
        <span className="jump-avatar" aria-hidden="true">{initials}</span>
        <div className="jump-identity"><span className="jump-caption">Играешь как</span><span className="jump-player-name">{profile ? profile.name : checking ? 'Подтверждаем профиль сообщества…' : 'Профиль пока не подтверждён'}</span></div>
        {onChangeProfile && <button className="jump-link jump-profile-action" type="button" aria-label="Выйти из профиля" onClick={onChangeProfile}>Выйти</button>}
      </div>
      {!profile && <div role="status"><button className="jump-link" disabled={checking} onClick={onRetryProfile}>Проверить профиль</button>{onCheckAdmission && <button className="jump-link" onClick={onCheckAdmission}>Вернуться к проверке участия</button>}</div>}
      <p className="jump-input-hint"><span className="jump-phone" aria-hidden="true" /><span>Управляй мячом наклоном телефона</span></p>
      <button className="jump-button jump-button--primary" type="button" disabled={pending || !profile} onClick={onBegin} aria-describedby={rankedNoteId}>{pending ? 'Подключаем…' : <>Играть на рейтинг <span aria-hidden="true">→</span></>}</button>
      <p className="jump-note" id={rankedNoteId}>Твоё имя, игра и результат будут видны на общем экране.</p>
      <a className="jump-button jump-button--secondary" href={racePageUrl('practice')} aria-describedby={noteId}>Играть без рейтинга</a>
      <p className="jump-note" id={noteId}>Личный прогресс сохраняется отдельно.</p>
      <details className="jump-rules"><summary>Как играть и попасть в рейтинг</summary><p><strong>Цель.</strong> Управляй мячом и собирай звёзды. На каждую попытку даётся {LIVE_LIVES} жизней.</p><p><strong>Рейтинг.</strong> Чем больше звёзд, тем выше место. При равном числе звёзд выше игрок, который потратил меньше времени. Результат связан с твоим профилем сообщества.</p></details>
    </section>
  </>;
}

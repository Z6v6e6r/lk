import './padel-jump.css';

export default function PadelJumpCard() {
  const url = new URL(window.location.href);
  url.searchParams.set('padelJump', '1');
  return (
    <a className="pj-card" href={url.toString()}>
      <span aria-hidden="true">🎾</span>
      <span><strong>PadlHub Jump</strong><small>Твой корт. Твой взлёт. Попробуй побить рекорд.</small></span>
      <span aria-hidden="true">↗</span>
    </a>
  );
}

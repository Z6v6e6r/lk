import { useEffect, useRef } from 'react';
import { mountLiveSpectator } from './spectator/controller.mjs';
import { createReadonlyRenderer } from './spectator/renderer';
import logo from '../../assets/logo-hab-compact.svg';
import './spectator/spectator.css';
import './spectator/spectator-ui-extra.css';
import './spectator/scoreboard.css';

export default function LiveScreen() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!root.current) return;
    const requested = new URLSearchParams(window.location.search).get('network');
    const profile = requested === 'normal' || requested === 'fallback' ? requested : 'constrained';
    return mountLiveSpectator(root.current, { logoUrl: logo, createRenderer: createReadonlyRenderer,
      profile, onJoin: () => window.location.assign('./padel-jump-race.html') });
  }, []);
  return <div ref={root} />;
}

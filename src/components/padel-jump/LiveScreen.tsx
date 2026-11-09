import { useEffect, useRef } from 'react';
import { mountLiveSpectator } from './spectator/controller.mjs';
import { createReadonlyRenderer } from './spectator/renderer';
import logo from '../../assets/logo-hab-compact.svg';
import { isExhibitionRoute, exhibitionApi } from './exhibition';
import { racePageUrl } from './race-navigation';
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
      profile, ...(isExhibitionRoute() ? { api: exhibitionApi() } : {}), onJoin: () => window.location.assign(racePageUrl('race')) });
  }, []);
  return <div ref={root} />;
}

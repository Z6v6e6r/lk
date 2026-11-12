import { useEffect, useRef } from 'react';
import { mountLiveSpectator } from './spectator/controller.mjs';
import { createReadonlyRenderer } from './spectator/renderer';
import logo from '../../assets/logo-hab-compact.svg';
import { isExhibitionRoute, exhibitionApi } from './exhibition';
import { racePageUrl } from './race-navigation';
import './spectator/spectator.css';
import './spectator/spectator-ui-extra.css';
import './spectator/scoreboard.css';
import './spectator/spectator-tv.css';

const DEMO_SCENARIOS = new Set(['1', '2', '3', '4', '5', '6', '7', 'loop']);

/** `tv=1|0` forces the 16:9 stage; otherwise a landscape exhibition wall gets it automatically. */
export function wantsTvStage(search: string, width: number, height: number, exhibition: boolean): boolean {
  const forced = new URLSearchParams(search).get('tv');
  if (forced === '1') return true;
  if (forced === '0') return false;
  return exhibition && width >= 900 && height > 0 && width / height >= 1.55;
}

export default function LiveScreen() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!root.current) return;
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('network');
    const profile = requested === 'normal' || requested === 'fallback' ? requested : 'constrained';
    const demo = params.get('jumpDemo');
    const exhibition = isExhibitionRoute();
    return mountLiveSpectator(root.current, { logoUrl: logo, createRenderer: createReadonlyRenderer,
      profile, ...(exhibition ? { api: exhibitionApi() } : {}), onJoin: () => window.location.assign(racePageUrl('race')),
      tv: wantsTvStage(window.location.search, window.innerWidth, window.innerHeight, exhibition),
      demo: demo !== null && DEMO_SCENARIOS.has(demo) ? demo : null });
  }, []);
  return <div ref={root} />;
}

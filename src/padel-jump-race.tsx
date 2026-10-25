import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import RaceJump from './components/padel-jump/RaceJump';
const root = document.getElementById('padel-jump-root');
if (root) createRoot(root).render(<StrictMode><RaceJump /></StrictMode>);

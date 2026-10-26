import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import RaceEntry from './components/padel-jump/RaceEntry';
const root = document.getElementById('padel-jump-root');
if (root) createRoot(root).render(<StrictMode><RaceEntry /></StrictMode>);

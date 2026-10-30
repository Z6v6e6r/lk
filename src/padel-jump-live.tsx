import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import LiveScreen from './components/padel-jump/LiveScreen';
const root = document.getElementById('padel-jump-root');
if (root) createRoot(root).render(<StrictMode><LiveScreen /></StrictMode>);

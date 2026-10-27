import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import PadelJump from './components/padel-jump/PadelJump';

const container = document.getElementById('padel-jump-root');
if (container) createRoot(container).render(<StrictMode><PadelJump /></StrictMode>);

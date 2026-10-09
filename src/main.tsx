import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './app/App';
import { engine } from './app/engine';
import { useStore } from './app/store';

// dev builds only: expose the store and engine for debugging from the console / browser tests
if (import.meta.env.DEV) Object.assign(window, { __c3u: { useStore, engine } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

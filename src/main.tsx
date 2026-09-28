import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/800.css';
import '@fontsource/anton/400.css';
import '@fontsource/bebas-neue/400.css';
import './styles.css';
import { App } from './App';
import { createBackend } from './backend';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App backend={createBackend()} />
  </StrictMode>,
);

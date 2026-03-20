import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppProviders } from './app/providers.tsx';

function getRootElement(): HTMLElement {
  const rootElement = document.getElementById('app');
  if (rootElement == null) {
    throw new Error('Hydra web root element "#app" was not found.');
  }

  return rootElement;
}

createRoot(getRootElement()).render(
  <React.StrictMode>
    <AppProviders />
  </React.StrictMode>,
);

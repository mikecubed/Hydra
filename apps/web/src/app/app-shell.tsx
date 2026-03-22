import { type JSX, useContext } from 'react';
import { Outlet } from '@tanstack/react-router';
import {
  ConnectionBanner,
  ConnectionStateContext,
} from '../features/chat-workspace/components/connection-banner.tsx';

export { ConnectionStateContext };

export function AppShell(): JSX.Element {
  const connectionState = useContext(ConnectionStateContext);

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#0f172a',
        color: '#e2e8f0',
        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <header
        role="banner"
        style={{
          borderBottom: '1px solid rgba(148, 163, 184, 0.2)',
          padding: '1.5rem 2rem',
        }}
      >
        <p
          style={{
            margin: 0,
            fontSize: '0.875rem',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          Hydra
        </p>
        <h1 style={{ margin: '0.35rem 0 0', fontSize: '1.875rem' }}>Hydra Workspace</h1>
      </header>

      {connectionState != null && <ConnectionBanner connection={connectionState} />}

      <main style={{ margin: '0 auto', maxWidth: '72rem', padding: '2rem' }}>
        <Outlet />
      </main>
    </div>
  );
}

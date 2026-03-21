import type { JSX } from 'react';
import { Navigate } from '@tanstack/react-router';

export function WorkspaceIndexRoute(): JSX.Element {
  return <Navigate to="/workspace" replace />;
}

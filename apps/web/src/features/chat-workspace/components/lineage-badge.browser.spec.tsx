import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { LineageBadge } from './lineage-badge.tsx';
import type { ConversationLineageState } from '../model/workspace-types.ts';

afterEach(() => {
  cleanup();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeLineage(
  overrides: Partial<ConversationLineageState> = {},
): ConversationLineageState {
  return {
    sourceConversationId: 'conv-root',
    sourceTurnId: 'turn-5',
    relationshipKind: 'branch',
    ...overrides,
  };
}

// ─── Rendering ──────────────────────────────────────────────────────────────

describe('LineageBadge', () => {
  it('renders a badge with the relationship kind label', () => {
    render(<LineageBadge lineage={makeLineage()} />);
    expect(screen.getByTestId('lineage-badge')).toBeInTheDocument();
    expect(screen.getByText(/branch/i)).toBeInTheDocument();
  });

  it('renders the source conversation reference', () => {
    render(
      <LineageBadge lineage={makeLineage({ sourceConversationId: 'conv-parent' })} />,
    );
    expect(screen.getByTestId('lineage-badge')).toHaveTextContent('conv-parent');
  });

  it('renders follow-up relationship', () => {
    render(<LineageBadge lineage={makeLineage({ relationshipKind: 'follow-up' })} />);
    expect(screen.getByText(/follow-up/i)).toBeInTheDocument();
  });

  it('renders retry relationship', () => {
    render(<LineageBadge lineage={makeLineage({ relationshipKind: 'retry' })} />);
    expect(screen.getByText(/retry/i)).toBeInTheDocument();
  });

  it('renders nothing when lineage is null', () => {
    const { container } = render(<LineageBadge lineage={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when relationshipKind is null', () => {
    const { container } = render(
      <LineageBadge lineage={makeLineage({ relationshipKind: null })} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('includes the source turn reference', () => {
    render(
      <LineageBadge lineage={makeLineage({ sourceTurnId: 'turn-42' })} />,
    );
    expect(screen.getByTestId('lineage-badge')).toHaveTextContent('turn-42');
  });
});

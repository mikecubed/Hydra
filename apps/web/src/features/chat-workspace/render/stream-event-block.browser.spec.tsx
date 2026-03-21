import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { StreamEventBlock } from '../components/stream-event-block.tsx';
import type { StreamEventKind } from '@hydra/web-contracts';

afterEach(() => {
  cleanup();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

interface TestStreamEvent {
  readonly seq: number;
  readonly turnId: string;
  readonly kind: StreamEventKind;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly timestamp: string;
}

function createEvent(overrides: Partial<TestStreamEvent> = {}): TestStreamEvent {
  return {
    seq: 0,
    turnId: 'turn-1',
    kind: 'text-delta',
    payload: {},
    timestamp: '2026-03-20T12:00:00.000Z',
    ...overrides,
  };
}

// ─── text-delta ─────────────────────────────────────────────────────────────

describe('StreamEventBlock — text-delta', () => {
  it('renders text-delta payload text content', () => {
    const event = createEvent({
      kind: 'text-delta',
      payload: { text: 'Hello from stream' },
    });

    render(<StreamEventBlock event={event} />);
    expect(screen.getByText('Hello from stream')).toBeTruthy();
  });

  it('renders text-delta with HTML-like content safely', () => {
    const event = createEvent({
      kind: 'text-delta',
      payload: { text: '<script>alert("xss")</script>' },
    });

    const { container } = render(<StreamEventBlock event={event} />);
    expect(document.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>');
  });

  it('renders empty text-delta without crashing', () => {
    const event = createEvent({
      kind: 'text-delta',
      payload: { text: '' },
    });

    const { container } = render(<StreamEventBlock event={event} />);
    expect(container).toBeTruthy();
  });
});

// ─── status-change ──────────────────────────────────────────────────────────

describe('StreamEventBlock — status-change', () => {
  it('renders status-change with a status label', () => {
    const event = createEvent({
      kind: 'status-change',
      payload: { status: 'executing', message: 'Agent is working…' },
    });

    render(<StreamEventBlock event={event} />);
    expect(screen.getByText('executing')).toBeTruthy();
    expect(screen.getByText('Agent is working…')).toBeTruthy();
  });

  it('renders status-change without optional message', () => {
    const event = createEvent({
      kind: 'status-change',
      payload: { status: 'completed' },
    });

    render(<StreamEventBlock event={event} />);
    expect(screen.getByText('completed')).toBeTruthy();
  });
});

// ─── stream-started / stream-completed / stream-failed ──────────────────────

describe('StreamEventBlock — lifecycle events', () => {
  it('renders stream-started with kind badge', () => {
    const event = createEvent({ kind: 'stream-started', payload: {} });

    render(<StreamEventBlock event={event} />);
    expect(screen.getByText('stream-started')).toBeTruthy();
  });

  it('renders stream-completed', () => {
    const event = createEvent({ kind: 'stream-completed', payload: {} });

    render(<StreamEventBlock event={event} />);
    expect(screen.getByText('stream-completed')).toBeTruthy();
  });

  it('renders stream-failed with error message', () => {
    const event = createEvent({
      kind: 'stream-failed',
      payload: { error: 'Connection lost' },
    });

    render(<StreamEventBlock event={event} />);
    expect(screen.getByText('stream-failed')).toBeTruthy();
    expect(screen.getByText('Connection lost')).toBeTruthy();
  });
});

// ─── error / warning ────────────────────────────────────────────────────────

describe('StreamEventBlock — error and warning', () => {
  it('renders error event with message', () => {
    const event = createEvent({
      kind: 'error',
      payload: { message: 'Something went wrong' },
    });

    render(<StreamEventBlock event={event} />);
    expect(screen.getByText('Something went wrong')).toBeTruthy();
  });

  it('renders warning event with message', () => {
    const event = createEvent({
      kind: 'warning',
      payload: { message: 'Rate limit approaching' },
    });

    render(<StreamEventBlock event={event} />);
    expect(screen.getByText('Rate limit approaching')).toBeTruthy();
  });

  it('escapes HTML in error messages', () => {
    const event = createEvent({
      kind: 'error',
      payload: { message: '<b>bold</b> error' },
    });

    const { container } = render(<StreamEventBlock event={event} />);
    expect(document.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<b>bold</b> error');
  });
});

// ─── activity-marker ────────────────────────────────────────────────────────

describe('StreamEventBlock — activity-marker', () => {
  it('renders activity summary text', () => {
    const event = createEvent({
      kind: 'activity-marker',
      payload: { summary: 'Claude started analysis' },
    });

    render(<StreamEventBlock event={event} />);
    expect(screen.getByText('Claude started analysis')).toBeTruthy();
  });
});

// ─── artifact-notice ────────────────────────────────────────────────────────

describe('StreamEventBlock — artifact-notice', () => {
  it('renders artifact label', () => {
    const event = createEvent({
      kind: 'artifact-notice',
      payload: { label: 'src/index.ts', artifactKind: 'file' },
    });

    render(<StreamEventBlock event={event} />);
    expect(screen.getByText('src/index.ts')).toBeTruthy();
  });
});

// ─── unknown/fallback ───────────────────────────────────────────────────────

describe('StreamEventBlock — unknown kinds', () => {
  it('renders gracefully for an unrecognized event kind', () => {
    const event = createEvent({
      kind: 'checkpoint' as StreamEventKind,
      payload: { note: 'snapshot saved' },
    });

    render(<StreamEventBlock event={event} />);
    expect(screen.getByText('checkpoint')).toBeTruthy();
  });

  it('renders cancellation event', () => {
    const event = createEvent({
      kind: 'cancellation',
      payload: { reason: 'User cancelled' },
    });

    render(<StreamEventBlock event={event} />);
    expect(screen.getByText('cancellation')).toBeTruthy();
  });
});

// ─── structural / safety properties ─────────────────────────────────────────

describe('StreamEventBlock — structural', () => {
  it('renders as an article element', () => {
    const event = createEvent({ kind: 'text-delta', payload: { text: 'hi' } });

    const { container } = render(<StreamEventBlock event={event} />);
    expect(container.querySelector('article')).toBeTruthy();
  });

  it('includes the event kind as a data attribute', () => {
    const event = createEvent({ kind: 'warning', payload: { message: 'test' } });

    const { container } = render(<StreamEventBlock event={event} />);
    const article = container.querySelector('article');
    expect(article?.getAttribute('data-event-kind')).toBe('warning');
  });

  it('includes the sequence number as a data attribute', () => {
    const event = createEvent({ seq: 42, kind: 'text-delta', payload: { text: 'x' } });

    const { container } = render(<StreamEventBlock event={event} />);
    const article = container.querySelector('article');
    expect(article?.getAttribute('data-seq')).toBe('42');
  });
});

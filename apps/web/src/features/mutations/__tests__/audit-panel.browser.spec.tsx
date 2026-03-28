/**
 * T038 — AuditPanel browser specs.
 *
 * Covers:
 * - First page (20 records) rendered; Load more button enabled
 * - Clicking Load more appends second page (5 records), button disabled after
 * - Empty state: "No mutations recorded yet." shown
 * - Each rendered row includes actor, timestamp, event-type, before/after, outcome
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';

import type { MutationAuditRecord } from '@hydra/web-contracts';
import type { MutationsClient } from '../api/mutations-client.ts';
import { AuditPanel } from '../components/audit-panel.tsx';

afterEach(() => {
  cleanup();
});

function makeRecord(index: number): MutationAuditRecord {
  return {
    id: `record-${String(index)}`,
    timestamp: `2026-03-${String(index % 28 === 0 ? 1 : (index % 28) + 1).padStart(2, '0')}T12:00:00.000Z`,
    eventType: 'config.routing.mode.changed',
    operatorId: `operator-${String(index)}`,
    sessionId: `session-${String(index)}`,
    targetField: 'routing.mode',
    beforeValue: 'auto',
    afterValue: 'economy',
    outcome: 'success',
    rejectionReason: null,
    sourceIp: '127.0.0.1',
  };
}

function makeFailedRecord(index: number): MutationAuditRecord {
  return {
    ...makeRecord(index),
    id: `failed-${String(index)}`,
    outcome: 'failure',
    rejectionReason: 'Stale revision',
  };
}

function makeMockClient(overrides: Partial<MutationsClient> = {}): MutationsClient {
  return {
    getSafeConfig: vi.fn(),
    postRoutingMode: vi.fn(),
    postModelTier: vi.fn(),
    postBudget: vi.fn(),
    postWorkflowLaunch: vi.fn(),
    getAudit: vi.fn(),
    ...overrides,
  };
}

describe('AuditPanel', () => {
  it('renders first page of 20 records; Load more button enabled', async () => {
    const firstPageRecords = Array.from({ length: 20 }, (_, i) => makeRecord(i + 1));
    const getAudit = vi.fn().mockResolvedValue({
      records: firstPageRecords,
      nextCursor: 'cursor-page-2',
      totalCount: null,
    });
    const client = makeMockClient({ getAudit });

    await act(async () => {
      render(<AuditPanel client={client} />);
    });

    // 20 actor cells visible
    for (let i = 1; i <= 20; i++) {
      expect(screen.getByText(`operator-${String(i)}`)).toBeDefined();
    }

    const loadMoreBtn = screen.getByLabelText('Load more audit records');
    expect(loadMoreBtn.hasAttribute('disabled')).toBe(false);
  });

  it('clicking Load more appends second page; button disabled after (nextCursor null)', async () => {
    const firstPageRecords = Array.from({ length: 20 }, (_, i) => makeRecord(i + 1));
    const secondPageRecords = Array.from({ length: 5 }, (_, i) => makeRecord(i + 21));

    const getAudit = vi
      .fn()
      .mockResolvedValueOnce({
        records: firstPageRecords,
        nextCursor: 'cursor-page-2',
        totalCount: null,
      })
      .mockResolvedValueOnce({
        records: secondPageRecords,
        nextCursor: null,
        totalCount: null,
      });
    const client = makeMockClient({ getAudit });

    await act(async () => {
      render(<AuditPanel client={client} />);
    });

    const loadMoreBtn = screen.getByLabelText('Load more audit records');
    await act(async () => {
      fireEvent.click(loadMoreBtn);
    });

    // All 25 actor cells visible
    for (let i = 1; i <= 25; i++) {
      expect(screen.getByText(`operator-${String(i)}`)).toBeDefined();
    }

    expect(screen.getByLabelText('Load more audit records').hasAttribute('disabled')).toBe(true);
  });

  it('empty records mock: "No mutations recorded yet." shown', async () => {
    const getAudit = vi.fn().mockResolvedValue({
      records: [],
      nextCursor: null,
      totalCount: 0,
    });
    const client = makeMockClient({ getAudit });

    await act(async () => {
      render(<AuditPanel client={client} />);
    });

    expect(screen.getByText('No mutations recorded yet.')).toBeDefined();
  });

  it('each rendered row includes actor, timestamp, event-type, before/after values, outcome badge', async () => {
    const record = makeRecord(42);
    const getAudit = vi.fn().mockResolvedValue({
      records: [record],
      nextCursor: null,
      totalCount: 1,
    });
    const client = makeMockClient({ getAudit });

    await act(async () => {
      render(<AuditPanel client={client} />);
    });

    // actor
    expect(screen.getByText('operator-42')).toBeDefined();
    // event-type
    expect(screen.getByLabelText('event-type')).toBeDefined();
    // before/after
    expect(screen.getByText('auto')).toBeDefined();
    expect(screen.getByText('economy')).toBeDefined();
    // outcome badge
    expect(screen.getByLabelText('outcome-badge')).toBeDefined();
    expect(screen.getByText('success')).toBeDefined();
  });

  it('failure row renders rejectionReason text', async () => {
    const record = makeFailedRecord(99);
    const getAudit = vi.fn().mockResolvedValue({
      records: [record],
      nextCursor: null,
      totalCount: 1,
    });
    const client = makeMockClient({ getAudit });

    await act(async () => {
      render(<AuditPanel client={client} />);
    });

    expect(screen.getByText('Stale revision')).toBeDefined();
  });
});

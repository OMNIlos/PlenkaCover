import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchFinanceReconciliation,
  resolveFinancePaymentAllocation,
  syncOneCPayments,
} from '../../api/financeOneC';
import { OneCReconciliationPanel } from './OneCReconciliationPanel';

vi.mock('../../api/financeOneC', () => ({
  fetchFinanceReconciliation: vi.fn(),
  resolveFinancePaymentAllocation: vi.fn(),
  syncOneCPayments: vi.fn(),
}));

const reconciliationMock = vi.mocked(fetchFinanceReconciliation);
const resolveMock = vi.mocked(resolveFinancePaymentAllocation);
const syncMock = vi.mocked(syncOneCPayments);

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

function receipt() {
  return {
    id: 'receipt-1',
    externalId: 'payment-ref-1',
    sourceVersion: 'payment-v1',
    number: 'ПП-1',
    receivedAt: '2026-08-02T09:00:00.000Z',
    amount: '1200.00',
    allocatedAmount: '0.00',
    remainingAmount: '1200.00',
    currency: 'RUB',
    posted: true,
    deleted: false,
    sourceStatus: 'fresh',
    matchState: 'proposal',
    matchKind: 'invoice_number_proposal',
    candidateFinanceOrderIds: ['finance-1'],
    capturedAt: '2026-08-02T09:00:00.000Z',
    allocations: [],
  };
}

describe('OneCReconciliationPanel', () => {
  beforeEach(() => {
    reconciliationMock.mockReset().mockResolvedValue([receipt()]);
    resolveMock.mockReset().mockResolvedValue([{ id: 'allocation-1' }]);
    syncMock.mockReset().mockResolvedValue({
      imported: 1,
      matched: 0,
      autoApplied: 0,
      proposals: 1,
      ambiguous: 0,
      unmatched: 0,
      reversed: 0,
      skipped: 0,
      replayed: false,
    });
  });

  it('loads unresolved receipts and starts a fresh 1C bank statement import', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<OneCReconciliationPanel />);
      await Promise.resolve();
    });

    expect(nodeText(renderer.root)).toContain('ПП-1');
    const syncButton = renderer.root
      .findAllByType('button')
      .find((button) => nodeText(button) === 'Получить поступления из 1С');
    await act(async () => syncButton?.props.onClick());

    expect(syncMock).toHaveBeenCalledOnce();
    expect(reconciliationMock).toHaveBeenCalledTimes(2);
    expect(nodeText(renderer.root)).toContain('Импортировано: 1');
  });

  it('requires a reason and resolves a proposal against the selected finance order', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<OneCReconciliationPanel />);
      await Promise.resolve();
    });
    const inputs = renderer.root.findAllByType('input');
    const reason = renderer.root.findByType('textarea');

    act(() => inputs[0].props.onChange({ currentTarget: { value: 'finance-1' } }));
    act(() => inputs[1].props.onChange({ currentTarget: { value: '1200' } }));
    act(() =>
      reason.props.onChange({
        currentTarget: { value: 'Сверено по банковской выписке' },
      }),
    );
    const resolveButton = renderer.root
      .findAllByType('button')
      .find((button) => nodeText(button) === 'Связать поступление');
    await act(async () => resolveButton?.props.onClick());

    expect(resolveMock).toHaveBeenCalledWith(
      'receipt-1',
      expect.objectContaining({
        reason: 'Сверено по банковской выписке',
        allocations: [{ financeOrderId: 'finance-1', amount: 1200 }],
      }),
    );
  });
});

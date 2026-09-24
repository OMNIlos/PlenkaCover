import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { warehouseCoverageApi } from '../../api/warehouse';
import type {
  WarehouseCoverageRecheckItem,
  WarehouseCoverageView,
} from '../../domain/warehouseCoverage';
import { WarehouseCoverageRecheckPanel } from './WarehouseCoverageRecheckPanel';

const result: WarehouseCoverageView = {
  workflowVersion: 2,
  state: 'awaiting_finance',
  stateVersion: 6,
  generation: 4,
  availability: 'verified_full',
  reasonCodes: ['full_cover_available'],
  nextOwner: 'finance',
  availableActions: ['use_warehouse', 'produce_all', 'request_recheck'],
  requiredRollCount: 1,
  matchedRollCount: 1,
  uncertainRollCount: 0,
  calculatedAt: '2026-07-24T10:05:00.000Z',
  stale: false,
};

function recheckItem(
  overrides: Partial<WarehouseCoverageRecheckItem> = {},
): WarehouseCoverageRecheckItem {
  return {
    caseId: 'case-real-id',
    coverageOrigin: 'finance_request',
    caseVersion: 2,
    stateVersion: 5,
    generation: 3,
    reasonCodes: ['roll_ownership_unverified'],
    members: [
      {
        membershipId: 'membership-real-id',
        rollCode: 'ROLL-001',
        sourceKind: 'uncertain_candidate',
        reasonCodes: ['roll_ownership_unverified'],
        currentFactVersion: 4,
        ownerVerified: false,
        currentSpec: {
          filmType: 'пленка полиэтиленовая',
          actualThickness: '80 мкм',
          accountingThickness: '80 мкм',
          widthMm: 1000,
          plannedLengthM: 100,
          birka: 'полотно',
          spoolType: '76 мм',
          actualWeightKg: '275',
          plannedWeightKg: '275',
          recipeId: null,
          recipeVersion: null,
          recipeDefinitionId: null,
          recipeDefinitionVersionId: null,
          recipeVersionNumber: null,
          ingredients: [
            {
              rawMaterialDefinitionId: 'raw-material-real-id',
              shareBasisPoints: 10_000,
            },
          ],
        },
      },
    ],
    ...overrides,
  };
}

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

function inputByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  const labelNode = root
    .findAllByType('label')
    .find((candidate) => nodeText(candidate).includes(label));
  if (!labelNode) throw new Error(`Label not found: ${label}`);
  return labelNode.findByType('input');
}

function textareaByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  const labelNode = root
    .findAllByType('label')
    .find((candidate) => nodeText(candidate).includes(label));
  if (!labelNode) throw new Error(`Label not found: ${label}`);
  return labelNode.findByType('textarea');
}

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  const result = root.findAllByType('button').find((candidate) => nodeText(candidate) === label);
  if (!result) throw new Error(`Button not found: ${label}`);
  return result;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('WarehouseCoverageRecheckPanel', () => {
  it.each([
    ['Ширина, мм', ''],
    ['Ширина, мм', '0'],
    ['Ширина, мм', '-1'],
    ['Ширина, мм', '100000.001'],
    ['Ширина, мм', '1.0001'],
    ['Метраж, м', ''],
    ['Метраж, м', '10000000.001'],
    ['Метраж, м', 'Infinity'],
  ])('rejects invalid correction dimension %s=%s', (label, value) => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <WarehouseCoverageRecheckPanel item={recheckItem()} onResolved={vi.fn()} />,
      );
    });
    act(() => {
      inputByLabel(renderer.root, label).props.onChange({ currentTarget: { value } });
      textareaByLabel(renderer.root, 'Причина исправления').props.onChange({
        currentTarget: { value: 'Проверено по этикетке' },
      });
    });
    expect(button(renderer.root, 'Подтвердить перепроверку').props.disabled).toBe(true);
    act(() => renderer.unmount());
  });

  it('preserves dimensions when correcting other characteristics and accepts dimension bounds', async () => {
    const resolveSpy = vi.spyOn(warehouseCoverageApi, 'resolve').mockResolvedValue(result);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <WarehouseCoverageRecheckPanel item={recheckItem()} onResolved={vi.fn()} />,
      );
    });
    act(() => {
      inputByLabel(renderer.root, 'Бирка').props.onChange({ currentTarget: { value: 'ГОСТ' } });
      textareaByLabel(renderer.root, 'Причина исправления').props.onChange({
        currentTarget: { value: 'Проверено по этикетке' },
      });
    });
    await act(async () => {
      button(renderer.root, 'Подтвердить перепроверку').props.onClick();
    });
    expect(resolveSpy).toHaveBeenCalledWith(
      'case-real-id',
      expect.objectContaining({
        corrections: [
          expect.objectContaining({
            spec: expect.objectContaining({ widthMm: 1000, plannedLengthM: 100 }),
          }),
        ],
      }),
    );
    act(() => renderer.unmount());
    act(() => {
      renderer = TestRenderer.create(
        <WarehouseCoverageRecheckPanel item={recheckItem()} onResolved={vi.fn()} />,
      );
    });
    act(() => {
      inputByLabel(renderer.root, 'Ширина, мм').props.onChange({
        currentTarget: { value: '0,001' },
      });
    });
    act(() => {
      inputByLabel(renderer.root, 'Метраж, м').props.onChange({
        currentTarget: { value: '10000000' },
      });
      textareaByLabel(renderer.root, 'Причина исправления').props.onChange({
        currentTarget: { value: 'Проверено по этикетке' },
      });
    });
    expect(button(renderer.root, 'Подтвердить перепроверку').props.disabled).toBe(false);
    await act(async () => {
      button(renderer.root, 'Подтвердить перепроверку').props.onClick();
    });
    expect(resolveSpy).toHaveBeenLastCalledWith(
      'case-real-id',
      expect.objectContaining({
        corrections: [
          expect.objectContaining({
            spec: expect.objectContaining({ widthMm: 0.001, plannedLengthM: 10000000 }),
          }),
        ],
      }),
    );
    act(() => renderer.unmount());
    resolveSpy.mockRestore();
  });

  it('shows membership-scoped V2 recovery without warehouse route choices', () => {
    const renderer = TestRenderer.create(
      <WarehouseCoverageRecheckPanel item={recheckItem()} onResolved={vi.fn()} />,
    );
    const text = nodeText(renderer.root);

    expect(text).toContain('Перепроверка покрытия');
    expect(text).toContain('ROLL-001');
    expect(text).toContain('Владелец рулона не подтверждён');
    expect(text).not.toMatch(/Предложить покрытие|Подтвердить покрытие/u);
    expect(text).not.toMatch(/Использовать склад|Произвести весь заказ/u);
    expect(
      renderer.root.findAllByProps({ 'data-membership-id': 'membership-real-id' }),
    ).toHaveLength(1);
  });

  it('sends exact case/member concurrency fields and resolves only after confirmation', async () => {
    const response = deferred<WarehouseCoverageView>();
    const resolveSpy = vi
      .spyOn(warehouseCoverageApi, 'resolve')
      .mockReturnValueOnce(response.promise);
    const onResolved = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <WarehouseCoverageRecheckPanel item={recheckItem()} onResolved={onResolved} />,
      );
    });

    act(() => {
      inputByLabel(renderer.root, 'ID владельца').props.onChange({
        currentTarget: { value: 'owner-real-id' },
      });
      textareaByLabel(renderer.root, 'Причина исправления').props.onChange({
        currentTarget: { value: '  Проверено по этикетке и контрольному весу  ' },
      });
    });
    act(() => button(renderer.root, 'Подтвердить перепроверку').props.onClick());

    expect(resolveSpy).toHaveBeenCalledWith(
      'case-real-id',
      expect.objectContaining({
        expectedCaseVersion: 2,
        expectedGeneration: 3,
        expectedStateVersion: 5,
        reason: 'Проверено по этикетке и контрольному весу',
        corrections: [
          {
            membershipId: 'membership-real-id',
            expectedFactVersion: 4,
            ownerCounterpartyId: 'owner-real-id',
          },
        ],
      }),
    );
    expect(onResolved).not.toHaveBeenCalled();
    expect(nodeText(renderer.root)).toContain('Сохраняем перепроверку');

    await act(async () => {
      response.resolve(result);
      await response.promise;
    });

    expect(onResolved).toHaveBeenCalledWith('case-real-id', result);
    resolveSpy.mockRestore();
  });

  it('can confirm a physical recheck without inventing a fact correction', async () => {
    const resolveSpy = vi.spyOn(warehouseCoverageApi, 'resolve').mockResolvedValueOnce(result);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <WarehouseCoverageRecheckPanel item={recheckItem()} onResolved={vi.fn()} />,
      );
    });

    act(() => {
      textareaByLabel(renderer.root, 'Причина исправления').props.onChange({
        currentTarget: { value: 'Факты совпали с этикеткой и контрольным весом' },
      });
    });
    act(() => {
      button(renderer.root, 'Подтвердить перепроверку').props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(resolveSpy).toHaveBeenCalledWith(
      'case-real-id',
      expect.objectContaining({ corrections: [] }),
    );
    resolveSpy.mockRestore();
  });
});

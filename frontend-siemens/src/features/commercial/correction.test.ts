import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyCommercialMaterialShortageCorrection,
  applyCommercialProblemCorrection,
} from './api';
import {
  buildProblemCorrectionCommand,
  CommercialCorrectionPanel,
} from './CommercialCorrectionPanel';
import { CommercialMaterialShortageCorrectionPanel } from './CommercialMaterialShortageCorrectionPanel';
import type { CommercialProductionProblemContract } from './contracts';

const problem: CommercialProductionProblemContract = {
  id: 'problem-1',
  type: 'general',
  status: 'open',
  reason: 'Клиент изменил толщину',
  recovery: 'Остановить текущий рулон и уточнить рецептуру',
  positionId: 'position-1',
  reportedRollId: 'A-1-roll-2',
  currentRollSequence: 2,
  completedRolls: 1,
  totalRolls: 4,
  ownerRole: 'commercial',
  currentRecipe: {
    snapshotId: 'recipe-1',
    version: 'v2',
    parameters: [
      { label: 'Толщина', value: '80' },
      { label: 'Ширина', value: '500' },
    ],
  },
  candidateRolls: [
    {
      rollId: 'roll-2',
      rollCode: 'A-1-roll-2',
      positionSequence: 2,
      status: 'blocked',
      eligible: true,
    },
    {
      rollId: 'roll-3',
      rollCode: 'A-1-roll-3',
      positionSequence: 3,
      status: 'assigned',
      eligible: true,
    },
    {
      rollId: 'roll-4',
      rollCode: 'A-1-roll-4',
      positionSequence: 4,
      status: 'done',
      eligible: false,
    },
  ],
  createdAt: '2026-07-14T09:00:00.000Z',
};

const shortageProblem: CommercialProductionProblemContract = {
  ...problem,
  id: 'problem-shortage',
  type: 'raw_material_shortage',
  reason: 'ПВД закончился',
  recovery: 'Коммерция применяет корректировку сырья',
};

afterEach(() => vi.unstubAllGlobals());

describe('commercial governed correction', () => {
  it('shows progress, old/new recipe values and only safe correction controls', () => {
    const markup = renderToStaticMarkup(
      createElement(CommercialCorrectionPanel, {
        problems: [problem],
        status: 'idle',
        error: null,
        onSubmit: vi.fn(),
        onRetry: vi.fn(),
      }),
    );

    expect(markup).toContain('class="commercial-problem-impact"');
    expect(markup).toContain('Влияет на производство этой позиции');
    expect(markup).not.toContain('position-1');
    expect(markup).toContain('Решение коммерции');
    expect(markup).toContain('Готово');
    expect(markup).toContain('1 из 4 рул.');
    expect(markup).toContain('Сейчас');
    expect(markup).toContain('Новая версия');
    expect(markup).toContain('Толщина');
    expect(markup).toContain('Применить с рулона');
    expect(markup).toContain('2 · A-1-roll-2');
    expect(markup).toContain('3 · A-1-roll-3');
    expect(markup).not.toContain('4 · A-1-roll-4');
    expect(markup).toContain('Текущий рулон');
    expect(markup).toContain('Остановить и применить новую версию');
    expect(markup).toContain('Текущий рулон закончить по старой версии');
    expect(markup).not.toMatch(/Назначить станок|machine assignment|Смена оператора/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Применить корректировку/);
  });

  it('does not render a resolved or non-commercial problem as actionable', () => {
    const markup = renderToStaticMarkup(
      createElement(CommercialCorrectionPanel, {
        problems: [{ ...problem, status: 'resolved' }],
        status: 'idle',
        error: null,
        onSubmit: vi.fn(),
        onRetry: vi.fn(),
      }),
    );

    expect(markup).toBe('');
  });

  it('keeps raw-material shortage out of the generic correction panel', () => {
    const markup = renderToStaticMarkup(
      createElement(CommercialCorrectionPanel, {
        problems: [shortageProblem],
        selectedProblemId: shortageProblem.id,
        status: 'idle',
        error: null,
        onSubmit: vi.fn(),
        onRetry: vi.fn(),
      }),
    );

    expect(markup).toBe('');
  });

  it('builds the dedicated shortage command from the exact rich problem and loaded catalog', async () => {
    const onSubmit = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        createElement(CommercialMaterialShortageCorrectionPanel, {
          problems: [
            { ...shortageProblem, id: 'problem-other', reason: 'Другой дефицит' },
            shortageProblem,
          ],
          selectedProblemId: shortageProblem.id,
          materials: [{ id: 'raw-new', name: 'ПВД 158', kind: 'base' }],
          status: 'idle',
          error: null,
          onSubmit,
          onRetry: vi.fn(),
        }),
      );
    });

    expect(renderer.root.findAllByProps({ children: 'Другой дефицит' })).toHaveLength(0);
    await act(async () => {
      renderer.root.findByProps({ 'aria-label': 'Причина замены сырья' }).props.onChange({
        target: { value: 'Переходим на согласованный ПВД' },
      });
    });
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((candidate) => candidate.children.join('') === 'Применить замену сырья')
        ?.props.onClick();
    });

    expect(onSubmit).toHaveBeenCalledWith({
      problemId: 'problem-shortage',
      fromRollId: 'A-1-roll-2',
      newRawMaterialId: 'raw-new',
      newParameters: problem.currentRecipe.parameters,
      reason: 'Переходим на согласованный ПВД',
    });
  });

  it('requires reason and a valid applies-from boundary in the command builder', () => {
    expect(() =>
      buildProblemCorrectionCommand(problem, {
        reason: '   ',
        fromRollId: 'A-1-roll-2',
        currentRollResolution: 'stop_and_apply_new',
        newParameters: problem.currentRecipe.parameters,
      }),
    ).toThrow('Укажите причину изменения');
    expect(() =>
      buildProblemCorrectionCommand(problem, {
        reason: 'Текущий рулон завершаем по старой версии',
        fromRollId: 'A-1-roll-2',
        currentRollResolution: 'finish_old_version',
        newParameters: problem.currentRecipe.parameters,
      }),
    ).toThrow('выберите следующий рулон');
  });

  it('builds an explicit versioned command without workplace controls', () => {
    const command = buildProblemCorrectionCommand(problem, {
      reason: '  Клиент подтвердил 90 мкм ',
      fromRollId: 'A-1-roll-3',
      currentRollResolution: 'finish_old_version',
      newParameters: [
        { label: 'Толщина', value: '90' },
        { label: 'Ширина', value: '500' },
      ],
    });

    expect(command).toEqual({
      positionId: 'position-1',
      fromRollId: 'A-1-roll-3',
      expectedRecipeVersion: 'v2',
      currentRollResolution: 'finish_old_version',
      newParameters: [
        { label: 'Толщина', value: '90' },
        { label: 'Ширина', value: '500' },
      ],
      reason: 'Клиент подтвердил 90 мкм',
    });
    expect(command).not.toHaveProperty('machineId');
    expect(command).not.toHaveProperty('operatorId');
  });

  it('posts the problem-scoped command without synthetic ids', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ caseId: 'case-1', problemId: 'problem-1', status: 'resolved' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const command = buildProblemCorrectionCommand(problem, {
      reason: 'Клиент подтвердил 90 мкм',
      fromRollId: 'A-1-roll-2',
      currentRollResolution: 'stop_and_apply_new',
      newParameters: [{ label: 'Толщина', value: '90' }],
    });

    await applyCommercialProblemCorrection('order-1', problem.id, command);

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/commercial/orders/order-1/problems/problem-1/correction');
    expect(JSON.parse(init.body as string)).toEqual(command);
  });

  it('posts the dedicated shortage command to the authoritative endpoint unchanged', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        caseId: 'case-shortage',
        problemId: 'problem-shortage',
        status: 'resolved',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const command = {
      problemId: 'problem-shortage',
      fromRollId: 'A-1-roll-2',
      newRawMaterialId: 'raw-new',
      newParameters: [{ label: 'Толщина', value: '90' }],
      reason: 'Переходим на согласованный ПВД',
    };

    await applyCommercialMaterialShortageCorrection('order / 1', command);

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/commercial/orders/order%20%2F%201/material-shortage-corrections');
    expect(JSON.parse(init.body as string)).toEqual(command);
  });
});

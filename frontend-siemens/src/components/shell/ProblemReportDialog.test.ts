import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { ProblemReportContext, ProblemReportPayload } from '../../domain/types';
import {
  executeProblemReportSubmission,
  ProblemReportDialog,
  type ProblemReportSubmissionLock,
} from './ProblemReportDialog';

const payload = { objectId: 'finance-order-1' } as ProblemReportPayload;

function textContent(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textContent(child)))
    .join('');
}

describe('problem report submission', () => {
  it('coalesces rapid submits per dialog and unlocks after completion', async () => {
    let resolve!: () => void;
    const submit = vi
      .fn()
      .mockImplementationOnce(
        () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
      )
      .mockResolvedValue(undefined);
    const lock: ProblemReportSubmissionLock = { current: null };

    const first = executeProblemReportSubmission(payload, submit, lock);
    const second = executeProblemReportSubmission(payload, submit, lock);

    expect(second).toBe(first);
    expect(submit).toHaveBeenCalledTimes(1);
    resolve();
    await first;

    await executeProblemReportSubmission(payload, submit, lock);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('keeps submissions from separate dialogs independent', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);

    await Promise.all([
      executeProblemReportSubmission(payload, submit, { current: null }),
      executeProblemReportSubmission(payload, submit, { current: null }),
    ]);

    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('lets an operator choose only a general problem or raw-material shortage', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const context = {
      role: 'operator',
      actionId: 'operator-problem',
      objectId: 'order-1',
      objectTitle: 'Заказ A-1',
      objectStatus: 'В работе',
      actorLabel: 'Оператор',
      title: 'Проблема по текущему рулону',
      stage: 'В работе',
      recovery: 'Зав. производства решает следующий шаг',
      auditEvent: 'problem:operator_reported',
      notificationTitle: 'Проблема оператора',
      notificationBody: 'Оператор сообщил о проблеме.',
      lockedTarget: true,
      readOnlyFacts: [],
      draft: {
        type: 'production_change',
        operatorProblemType: 'general',
        entityKind: 'roll',
        entityId: 'roll-1',
        ownerRole: 'Зав. производства',
        due: 'до следующего шага',
        severity: 'warning',
        reason: 'Заканчивается сырьё',
        createLinkedDuplicate: false,
      },
    } as ProblemReportContext;

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(ProblemReportDialog, { context, onCancel: vi.fn(), onSubmit }),
      );
    });

    const typeSelect = renderer.root.findByType('select');
    expect(typeSelect.props.disabled).toBe(false);
    expect(
      typeSelect.findAllByType('option').map((option) => [option.props.value, option.children[0]]),
    ).toEqual([
      ['general', 'Общая проблема'],
      ['raw_material_shortage', 'Нехватка сырья'],
    ]);
    expect(textContent(renderer.root)).toContain('Цель зафиксирована: Зав. производства');
    expect(textContent(renderer.root)).toContain('Зав. производства решает следующий шаг');

    await act(async () => {
      typeSelect.props.onChange({ target: { value: 'raw_material_shortage' } });
    });
    expect(textContent(renderer.root)).toContain('Цель зафиксирована: Коммерция');
    expect(textContent(renderer.root)).toContain('Коммерция применяет корректировку сырья');
    expect(textContent(renderer.root)).not.toContain('Зав. производства решает следующий шаг');

    await act(async () => {
      typeSelect.props.onChange({ target: { value: 'general' } });
    });
    expect(textContent(renderer.root)).toContain('Цель зафиксирована: Зав. производства');
    expect(textContent(renderer.root)).toContain('Зав. производства решает следующий шаг');
    expect(textContent(renderer.root)).not.toContain('Коммерция применяет корректировку сырья');

    await act(async () => {
      typeSelect.props.onChange({ target: { value: 'raw_material_shortage' } });
    });
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Отправить проблему'))
        ?.props.onClick();
    });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ operatorProblemType: 'raw_material_shortage' }),
    );
  });
});

import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { financeWorkObjects } from '../../domain/fixtures/finance';
import type { Fact, FinancePaymentCorrectionTarget, WorkObject } from '../../domain/types';
import { ApiResponseParseError } from '../../api/client';
import { IdempotentOperationGate } from '../../api/idempotentOperation';
import {
  FinancePaymentCorrectionReplayGuard,
  financePaymentCorrectionIntent,
} from '../../api/financePaymentCorrectionReplay';
import { FinanceWorkbench } from './FinanceWorkbench';

function FactList({ facts }: { facts: Fact[] }) {
  return <div>{facts.map((fact) => `${fact.label}: ${fact.value}`).join(' · ')}</div>;
}

function button(root: ReactTestInstance, label: string) {
  return root.findAllByType('button').find((candidate) => candidate.children.join('') === label);
}

function financeObject(): WorkObject {
  return {
    ...financeWorkObjects[0],
    financePaymentStatus: 'paid',
    correctablePayments: [
      {
        target: { kind: 'schedule_confirmation', id: 'schedule-1' },
        label: 'Подтверждение первого этапа',
        amount: '500.00',
        source: 'manual_platform',
        canCorrect: true,
        blockedReason: null,
      },
      {
        target: { kind: 'payment_operation', id: 'onec-operation' },
        label: 'Платёжная операция 1С',
        amount: '200.00',
        source: '1C',
        canCorrect: false,
        blockedReason: 'Исправьте платёж в 1С',
      },
    ],
  };
}

describe('FinanceWorkbench payment correction', () => {
  it('offers correction only for an addressable platform fact and explains the accounting flow', () => {
    const markup = renderToStaticMarkup(
      <FinanceWorkbench
        object={financeObject()}
        factValue={(item, label) => item.facts.find((fact) => fact.label === label)?.value}
        FactList={FactList}
        onCorrectPayment={vi.fn()}
      />,
    );

    expect(markup.match(/Отменить подтверждение/g)).toHaveLength(1);
    expect(markup).toContain('Отмените проведение в учётной системе и обновите источник');
    expect(markup).not.toMatch(/1[СC]/u);
  });

  it('passes the exact server target and reason to the app orchestrator', async () => {
    const onCorrectPayment = vi.fn().mockResolvedValue(true);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <FinanceWorkbench
          object={financeObject()}
          factValue={(item, label) => item.facts.find((fact) => fact.label === label)?.value}
          FactList={FactList}
          onCorrectPayment={onCorrectPayment}
        />,
      );
    });

    act(() => button(renderer.root, 'Отменить подтверждение')?.props.onClick());
    act(() => {
      renderer.root.findByProps({ 'aria-label': 'Причина отмены подтверждения' }).props.onChange({
        currentTarget: { value: 'Дублирующее подтверждение' },
      });
      renderer.root
        .findByProps({ 'aria-label': 'Подтвердить корректировку оплаты' })
        .props.onChange({
          currentTarget: { checked: true },
        });
    });
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(onCorrectPayment).toHaveBeenCalledWith(
      { kind: 'schedule_confirmation', id: 'schedule-1' },
      'Дублирующее подтверждение',
    );
  });

  it('blocks an edited retry after an uncertain response and replays the exact command', async () => {
    const operationKey = '00000000-0000-4000-8000-000000000504';
    const gate = new IdempotentOperationGate(() => operationKey);
    const replay = new FinancePaymentCorrectionReplayGuard();
    const transport = vi
      .fn()
      .mockRejectedValueOnce(new ApiResponseParseError(201, new Error('malformed response')))
      .mockResolvedValueOnce(undefined);
    const onCorrectPayment = async (
      target: FinancePaymentCorrectionTarget,
      reason: string,
    ) => {
      let prepared;
      try {
        prepared = replay.prepare('finance-1', {
          target,
          expectedPaymentStatus: 'paid',
          reason,
        });
      } catch {
        return false;
      }
      let command;
      const request = gate.start(
        financePaymentCorrectionIntent('finance-1', prepared),
        (key) => {
          command = replay.command('finance-1', prepared, key);
          return transport(command);
        },
        'finance:payment-correction:finance-1',
      );
      if (!request || !command) return false;
      try {
        await request;
        replay.resolve('finance-1');
        return true;
      } catch (error) {
        replay.reject('finance-1', command, error);
        return false;
      }
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <FinanceWorkbench
          object={financeObject()}
          factValue={(item, label) => item.facts.find((fact) => fact.label === label)?.value}
          FactList={FactList}
          onCorrectPayment={onCorrectPayment}
        />,
      );
    });
    act(() => button(renderer.root, 'Отменить подтверждение')?.props.onClick());
    const reasonField = () =>
      renderer.root.findByProps({ 'aria-label': 'Причина отмены подтверждения' });
    act(() => {
      reasonField().props.onChange({ currentTarget: { value: 'Ошибочное подтверждение' } });
      renderer.root
        .findByProps({ 'aria-label': 'Подтвердить корректировку оплаты' })
        .props.onChange({ currentTarget: { checked: true } });
    });
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });

    act(() => {
      reasonField().props.onChange({ currentTarget: { value: 'Изменённая причина' } });
    });
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });
    expect(transport).toHaveBeenCalledTimes(1);

    act(() => {
      reasonField().props.onChange({ currentTarget: { value: 'Ошибочное подтверждение' } });
    });
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[0]?.[0]).toEqual(transport.mock.calls[1]?.[0]);
    expect(transport.mock.calls[1]?.[0]).toEqual({
      operationKey,
      target: { kind: 'schedule_confirmation', id: 'schedule-1' },
      expectedPaymentStatus: 'paid',
      reason: 'Ошибочное подтверждение',
    });
    expect(renderer.root.findAllByType('form')).toHaveLength(0);
  });
});

import { existsSync, readFileSync } from 'node:fs';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import { DefectDialog, restoreDialogFocus, submissionErrorMessage } from './DefectDialog';

const dialogUrl = new URL('./DefectDialog.tsx', import.meta.url);
const dialogSource = existsSync(dialogUrl) ? readFileSync(dialogUrl, 'utf8') : '';
const appSource = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
const operatorWorkbenchSource = readFileSync(
  new URL('./operatorWorkbench.tsx', import.meta.url),
  'utf8',
);
const operatorRollsHubSource = readFileSync(
  new URL('./OperatorRollsHubSurface.tsx', import.meta.url),
  'utf8',
);
describe('operator defect dialog contract', () => {
  it('provides a dedicated accessible dialog with roll and physical-weight truth', () => {
    expect(dialogSource).toContain('export function DefectDialog');
    expect(dialogSource).toContain('масса будет получена со стабильных весов');

    const markup = renderToStaticMarkup(
      <DefectDialog rollCode="A-9-roll-1" onCancel={vi.fn()} onSubmit={vi.fn()} />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('A-9-roll-1');
    expect(markup).toContain('масса будет получена со стабильных весов');
    expect(markup).toContain('Взвесить и зафиксировать брак');
    expect(markup).not.toContain('Причина брака');
    expect(markup).not.toContain('<textarea');
    expect(markup).not.toMatch(/name="weightKg"|ручной ввод массы/u);
  });

  it('intercepts the defect action before the immediate live physical action', () => {
    expect(appSource).toMatch(
      /if \(actionId === 'operator-defect'[\s\S]*?setOperatorDefectDialog[\s\S]*?if \(isOperatorLive && runOperatorLiveAction\(actionId\)\)/u,
    );
    expect(dialogSource).toContain('createPortal(dialog, document.body)');
    expect(dialogSource).toContain("document.querySelector<HTMLElement>('.app-shell')");
    expect(dialogSource).toContain("setAttribute('inert', '')");
    expect(dialogSource).toContain('returnFocusTarget?.focus()');
    expect(appSource).not.toContain(
      "document.querySelector<HTMLElement>('.defect-dialog textarea')?.focus()",
    );
    expect(appSource).not.toContain('Брак зафиксирован оператором на посту');
  });

  it('shows an actionable Russian network message without claiming that a comment was saved', () => {
    expect(dialogSource).toMatch(
      /error instanceof TypeError[\s\S]*?Нет связи с платформой[\s\S]*?шлюз/u,
    );
    expect(submissionErrorMessage(new ApiError(408, 'timeout'))).toContain(
      'Операция сохранена для безопасного повтора',
    );
    expect(submissionErrorMessage(new ApiError(503, 'unavailable'))).not.toContain('Комментарий');
    expect(
      submissionErrorMessage(new ApiError(409, 'still running', 'OPERATOR_OPERATION_IN_PROGRESS')),
    ).toContain('Операция сохранена для безопасного повтора');
    expect(
      submissionErrorMessage(
        new DOMException('The operation was aborted by the browser.', 'AbortError'),
      ),
    ).toBe('Запрос прерван до подтверждения результата. Повторите отправку.');
    expect(
      submissionErrorMessage(new Error('Secure UUID generation is unavailable in this browser.')),
    ).toBe(
      'Не удалось создать безопасный идентификатор операции. Обновите браузер или откройте платформу по HTTPS.',
    );
    expect(submissionErrorMessage(new Error('Internal adapter stack trace'))).toBe(
      'Действие не выполнено. Проверьте состояние оборудования и повторите.',
    );
    expect(submissionErrorMessage(new Error('Весы поста не вернули стабильное измерение.'))).toBe(
      'Масса ещё не стабилизировалась. Дождитесь стабильного сигнала и повторите.',
    );
  });

  it('uses the same safe Russian presentation for the operator toast and inline error', () => {
    expect(appSource).toContain('submissionErrorMessage(error)');
    expect(appSource).not.toContain('sourceMessage ||');
    expect(appSource).not.toContain("import { ApiError } from './api/client'");
  });

  it('restores focus to the surface heading when a resolved-row trigger was removed', () => {
    const trigger = { isConnected: false, focus: vi.fn() } as unknown as HTMLElement;
    const fallback = { isConnected: true, focus: vi.fn() } as unknown as HTMLElement;

    restoreDialogFocus(trigger, fallback);

    expect(trigger.focus).not.toHaveBeenCalled();
    expect(fallback.focus).toHaveBeenCalledOnce();
    expect(dialogSource).toContain(
      "document.querySelector<HTMLElement>('[data-dialog-focus-fallback]')",
    );
    expect(operatorRollsHubSource).toMatch(
      /<h2[^>]*tabIndex=\{-1\}[^>]*data-dialog-focus-fallback/u,
    );
    expect(operatorWorkbenchSource).not.toContain('data-dialog-focus-fallback');
  });

  it('prefers the stable operator heading even before the successful live refresh removes the trigger', () => {
    const trigger = { isConnected: true, focus: vi.fn() } as unknown as HTMLElement;
    const fallback = { isConnected: true, focus: vi.fn() } as unknown as HTMLElement;

    restoreDialogFocus(trigger, fallback, true);

    expect(trigger.focus).not.toHaveBeenCalled();
    expect(fallback.focus).toHaveBeenCalledOnce();
    expect(dialogSource).toMatch(
      /export function DefectDialog[\s\S]*?<ReasonDialog[\s\S]*?preferFocusFallback/u,
    );
    expect(dialogSource).toMatch(
      /export function DefectResolutionDialog[\s\S]*?<ReasonDialog[\s\S]*?preferFocusFallback/u,
    );
  });

  it('submits a stable defect without a reason and single-flights repeated clicks', async () => {
    let resolveSubmit!: () => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <DefectDialog
          rollCode="A-9-roll-1"
          spoolKg={0.05}
          initialReading={{
            deviceId: 'scale-a',
            kind: 'roll',
            status: 'ready',
            stable: true,
            grossKg: 0.06,
            at: '2026-07-27T09:00:00.000Z',
          }}
          onCancel={vi.fn()}
          onSubmit={onSubmit}
        />,
      );
    });
    const textareas = renderer.root.findAllByType('textarea');
    expect(textareas).toHaveLength(0);
    const findSubmit = () =>
      renderer.root
        .findAllByType('button')
        .find((candidate) => nodeText(candidate).includes('Взвесить и зафиксировать брак'));

    expect(findSubmit()?.props.disabled).toBe(false);

    await act(async () => {
      findSubmit()?.props.onClick();
      findSubmit()?.props.onClick();
      await Promise.resolve();
    });
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith();
    expect(nodeText(renderer.root)).toContain('Получаем массу с весов');

    await act(async () => {
      resolveSubmit();
      await Promise.resolve();
    });
  });

  it('closes on Escape only while no submission is pending', () => {
    const onCancel = vi.fn();
    const renderer = TestRenderer.create(
      <DefectDialog rollCode="A-9-roll-1" onCancel={onCancel} onSubmit={vi.fn()} />,
    );
    const dialogs = renderer.root.findAllByProps({ role: 'dialog' });
    expect(dialogs).toHaveLength(1);
    const preventDefault = vi.fn();

    act(() => dialogs[0].props.onKeyDown({ key: 'Escape', preventDefault }));

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('does not retain a hidden warehouse defect mutation path', () => {
    expect(appSource).not.toContain('warehouse.roll_damaged:');
    expect(appSource).not.toContain('брак передан зав. производства на решение');
    expect(appSource).not.toContain('уходит в переработку, зав. производства уведомлен');
  });
});

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

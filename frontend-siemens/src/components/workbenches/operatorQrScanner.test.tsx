import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { operatorWorkObjects } from '../../domain/fixtures/operator';
import { OperatorWorkbenchView, operatorQrScanAction } from './operatorWorkbench';

describe('operator physical QR scanner', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders an empty focused scanner field instead of the expected QR payload', () => {
    const object = operatorWorkObjects.find(
      (candidate) => candidate.workbench?.type === 'operator',
    );
    if (object?.workbench?.type !== 'operator') throw new Error('operator fixture is missing');

    const html = renderToStaticMarkup(
      <OperatorWorkbenchView
        workbench={object.workbench}
        actions={[
          {
            id: 'operator-verify-qr',
            label: 'Сканировать QR',
            level: 'recommended',
            enabled: true,
          },
        ]}
      />,
    );

    expect(html).toContain('aria-label="Сканирование QR оператора"');
    expect(html).toContain('placeholder="Считайте QR сканером"');
    expect(html).not.toContain('value="prt_');
  });

  it('passes the exact scanned payload through an encoded action', () => {
    const payload = `prt_${'a'.repeat(64)}`;
    expect(decodeURIComponent(operatorQrScanAction(payload).split(':')[1])).toBe(payload);
  });

  it('submits a scan while the previous stage is in its visual cooldown', () => {
    vi.stubGlobal('window', {
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(),
    });
    const object = operatorWorkObjects.find(
      (candidate) => candidate.workbench?.type === 'operator',
    );
    if (object?.workbench?.type !== 'operator') throw new Error('operator fixture is missing');
    const workbench = object.workbench;
    const onAction = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <OperatorWorkbenchView
          workbench={workbench}
          actions={[
            {
              id: 'operator-verify-qr',
              label: 'Сканировать QR',
              level: 'recommended',
              enabled: true,
            },
          ]}
          pendingActionId="operator-stage-cooldown"
          onAction={onAction}
        />,
      );
    });

    const scannerInput = renderer.root.findByProps({
      'aria-label': 'Сканирование QR оператора',
    });
    const payload = `prt_${'b'.repeat(64)}`;
    act(() => scannerInput.props.onChange({ target: { value: payload } }));
    const scannerForm = renderer.root.findByProps({
      'aria-label': 'Проверка QR рулона',
    });
    act(() => scannerForm.props.onSubmit({ preventDefault: vi.fn() }));

    expect(onAction).toHaveBeenCalledWith(operatorQrScanAction(payload));
  });

  it('reconstructs ASCII scanner input from physical keys under a Russian layout', () => {
    const object = operatorWorkObjects.find(
      (candidate) => candidate.workbench?.type === 'operator',
    );
    if (object?.workbench?.type !== 'operator') throw new Error('operator fixture is missing');
    const workbench = object.workbench;
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <OperatorWorkbenchView
          workbench={workbench}
          actions={[
            {
              id: 'operator-verify-qr',
              label: 'Сканировать QR',
              level: 'recommended',
              enabled: true,
            },
          ]}
        />,
      );
    });

    const scannerInput = renderer.root.findByProps({
      'aria-label': 'Сканирование QR оператора',
    });
    const preventDefault = vi.fn();
    for (const [code, key, shiftKey] of [
      ['KeyP', 'з', false],
      ['KeyR', 'к', false],
      ['KeyT', 'е', false],
      ['Minus', '_', true],
      ['Digit1', '1', false],
      ['KeyA', 'ф', false],
    ] as const) {
      act(() => {
        scannerInput.props.onKeyDown({
          code,
          key,
          shiftKey,
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          isComposing: false,
          preventDefault,
        });
      });
    }

    expect(
      renderer.root.findByProps({ 'aria-label': 'Сканирование QR оператора' }).props.value,
    ).toBe('prt_1a');
    expect(preventDefault).toHaveBeenCalledTimes(6);
  });
});

import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { OperatorOrderMass } from '../../api/operator';
import { OperatorOrderMassSummary } from './OperatorOrderMassSummary';

function mass(deviationKg: number): OperatorOrderMass {
  return {
    orderPlannedNetKg: 30,
    weighedPlannedNetKg: 10,
    actualNetKg: 10 + deviationKg,
    deviationKg,
    weighedRollCount: 1,
    totalRollCount: 2,
  };
}

async function render(value: OperatorOrderMass) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <OperatorOrderMassSummary
        orderNumber="ORD-1"
        refreshIntervalMs={0}
        loadMass={vi.fn().mockResolvedValue(value)}
      />,
    );
    await Promise.resolve();
  });
  return renderer;
}

describe('OperatorOrderMassSummary', () => {
  it.each([
    [1.25, 'Перевес', '+1,25 кг'],
    [-1.25, 'Недовес', '−1,25 кг'],
    [0, 'Отклонение', '0 кг'],
  ] as const)('renders signed deviation %s as %s', async (deviation, label, value) => {
    const renderer = await render(mass(deviation));
    const output = JSON.stringify(renderer.toJSON());

    expect(
      renderer.root.findByProps({ role: 'region', 'aria-label': 'Масса заказа' }),
    ).toBeDefined();
    expect(output).toContain('План заказа');
    expect(output).toContain('План взвешенных');
    expect(output).toContain('Факт');
    expect(output).toContain(label);
    expect(output).toContain(value);
    expect(renderer.root.findByType('small').children.join('')).toBe('1 из 2');
  });

  it('reserves its state row while loading and exposes a stable retry on failure', async () => {
    let reject!: (error: Error) => void;
    const loadMass = vi.fn().mockImplementation(
      () =>
        new Promise<OperatorOrderMass>((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <OperatorOrderMassSummary orderNumber="ORD-1" refreshIntervalMs={0} loadMass={loadMass} />,
      );
    });
    expect(renderer.root.findByProps({ 'aria-busy': true })).toBeDefined();
    expect(renderer.root.findByProps({ className: 'operator-order-mass-state' })).toBeDefined();
    expect(JSON.stringify(renderer.toJSON())).toContain('План взвешенных');

    await act(async () => {
      reject(new Error('offline'));
      await Promise.resolve();
    });
    expect(renderer.root.findByProps({ role: 'alert' })).toBeDefined();
    const retry = renderer.root
      .findAllByType('button')
      .find((button) => button.children.join('') === 'Повторить');
    expect(retry).toBeDefined();
  });

  it('keeps the visible error stable while a repeated retry is pending', async () => {
    let rejectFirst!: (error: Error) => void;
    const loadMass = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<OperatorOrderMass>((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockImplementationOnce(() => new Promise<OperatorOrderMass>(() => undefined));
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <OperatorOrderMassSummary orderNumber="ORD-1" refreshIntervalMs={0} loadMass={loadMass} />,
      );
    });
    await act(async () => {
      rejectFirst(new Error('offline'));
      await Promise.resolve();
    });

    const retry = renderer.root.findByType('button');
    act(() => retry.props.onClick());

    expect(renderer.root.findByProps({ role: 'alert' })).toBeDefined();
    expect(JSON.stringify(renderer.toJSON())).toContain('Не удалось обновить массу заказа.');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Рассчитываем массу заказа…');
    expect(retry.props.disabled).toBe(true);
  });

  it('does not abort and restart a slow request on every polling tick', async () => {
    vi.useFakeTimers();
    const loadMass = vi
      .fn()
      .mockImplementation(() => new Promise<OperatorOrderMass>(() => undefined));
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <OperatorOrderMassSummary
          orderNumber="ORD-1"
          refreshIntervalMs={100}
          loadMass={loadMass}
        />,
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });

    expect(loadMass).toHaveBeenCalledTimes(1);
    renderer.unmount();
    vi.useRealTimers();
  });

  it('updates in place for a new refresh key and ignores a superseded response', async () => {
    let resolveFirst!: (value: OperatorOrderMass) => void;
    const loadMass = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<OperatorOrderMass>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(mass(-2));
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <OperatorOrderMassSummary
          orderNumber="ORD-1"
          refreshKey="v1"
          refreshIntervalMs={0}
          loadMass={loadMass}
        />,
      );
    });
    await act(async () => {
      renderer.update(
        <OperatorOrderMassSummary
          orderNumber="ORD-1"
          refreshKey="v2"
          refreshIntervalMs={0}
          loadMass={loadMass}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      resolveFirst(mass(5));
      await Promise.resolve();
    });

    expect(JSON.stringify(renderer.toJSON())).toContain('−2 кг');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('+5 кг');
  });

  it('never shows the previous order aggregate while the next order is loading', async () => {
    const loadMass = vi
      .fn()
      .mockResolvedValueOnce(mass(5))
      .mockImplementationOnce(() => new Promise<OperatorOrderMass>(() => undefined));
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <OperatorOrderMassSummary orderNumber="ORD-1" refreshIntervalMs={0} loadMass={loadMass} />,
      );
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain('+5 кг');

    act(() => {
      renderer.update(
        <OperatorOrderMassSummary orderNumber="ORD-2" refreshIntervalMs={0} loadMass={loadMass} />,
      );
    });

    expect(JSON.stringify(renderer.toJSON())).not.toContain('+5 кг');
    expect(renderer.root.findByProps({ 'aria-busy': true })).toBeDefined();
  });
});

import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchOperatorPayroll, type ServerOperatorPayrollPreview } from '../../api/operatorPayroll';
import { OperatorPayrollSurface } from './OperatorPayrollSurface';

vi.mock('../../api/operatorPayroll', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/operatorPayroll')>();
  return { ...actual, fetchOperatorPayroll: vi.fn() };
});

const fetchPayrollMock = vi.mocked(fetchOperatorPayroll);

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const button = root.findAllByType('button').find((candidate) => nodeText(candidate) === label);
  if (!button) throw new Error(`Button not found: ${label}`);
  return button;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function previewWithAmount(
  payableAmountKopecks: number,
  range: Partial<ServerOperatorPayrollPreview['range']> = {},
): ServerOperatorPayrollPreview {
  return {
    ...preview,
    range: { ...preview.range, ...range },
    summary: { ...preview.summary, payableAmountKopecks },
  };
}

async function flushRequests(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const preview: ServerOperatorPayrollPreview = {
  status: 'partial',
  appliedTariffOrders: [{
    id: 'payroll-tariff-order-8-09-25-2025-09-29',
    name: 'Приказ № 8-09/25',
    effectiveFrom: '2025-09-29',
    currency: 'RUB',
  }],
  range: {
    fromDate: '2026-08-01',
    toDate: '2026-08-31',
    timezone: 'Europe/Moscow',
    generatedAt: '2026-08-06T00:00:00.000Z',
  },
  summary: {
    payableAmountKopecks: 45_000,
    payableKg: 100,
    machineShiftCount: 1,
    unresolvedKg: 12,
    unresolvedFactCount: 1,
    excludedDefectKg: 5,
    excludedDefectRollCount: 1,
  },
  breakdown: [
    {
      id: 'self-payroll:shift-1',
      tariffOrderId: 'payroll-tariff-order-8-09-25-2025-09-29',
      shiftId: 'shift-1',
      shiftLabel: 'Смена 1',
      shiftDate: '2026-08-04',
      postId: 'post-1',
      postCode: 'URP',
      postName: 'УРП',
      machineFamily: 'urp',
      shiftDuration: '24h',
      shiftOutputKg: 1_800,
      payableKg: 100,
      rateKopecksPerKg: 450,
      amountKopecks: 45_000,
      tariffRule: 'primary',
      basisLabel: 'УРП · первичка',
      materialClass: 'primary',
      filmClass: null,
      specialCustomer: false,
    },
  ],
  unresolved: [
    {
      rollId: 'roll-2',
      rollCode: 'ORD-2/1',
      orderId: 'order-2',
      orderNumber: 'ORD-2',
      producedAt: '2026-08-05T08:00:00.000Z',
      netKg: 12,
      shiftId: 'shift-open',
      shiftLabel: 'Смена 2',
      postId: 'post-1',
      postCode: 'URP',
      postName: 'УРП',
      reasons: ['shift_not_closed'],
    },
  ],
};

async function renderSurface() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<OperatorPayrollSurface />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

describe('OperatorPayrollSurface', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-06T00:00:00.000Z'));
    fetchPayrollMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows only the authenticated operator totals and an auditable shift breakdown', async () => {
    fetchPayrollMock.mockImplementation(async ({ from, to }) => {
      const payableAmountKopecks =
        from === '2026-08-06' && to === '2026-08-06'
          ? 12_345
          : from === '2026-07-24' && to === '2026-08-06'
            ? 67_890
            : preview.summary.payableAmountKopecks;
      return {
        ...preview,
        range: { ...preview.range, fromDate: from, toDate: to },
        summary: { ...preview.summary, payableAmountKopecks },
      };
    });

    const renderer = await renderSurface();
    const text = nodeText(renderer.root);

    expect(fetchPayrollMock).toHaveBeenCalledWith(
      { from: '2026-08-01', to: '2026-08-06' },
      expect.objectContaining({ signal: expect.any(Object) }),
    );
    expect(fetchPayrollMock).toHaveBeenCalledWith({ from: '2026-08-06', to: '2026-08-06' });
    expect(fetchPayrollMock).toHaveBeenCalledWith({ from: '2026-07-24', to: '2026-08-06' });
    expect(text).toContain('Моя зарплата');
    expect(text).toContain('Сегодня');
    expect(text).toContain('123,45 ₽');
    expect(text).toContain('За 14 дней');
    expect(text).toContain('678,90 ₽');
    expect(text).toContain('450,00 ₽');
    expect(text).toContain('100 кг');
    expect(text).toContain('4,50 ₽/кг');
    expect(text).toContain('УРП · первичка');
    expect(text).toContain('ORD-2/1');
    expect(text).toContain('Смена ещё не закрыта');
    expect(text).not.toContain('Другие операторы');
    expect(text).not.toContain('operatorId');
    expect(text).not.toContain('Заполните обязательное поле');
  });

  it('keeps a concise retry action when the projection is temporarily unavailable', async () => {
    fetchPayrollMock.mockRejectedValue(new Error('offline'));

    const renderer = await renderSurface();
    const text = nodeText(renderer.root);

    expect(text).toContain('Расчёт сейчас недоступен');
    expect(text).toContain('Повторить');
    expect(text).not.toContain('Ошибка 500');
  });

  it('shows loading before the first payroll preview exists', () => {
    fetchPayrollMock.mockReturnValue(new Promise(() => undefined));
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<OperatorPayrollSurface />);
    });

    expect(nodeText(renderer.root)).toContain('Загружаем начисления');
    expect(
      renderer.root.findAllByProps({ 'data-testid': 'operator-payroll-content' }),
    ).toHaveLength(0);
  });

  it('keeps payroll controls concise and exposes one active preset in a labelled group', async () => {
    fetchPayrollMock.mockResolvedValue(preview);

    const renderer = await renderSurface();
    const text = nodeText(renderer.root);
    const presets = renderer.root.findByProps({
      role: 'group',
      'aria-label': 'Период расчёта',
    });
    const presetButtons = presets.findAllByType('button');

    expect(text).not.toContain('По закрытым сменам');
    expect(text).not.toContain('Предварительно · до проведения в 1С');
    expect(presetButtons).toHaveLength(3);
    expect(presetButtons.map((button) => button.props['aria-pressed'])).toEqual([
      true,
      false,
      false,
    ]);

    await act(async () => {
      findButton(renderer.root, 'Эта неделя').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(presetButtons.map((button) => button.props['aria-pressed'])).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('omits payroll footnotes when neither defect nor unresolved count is positive', async () => {
    fetchPayrollMock.mockResolvedValue({
      ...preview,
      summary: {
        ...preview.summary,
        excludedDefectKg: 0,
        excludedDefectRollCount: 0,
        unresolvedKg: 0,
        unresolvedFactCount: 0,
      },
      unresolved: [],
    });

    const renderer = await renderSurface();

    expect(
      renderer.root.findAllByProps({ className: 'operator-payroll-footnote' }),
    ).toHaveLength(0);
  });

  it('shows each payroll footnote only when its related count is positive', async () => {
    fetchPayrollMock.mockResolvedValue({
      ...preview,
      summary: {
        ...preview.summary,
        excludedDefectKg: 0,
        excludedDefectRollCount: 0,
      },
    });

    const withoutDefects = await renderSurface();
    expect(nodeText(withoutDefects.root)).not.toContain('Брак не начисляется');
    expect(nodeText(withoutDefects.root)).toContain('Не рассчитано: 12 кг');

    fetchPayrollMock.mockResolvedValue({
      ...preview,
      summary: {
        ...preview.summary,
        unresolvedKg: 0,
        unresolvedFactCount: 0,
      },
      unresolved: [],
    });

    const withoutUnresolved = await renderSurface();
    expect(nodeText(withoutUnresolved.root)).toContain('Брак не начисляется: 5 кг');
    expect(nodeText(withoutUnresolved.root)).not.toContain('Не рассчитано');
  });

  it('does not refetch the fixed headline periods when only the detail range changes', async () => {
    fetchPayrollMock.mockResolvedValue(preview);
    const renderer = await renderSurface();
    fetchPayrollMock.mockClear();

    await act(async () => {
      renderer.root.findByProps({ id: 'operator-payroll-from' }).props.onChange({
        currentTarget: { value: '2026-08-02' },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchPayrollMock).toHaveBeenCalledTimes(1);
    expect(fetchPayrollMock).toHaveBeenCalledWith(
      { from: '2026-08-02', to: '2026-08-06' },
      expect.objectContaining({ signal: expect.any(Object) }),
    );
  });

  it('aborts an obsolete detail request when the operator changes the period', async () => {
    const pendingDetail = new Promise<ServerOperatorPayrollPreview>(() => undefined);
    fetchPayrollMock.mockImplementation(({ from, to }) => {
      if (
        (from === '2026-08-01' && to === '2026-08-06') ||
        (from === '2026-08-02' && to === '2026-08-06')
      ) {
        return pendingDetail;
      }
      return Promise.resolve(previewWithAmount(0, { fromDate: from, toDate: to }));
    });

    const renderer = await renderSurface();
    type PayrollCall = [
      { from: string; to: string },
      { signal?: AbortSignal } | undefined,
    ];
    const calls = () => fetchPayrollMock.mock.calls as unknown as PayrollCall[];
    const obsoleteCall = calls().find(
      ([query]) => query.from === '2026-08-01' && query.to === '2026-08-06',
    );
    const obsoleteSignal = obsoleteCall?.[1]?.signal;

    expect(obsoleteSignal).toBeDefined();
    expect(obsoleteSignal?.aborted).toBe(false);

    act(() => {
      renderer.root.findByProps({ id: 'operator-payroll-from' }).props.onChange({
        currentTarget: { value: '2026-08-02' },
      });
    });
    await flushRequests();

    const currentCall = calls().find(
      ([query]) => query.from === '2026-08-02' && query.to === '2026-08-06',
    );
    expect(obsoleteSignal?.aborted).toBe(true);
    expect(currentCall?.[1]?.signal).toBeDefined();
    expect(currentCall?.[1]?.signal?.aborted).toBe(false);

    act(() => renderer.unmount());
    expect(currentCall?.[1]?.signal?.aborted).toBe(true);
  });

  it('refreshes the daily and fortnight totals after the Moscow date changes', async () => {
    vi.setSystemTime(new Date('2026-08-06T20:59:30.000Z'));
    fetchPayrollMock.mockResolvedValue(preview);
    await renderSurface();
    fetchPayrollMock.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchPayrollMock).toHaveBeenCalledWith({ from: '2026-08-07', to: '2026-08-07' });
    expect(fetchPayrollMock).toHaveBeenCalledWith({ from: '2026-07-25', to: '2026-08-07' });
  });

  it('keeps the last payroll preview mounted while the newest period replaces it', async () => {
    const olderPeriod = deferred<ServerOperatorPayrollPreview>();
    const newestPeriod = deferred<ServerOperatorPayrollPreview>();
    fetchPayrollMock.mockImplementation(({ from, to }) => {
      if (from === '2026-08-01' && to === '2026-08-06') {
        return Promise.resolve(previewWithAmount(1_245_000, { fromDate: from, toDate: to }));
      }
      if (from === '2026-07-01' && to === '2026-07-31') return olderPeriod.promise;
      if (from === '2026-08-03' && to === '2026-08-06') return newestPeriod.promise;
      return Promise.resolve(previewWithAmount(0, { fromDate: from, toDate: to }));
    });

    const renderer = await renderSurface();
    expect(nodeText(renderer.root)).toContain('12 450,00 ₽');

    act(() => findButton(renderer.root, 'Прошлый месяц').props.onClick());
    await flushRequests();

    expect(nodeText(renderer.root)).toContain('12 450,00 ₽');
    expect(
      renderer.root.findByProps({ 'data-testid': 'operator-payroll-content' }).props['aria-busy'],
    ).toBe(true);

    act(() => findButton(renderer.root, 'Эта неделя').props.onClick());
    await flushRequests();
    newestPeriod.resolve(
      previewWithAmount(987_650, { fromDate: '2026-08-03', toDate: '2026-08-06' }),
    );
    await flushRequests();

    expect(nodeText(renderer.root)).toContain('9 876,50 ₽');
    expect(nodeText(renderer.root)).not.toContain('12 450,00 ₽');
    expect(
      renderer.root.findByProps({ 'data-testid': 'operator-payroll-content' }).props['aria-busy'],
    ).toBe(false);

    olderPeriod.resolve(
      previewWithAmount(777_000, { fromDate: '2026-07-01', toDate: '2026-07-31' }),
    );
    await flushRequests();

    expect(nodeText(renderer.root)).toContain('9 876,50 ₽');
    expect(nodeText(renderer.root)).not.toContain('7 770,00 ₽');
  });

  it('keeps the last good preview and offers retry when a refresh fails', async () => {
    fetchPayrollMock.mockImplementation(({ from, to }) => {
      if (from === '2026-08-01' && to === '2026-08-06') {
        return Promise.resolve(previewWithAmount(1_245_000, { fromDate: from, toDate: to }));
      }
      if (from === '2026-07-01' && to === '2026-07-31') return Promise.reject(new Error('offline'));
      return Promise.resolve(previewWithAmount(0, { fromDate: from, toDate: to }));
    });

    const renderer = await renderSurface();
    act(() => findButton(renderer.root, 'Прошлый месяц').props.onClick());
    await flushRequests();

    expect(nodeText(renderer.root)).toContain('12 450,00 ₽');
    expect(nodeText(renderer.root)).toContain('Расчёт сейчас недоступен');
    expect(nodeText(renderer.root)).toContain('Повторить');
    expect(
      renderer.root.findByProps({ 'data-testid': 'operator-payroll-content' }).props['aria-busy'],
    ).toBe(false);
  });
});

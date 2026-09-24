import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchDirectorPayrollPreview,
  type ServerDirectorPayrollPreview,
  type ServerDirectorPayrollUnresolvedReason,
} from '../../api/directorPayroll';
import { demoDirectorPayrollPreview } from '../../domain/fixtures/directorPayroll';
import { DirectorPayrollSurface } from './DirectorPayrollSurface';

vi.mock('../../api/directorPayroll', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/directorPayroll')>();
  return { ...actual, fetchDirectorPayrollPreview: vi.fn() };
});

const fetchPayrollMock = vi.mocked(fetchDirectorPayrollPreview);

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

function payrollPreview(
  overrides: Partial<ServerDirectorPayrollPreview> = {},
): ServerDirectorPayrollPreview {
  return {
    ...demoDirectorPayrollPreview,
    ...overrides,
    appliedTariffOrders:
      overrides.appliedTariffOrders ?? demoDirectorPayrollPreview.appliedTariffOrders,
    range: { ...demoDirectorPayrollPreview.range, ...overrides.range },
    summary: { ...demoDirectorPayrollPreview.summary, ...overrides.summary },
  };
}

async function flushRequests(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderLiveSurface() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<DirectorPayrollSurface useLiveData />);
    await Promise.resolve();
  });
  await flushRequests();
  return renderer;
}

describe('DirectorPayrollSurface', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T21:30:00.000Z'));
    fetchPayrollMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('labels the explicit demo preview as preliminary and source-bound', () => {
    const markup = renderToStaticMarkup(<DirectorPayrollSurface useLiveData={false} />);

    expect(markup).toContain('Предварительный сдельный расчёт');
    expect(markup).toContain('Демонстрационный расчёт');
    expect(markup).toContain('Демонстрационный расчёт · предварительно');
    expect(markup).not.toMatch(/1[СC]/u);
    expect(markup).toContain('Приказ № 8-09/25');
    expect(markup).toContain('Рулоны без рассчитанного начисления');
    expect(markup).toContain('Без начисления');
    expect(markup).not.toContain('Требует классификации');
    expect(markup).not.toContain('Требуют классификации');
    expect(markup).not.toContain('Не классифицировано');
    expect(markup).not.toContain('УРП · УРП');
    expect(markup).toContain('<dt>Начислено</dt>');
    expect(markup).toContain('<dt>Учтено, кг</dt>');
    expect(markup).toContain('<dt>Операторов</dt>');
    expect(markup).toContain('Исключённый брак');
    expect(markup).toContain('Тарифы по приказу № 8-09/25');
    expect(markup).toContain('фальц');
    expect(markup).not.toMatch(/ч[её]рно-бел/u);
  });

  it('uses operator names as the shift disclosure without redundant breakdown copy', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<DirectorPayrollSurface useLiveData={false} />);
    });

    const disclosures = renderer.root
      .findAllByType('details')
      .filter((details) => details.props.className === 'director-payroll-breakdown');

    expect(disclosures).toHaveLength(2);
    expect(disclosures.map((details) => nodeText(details.findByType('summary')))).toEqual([
      'Анна (демо)',
      'Борис (демо)',
    ]);
    expect(nodeText(renderer.root)).not.toContain('Разбивка');
  });

  it('uses an explicit keyboard disclosure with a chevron, hint and applied-order titles', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<DirectorPayrollSurface useLiveData={false} />);
    });

    const disclosure = renderer.root.findByProps({
      'aria-label': 'Показать тарифы по применённым приказам',
    });
    expect(disclosure.type).toBe('button');
    expect(disclosure.props['aria-expanded']).toBe(false);
    expect(nodeText(disclosure)).toContain('Тарифы по приказу № 8-09/25');
    expect(nodeText(disclosure)).toContain('Нажмите, чтобы посмотреть тарифы');
    expect(disclosure.findByType('ix-icon').props.name).toContain('chevron');

    act(() => disclosure.props.onClick());
    expect(
      renderer.root.findByProps({ 'aria-label': 'Показать тарифы по применённым приказам' }).props[
        'aria-expanded'
      ],
    ).toBe(true);
    expect(renderer.root.findAllByProps({ 'data-payroll-tariff-order': true })).toHaveLength(1);
    expect(nodeText(renderer.root)).toContain('Приказ № 8-09/25');
  });

  it('offers the visible primary action for creating a tariff order', () => {
    const renderer = TestRenderer.create(<DirectorPayrollSurface useLiveData={false} />);
    const button = findButton(renderer.root, 'Создать новый приказ по тарифам');

    expect(button.props.type).toBe('button');
    expect(button.props.className).toContain('primary');
  });

  it('explains that the fourth summary fact counts rolls without payroll accrual', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<DirectorPayrollSurface useLiveData={false} />);
    });

    const summary = renderer.root.findByProps({ className: 'director-payroll-summary' });
    const labels = summary.findAllByType('dt').map(nodeText);

    expect(labels).toEqual([
      'Начислено',
      'Учтено, кг',
      'Операторов',
      'Рулоны без рассчитанного начисления',
    ]);
  });

  it('starts live mode with loading and no demo values', () => {
    const markup = renderToStaticMarkup(<DirectorPayrollSurface useLiveData />);

    expect(markup).toContain('Загрузка расчёта зарплаты');
    expect(markup).not.toContain('Демонстрационный расчёт');
    expect(markup).not.toContain('Анна (демо)');
    expect(markup).not.toContain('11 000,00');
  });

  it('requests the current Moscow month and renders server operator order', async () => {
    fetchPayrollMock.mockResolvedValue(
      payrollPreview({
        operators: [
          {
            operatorId: 'operator-z',
            operatorName: 'Зоя Серверная',
            payableKg: 100,
            amountKopecks: 45_000,
            machineShiftCount: 1,
            unresolvedFactCount: 0,
          },
          {
            operatorId: 'operator-a',
            operatorName: 'Алексей Серверный',
            payableKg: 90,
            amountKopecks: 40_500,
            machineShiftCount: 1,
            unresolvedFactCount: 0,
          },
        ],
        breakdown: [],
        unresolved: [],
      }),
    );

    const renderer = await renderLiveSurface();
    const text = nodeText(renderer.root);

    expect(fetchPayrollMock).toHaveBeenCalledWith(
      {
        from: '2026-08-01',
        to: '2026-08-01',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(text.indexOf('Зоя Серверная')).toBeLessThan(text.indexOf('Алексей Серверный'));
    expect(text).not.toContain('Демонстрационный расчёт');
  });

  it('refreshes on the shared generation without hiding the previous figures', async () => {
    const refreshed = deferred<ServerDirectorPayrollPreview>();
    fetchPayrollMock
      .mockResolvedValueOnce(
        payrollPreview({
          summary: {
            ...demoDirectorPayrollPreview.summary,
            payableAmountKopecks: 1_125_000,
          },
        }),
      )
      .mockReturnValueOnce(refreshed.promise);

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <DirectorPayrollSurface useLiveData refreshGeneration={1} />,
      );
      await Promise.resolve();
    });
    await flushRequests();
    expect(nodeText(renderer.root)).toContain('11 250,00 ₽');

    act(() => {
      renderer.update(<DirectorPayrollSurface useLiveData refreshGeneration={2} />);
    });
    await flushRequests();

    expect(fetchPayrollMock).toHaveBeenCalledTimes(2);
    expect(nodeText(renderer.root)).toContain('11 250,00 ₽');
    expect(nodeText(renderer.root)).not.toContain('Загрузка расчёта зарплаты');

    refreshed.resolve(payrollPreview());
    await flushRequests();
    renderer.unmount();
  });

  it('keeps the previous figures when a shared refresh of the same period fails', async () => {
    fetchPayrollMock
      .mockResolvedValueOnce(
        payrollPreview({
          summary: {
            ...demoDirectorPayrollPreview.summary,
            payableAmountKopecks: 1_125_000,
          },
        }),
      )
      .mockRejectedValueOnce(new Error('network'));

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <DirectorPayrollSurface useLiveData refreshGeneration={1} />,
      );
      await Promise.resolve();
    });
    await flushRequests();

    act(() => {
      renderer.update(<DirectorPayrollSurface useLiveData refreshGeneration={2} />);
    });
    await flushRequests();

    expect(nodeText(renderer.root)).toContain('11 250,00 ₽');
    expect(nodeText(renderer.root)).toContain('Не удалось загрузить расчёт зарплаты');
    renderer.unmount();
  });

  it('fails closed, clears the preview, and retries the live request', async () => {
    fetchPayrollMock
      .mockResolvedValueOnce(
        payrollPreview({
          operators: [
            {
              operatorId: 'server-operator',
              operatorName: 'Серверный оператор',
              payableKg: 100,
              amountKopecks: 45_000,
              machineShiftCount: 1,
              unresolvedFactCount: 0,
            },
          ],
          breakdown: [],
          unresolved: [],
        }),
      )
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(payrollPreview({ operators: [], breakdown: [], unresolved: [] }));

    const renderer = await renderLiveSurface();
    expect(nodeText(renderer.root)).toContain('Серверный оператор');

    await act(async () => {
      findButton(renderer.root, 'Предыдущий месяц').props.onClick();
      await Promise.resolve();
    });
    await flushRequests();

    expect(nodeText(renderer.root)).toContain('Не удалось загрузить расчёт зарплаты');
    expect(nodeText(renderer.root)).toContain('Повторить');
    expect(nodeText(renderer.root)).not.toContain('Серверный оператор');
    expect(nodeText(renderer.root)).not.toContain('Демонстрационный расчёт');

    await act(async () => {
      findButton(renderer.root, 'Повторить').props.onClick();
      await Promise.resolve();
    });
    await flushRequests();

    expect(fetchPayrollMock).toHaveBeenCalledTimes(3);
    expect(nodeText(renderer.root)).not.toContain('Не удалось загрузить расчёт зарплаты');
  });

  it('ignores an older result after the period changes', async () => {
    const first = deferred<ServerDirectorPayrollPreview>();
    const second = deferred<ServerDirectorPayrollPreview>();
    fetchPayrollMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const renderer = await renderLiveSurface();
    const firstSignal = fetchPayrollMock.mock.calls[0]?.[1]?.signal;
    act(() => findButton(renderer.root, 'Предыдущий месяц').props.onClick());
    await flushRequests();

    expect(firstSignal?.aborted).toBe(true);

    second.resolve(
      payrollPreview({
        operators: [
          {
            operatorId: 'newer',
            operatorName: 'Новый период',
            payableKg: 100,
            amountKopecks: 45_000,
            machineShiftCount: 1,
            unresolvedFactCount: 0,
          },
        ],
        breakdown: [],
        unresolved: [],
      }),
    );
    await flushRequests();
    first.resolve(
      payrollPreview({
        operators: [
          {
            operatorId: 'older',
            operatorName: 'Устаревший период',
            payableKg: 100,
            amountKopecks: 45_000,
            machineShiftCount: 1,
            unresolvedFactCount: 0,
          },
        ],
        breakdown: [],
        unresolved: [],
      }),
    );
    await flushRequests();

    expect(nodeText(renderer.root)).toContain('Новый период');
    expect(nodeText(renderer.root)).not.toContain('Устаревший период');
  });

  it('ignores an older rejection after a newer request succeeds', async () => {
    const first = deferred<ServerDirectorPayrollPreview>();
    const second = deferred<ServerDirectorPayrollPreview>();
    fetchPayrollMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const renderer = await renderLiveSurface();
    act(() => findButton(renderer.root, 'Текущая неделя').props.onClick());
    await flushRequests();

    second.resolve(payrollPreview());
    await flushRequests();
    first.reject(new Error('stale failure'));
    await flushRequests();

    expect(nodeText(renderer.root)).not.toContain('Не удалось загрузить расчёт зарплаты');
    expect(nodeText(renderer.root)).toContain('Анна (демо)');
    expect(nodeText(renderer.root)).not.toContain('Демонстрационный расчёт');
  });

  it('does not request incomplete or invalid custom dates', async () => {
    fetchPayrollMock.mockReturnValue(new Promise(() => undefined));
    const renderer = await renderLiveSurface();
    expect(fetchPayrollMock).toHaveBeenCalledTimes(1);

    act(() => findButton(renderer.root, 'Свой период').props.onClick());
    await flushRequests();
    expect(nodeText(renderer.root)).toContain('Укажите обе даты периода');
    expect(fetchPayrollMock).toHaveBeenCalledTimes(1);

    const fromInput = renderer.root.findByProps({ id: 'director-payroll-from' });
    const toInput = renderer.root.findByProps({ id: 'director-payroll-to' });
    act(() => fromInput.props.onChange({ currentTarget: { value: '2026-08-02' } }));
    await flushRequests();
    expect(fetchPayrollMock).toHaveBeenCalledTimes(1);

    act(() => toInput.props.onChange({ currentTarget: { value: '2026-08-01' } }));
    await flushRequests();
    expect(nodeText(renderer.root)).toContain('Дата начала должна быть не позже даты окончания');
    expect(fetchPayrollMock).toHaveBeenCalledTimes(1);

    act(() => toInput.props.onChange({ currentTarget: { value: '2026-08-03' } }));
    await flushRequests();
    expect(fetchPayrollMock).toHaveBeenLastCalledWith(
      {
        from: '2026-08-02',
        to: '2026-08-03',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('renders an explicit empty state for a zero server preview', async () => {
    fetchPayrollMock.mockResolvedValue(
      payrollPreview({
        status: 'complete',
        summary: {
          payableAmountKopecks: 0,
          payableKg: 0,
          machineShiftCount: 0,
          operatorCount: 0,
          unresolvedKg: 0,
          unresolvedFactCount: 0,
          excludedDefectKg: 0,
          excludedDefectRollCount: 0,
        },
        operators: [],
        breakdown: [],
        unresolved: [],
      }),
    );

    const renderer = await renderLiveSurface();

    expect(nodeText(renderer.root)).toContain('Нет завершённой выработки за период');
    expect(nodeText(renderer.root)).not.toContain('Не удалось загрузить расчёт зарплаты');
  });

  it('retains zero totals, defect evidence, source, and tariffs for a defect-only empty period', async () => {
    fetchPayrollMock.mockResolvedValue(
      payrollPreview({
        status: 'empty',
        summary: {
          payableAmountKopecks: 0,
          payableKg: 0,
          machineShiftCount: 0,
          operatorCount: 0,
          unresolvedKg: 0,
          unresolvedFactCount: 0,
          excludedDefectKg: 12.75,
          excludedDefectRollCount: 2,
        },
        operators: [],
        breakdown: [],
        unresolved: [],
      }),
    );

    const renderer = await renderLiveSurface();
    const text = nodeText(renderer.root);
    const summary = renderer.root.findByProps({ className: 'director-payroll-summary' });

    expect(text).toContain('Нет завершённой выработки за период');
    expect(summary.findAllByType('dd').map(nodeText)).toEqual(['0,00 ₽', '0 кг', '0', '0']);
    expect(text).toContain('Исключённый брак');
    expect(text).toContain('12,75 кг · 2 рул.');
    expect(text).toContain('Приказ № 8-09/25');
    expect(text).toContain('Тарифы по приказу № 8-09/25');
    expect(renderer.root.findAllByProps({ className: 'director-payroll-table' })).toHaveLength(0);
  });

  it('renders canonical Матиль once in a machine cell and in tariff group headings', async () => {
    fetchPayrollMock.mockResolvedValue(
      payrollPreview({
        breakdown: [
          {
            ...demoDirectorPayrollPreview.breakdown[0],
            postName: 'Матиль',
            machineFamily: 'matil',
          },
        ],
        unresolved: [],
      }),
    );

    const renderer = await renderLiveSurface();
    const machineCell = renderer.root
      .findAll((node) => node.props['data-label'] === 'Станок')
      .find((node) => nodeText(node).includes('Матиль'));
    const tariffHeadings = renderer.root.findAllByType('h4').map(nodeText);

    expect(machineCell && nodeText(machineCell)).toBe('Матиль');
    expect(tariffHeadings).toContain('УРП, Матиль, Китайка · 12 ч');
    expect(nodeText(renderer.root)).not.toContain('Матиль · Матил');
  });

  it('presents server values, breakdown, unresolved reasons, exclusions, and every tariff rule', async () => {
    const allReasons: ServerDirectorPayrollUnresolvedReason[] = [
      'before_policy_effective_date',
      'shift_not_closed',
      'production_operator_unresolved',
      'post_session_unresolved',
      'shift_unresolved',
      'machine_family_unresolved',
      'shift_duration_unresolved',
      'material_class_unresolved',
      'film_type_unresolved',
      'counterparty_unresolved',
    ];
    const response = payrollPreview({
      unresolved: [
        {
          ...demoDirectorPayrollPreview.unresolved[0],
          reasons: allReasons,
        },
      ],
    });
    fetchPayrollMock.mockResolvedValue(response);

    const renderer = await renderLiveSurface();
    const markup = renderer.toJSON();
    const text = nodeText(renderer.root);
    const dataLabels = renderer.root
      .findAll((node) => typeof node.props['data-label'] === 'string')
      .map((node) => node.props['data-label']);

    expect(text).toContain('11 000,00 ₽');
    expect(text).toContain('2 300 кг');
    expect(text).toContain('Смена целиком');
    expect(text).toContain('К начислению оператору');
    expect(text).toContain('Ставка');
    expect(text).toContain('Основание');
    expect(text).toContain('До вступления приказа в силу');
    expect(text).toContain('Смена не закрыта');
    expect(text).toContain('Оператор не определён');
    expect(text).toContain('Сессия поста не определена');
    expect(text).toContain('Смена не определена');
    expect(text).toContain('Семейство станка не определено');
    expect(text).toContain('Длительность смены не определена');
    expect(text).toContain('Сырьё не определено как первичное или вторичное');
    expect(text).toContain('Тип плёнки не определён');
    expect(text).toContain('Контрагент не определён');
    expect(text).toContain('Исключённый брак');
    expect(text).toContain('12,5 кг');
    expect(text).toContain('Тарифы по приказу № 8-09/25');
    expect(text).toContain('УРП, Матиль, Китайка · 12 ч');
    expect(text).toContain('АВС старая, АВС новая · 24 ч');
    expect(text).toContain('Тонкий рулон');
    expect(text).toContain('ОЭЗ ППТ АЛАБУГА АО');
    expect(dataLabels).toEqual(
      expect.arrayContaining([
        'Оператор',
        'К начислению',
        'Рулон',
        'Заказ',
        'Причина',
        'Смена',
        'Станок',
      ]),
    );
    expect(JSON.stringify(markup)).not.toMatch(/rawPayload|sourcePayload|parsedPayload/u);
  });
});

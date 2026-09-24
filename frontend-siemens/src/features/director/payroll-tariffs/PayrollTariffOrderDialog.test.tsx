import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { ServerPayrollTariffOrderList } from '../../../api/payrollTariffOrders';
import type { PayrollTariffOrderEditor } from './payrollTariffOrderModel';
import { PayrollTariffOrderDialog } from './PayrollTariffOrderDialog';
import type { PayrollTariffOrdersController } from './usePayrollTariffOrders';

function editor(status: PayrollTariffOrderEditor['status'] = 'draft'): PayrollTariffOrderEditor {
  return {
    orderId: '11111111-1111-4111-8111-111111111111',
    status,
    revision: 2,
    name: 'Приказ № 9-08/26',
    effectiveFrom: '2026-08-15',
    matrix: {
      schemaVersion: 1,
      ladders: {
        urp12h: [{ maxInclusiveGrams: null, primaryRateKopecksPerKg: 400, secondaryRateKopecksPerKg: 500 }],
        urp24h: [{ maxInclusiveGrams: null, primaryRateKopecksPerKg: 400, secondaryRateKopecksPerKg: 500 }],
        abc12h: [{ maxInclusiveGrams: null, standardRateKopecksPerKg: 450, blackWhiteRateKopecksPerKg: 500 }],
        abc24h: [{ maxInclusiveGrams: null, standardRateKopecksPerKg: 450, blackWhiteRateKopecksPerKg: 500 }],
      },
      specialRules: {
        thinRoll: { enabled: true, maxExclusiveGrams: 7_000, rateKopecksPerKg: 650 },
        alabuga: {
          enabled: true,
          machineFamily: 'abc_new',
          normalizedLegalName: 'ОЭЗ ППТ АЛАБУГА АО',
          rateKopecksPerKg: 400,
        },
      },
    },
    review: null,
  };
}

const list: ServerPayrollTariffOrderList = {
  items: [
    {
      id: 'payroll-tariff-order-8-09-25-2025-09-29',
      name: 'Приказ № 8-09/25',
      effectiveFrom: '2025-09-29',
      currency: 'RUB',
      status: 'published',
      revision: 1,
      createdAt: '2025-09-29T00:00:00.000Z',
      updatedAt: '2025-09-29T00:00:00.000Z',
      publishedAt: '2025-09-29T00:00:00.000Z',
    },
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Приказ № 9-08/26',
      effectiveFrom: '2026-08-15',
      currency: 'RUB',
      status: 'draft',
      revision: 2,
      createdAt: '2026-08-13T08:00:00.000Z',
      updatedAt: '2026-08-13T08:30:00.000Z',
      publishedAt: null,
    },
  ],
  activeOrderId: 'payroll-tariff-order-8-09-25-2025-09-29',
  latestPublishedOrderId: 'payroll-tariff-order-8-09-25-2025-09-29',
  minimumPublishEffectiveFrom: '2026-08-14',
  timezone: 'Europe/Moscow',
  generatedAt: '2026-08-13T09:30:00.000Z',
};

function controller(
  overrides: Partial<PayrollTariffOrdersController['state']> = {},
): PayrollTariffOrdersController {
  return {
    state: {
      isOpen: true,
      listStatus: 'ready',
      detailStatus: 'ready',
      mutationStatus: 'idle',
      list,
      selectedOrderId: '11111111-1111-4111-8111-111111111111',
      editor: editor(),
      error: null,
      fieldErrors: [],
      conflict: null,
      lastMutationReplayed: false,
      ...overrides,
    },
    openCreate: vi.fn(),
    openOrder: vi.fn(),
    close: vi.fn(),
    refreshList: vi.fn(),
    selectOrder: vi.fn(),
    startNew: vi.fn(),
    edit: vi.fn(),
    save: vi.fn(),
    review: vi.fn(),
    publish: vi.fn(),
    reloadLatestRevision: vi.fn(),
  };
}

function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}

describe('PayrollTariffOrderDialog', () => {
  it('shows versions, status/date, identity fields and the three-step workflow', () => {
    const state = controller();
    const renderer = TestRenderer.create(
      <PayrollTariffOrderDialog controller={state} canManage />,
    );
    const content = text(renderer.root);

    expect(content).toContain('Приказы по тарифам');
    expect(content).toContain('Приказ № 8-09/25');
    expect(content).toContain('Опубликован');
    expect(content).toContain('Черновик');
    expect(content).toContain('15.08.2026');
    expect(renderer.root.findByProps({ 'aria-label': 'Название приказа' }).props.value).toBe(
      'Приказ № 9-08/26',
    );
    expect(renderer.root.findByProps({ 'aria-label': 'Дата вступления в силу' }).props.min).toBe(
      '2026-08-14',
    );
    expect(content).toContain('Дата указана по Москве');
    expect(content).toContain('Сохранить черновик');
    expect(content).toContain('Проверить приказ');
    expect(content).toContain('Опубликовать');
    expect(content).not.toContain('Удалить приказ');
  });

  it('shows field errors, retains the form, and offers conflict recovery', () => {
    const state = controller({
      fieldErrors: [
        { path: 'name', code: 'length', message: 'Укажите название приказа' },
      ],
      conflict: {
        code: 'PAYROLL_TARIFF_ORDER_DRAFT_STALE',
        message: 'Черновик изменён другим пользователем',
      },
    });
    const renderer = TestRenderer.create(
      <PayrollTariffOrderDialog controller={state} canManage />,
    );

    expect(text(renderer.root)).toContain('Укажите название приказа');
    expect(text(renderer.root)).toContain('Черновик изменён другим пользователем');
    const reload = renderer.root.findByProps({ children: 'Загрузить актуальную редакцию' });
    act(() => reload.props.onClick());
    expect(state.reloadLatestRevision).toHaveBeenCalledOnce();
    expect(renderer.root.findByProps({ 'aria-label': 'Название приказа' }).props.value).toBe(
      'Приказ № 9-08/26',
    );
  });

  it('does not describe a rejected review as successful and shows a validation summary', () => {
    const rejectedEditor = editor();
    rejectedEditor.review = {
      orderId: rejectedEditor.orderId!,
      revision: rejectedEditor.revision!,
      matrixHash: 'a'.repeat(64),
      minimumPublishEffectiveFrom: '2026-08-14',
      publishable: false,
      fieldErrors: [
        { path: 'name', code: 'length', message: 'Укажите название приказа' },
      ],
    };
    const renderer = TestRenderer.create(
      <PayrollTariffOrderDialog
        controller={controller({
          editor: rejectedEditor,
          fieldErrors: rejectedEditor.review.fieldErrors,
        })}
        canManage
      />,
    );
    const content = text(renderer.root);

    expect(content).toContain('Проверка нашла ошибки: 1');
    expect(content).toContain('Приказ не готов к публикации');
    expect(content).not.toContain('Редакция 2 проверена');
    expect(renderer.root.findByProps({ children: 'Опубликовать' }).props.disabled).toBe(true);
  });

  it('shows reviewed revision, disables Publish before review, and has no mutations when published', () => {
    const draftController = controller();
    const draft = TestRenderer.create(
      <PayrollTariffOrderDialog controller={draftController} canManage />,
    );
    expect(draft.root.findByProps({ children: 'Опубликовать' }).props.disabled).toBe(true);

    const reviewedEditor = editor();
    reviewedEditor.review = {
      orderId: reviewedEditor.orderId!,
      revision: reviewedEditor.revision!,
      matrixHash: 'a'.repeat(64),
      minimumPublishEffectiveFrom: '2026-08-14',
      publishable: true,
      fieldErrors: [],
    };
    const reviewed = TestRenderer.create(
      <PayrollTariffOrderDialog controller={controller({ editor: reviewedEditor })} canManage />,
    );
    expect(text(reviewed.root)).toContain('Редакция 2 проверена');
    expect(reviewed.root.findByProps({ children: 'Опубликовать' }).props.disabled).toBe(false);

    const published = TestRenderer.create(
      <PayrollTariffOrderDialog controller={controller({ editor: editor('published') })} canManage />,
    );
    expect(text(published.root)).toContain('Опубликованная версия доступна только для чтения');
    expect(text(published.root)).not.toContain('Сохранить черновик');
    expect(text(published.root)).not.toContain('Проверить приказ');
    expect(text(published.root)).not.toContain('Опубликовать');
    expect(text(published.root)).not.toContain('Удалить');
  });

  it('locks every editor exit while a mutation is in flight', () => {
    const state = controller({ mutationStatus: 'saving' });
    const renderer = TestRenderer.create(
      <PayrollTariffOrderDialog controller={state} canManage />,
    );

    expect(text(renderer.root)).toContain('Сохраняем черновик');
    expect(renderer.root.findByProps({ 'aria-label': 'Закрыть' }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({ 'aria-label': 'Название приказа' }).props.disabled).toBe(
      true,
    );
    expect(renderer.root.findByProps({ children: 'Новый приказ' }).props.disabled).toBe(true);
    expect(
      renderer.root
        .findAll((node) => node.props['aria-pressed'] !== undefined)
        .every((node) => node.props.disabled === true),
    ).toBe(true);
  });
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCommercialBigBagValues, fetchCommercialRawMaterialRisks } from './api';
import {
  CommercialRawMaterials,
  commercialRawMaterialDisplayLabel,
  commercialRawMaterialRowKey,
  commercialMaterialRiskSummary,
  sortCommercialMaterialRisks,
} from './CommercialRawMaterials';
import type { CommercialRawMaterialRiskContract } from './contracts';

const unavailable: CommercialRawMaterialRiskContract = {
  rawMaterialDefinitionId: 'raw-definition-unknown',
  materialId: 'rm-unknown',
  label: 'Пилот · ПВД без планового веса',
  stockAvailability: 'available',
  reason: null,
  actualQty: 150,
  unit: 'кг',
  package: 'мешок 25 кг',
  oneCQty: 145,
  oneCUnit: 'кг',
  oneCSource: {
    capturedAt: '2026-07-13T07:55:00.000Z',
    importedAt: '2026-07-13T08:00:00.000Z',
    stale: false,
  },
  reservedQty: null,
  plannedNeedQty: null,
  deficitQty: null,
  affectedOrders: [{ id: 'order-12', orderNumber: 'A-12', rollCount: 2 }],
  rollsInMovement: 1,
  risk: 'unknown',
  source: {
    kind: 'warehouse_fact',
    capturedAt: '2026-07-13T08:00:00.000Z',
    stale: false,
  },
  planningAvailability: 'unavailable',
  planningUnavailableReason: 'planned_weight_missing',
  reservationAvailability: 'unavailable',
  reservationUnavailableReason: 'reservation_fact_unavailable',
  monetaryMetrics: { available: false },
};

const known: CommercialRawMaterialRiskContract = {
  ...unavailable,
  rawMaterialDefinitionId: 'raw-definition-known',
  materialId: 'rm-known',
  label: 'ПВД первичный',
  actualQty: 50,
  plannedNeedQty: 80,
  deficitQty: 30,
  risk: 'deficit',
  source: {
    kind: 'warehouse_fact',
    capturedAt: '2026-07-13T08:00:00.000Z',
    stale: false,
  },
  planningAvailability: 'available',
  planningUnavailableReason: null,
};

afterEach(() => vi.unstubAllGlobals());

describe('commercial raw-material risk', () => {
  it('renders a catalog-only definition without inventing a zero warehouse fact', () => {
    const catalogOnly = {
      rawMaterialDefinitionId: 'base-aika',
      materialId: null,
      label: 'Айка',
      stockAvailability: 'unavailable',
      reason: 'stock_fact_missing',
      actualQty: null,
      unit: null,
      package: null,
      oneCQty: null,
      oneCUnit: null,
      oneCSource: null,
      reservedQty: null,
      plannedNeedQty: 25,
      deficitQty: null,
      affectedOrders: [],
      rollsInMovement: null,
      risk: 'unknown',
      source: null,
      planningAvailability: 'unavailable',
      planningUnavailableReason: 'recipe_snapshot_invalid',
      reservationAvailability: 'unavailable',
      reservationUnavailableReason: 'reservation_fact_unavailable',
      monetaryMetrics: { available: false },
    } as CommercialRawMaterialRiskContract;

    const markup = renderToStaticMarkup(
      createElement(CommercialRawMaterials, {
        items: [catalogOnly],
        status: 'ready',
        error: null,
        hasMore: false,
        onRetry: vi.fn(),
        onLoadMore: vi.fn(),
        onOpenOrder: vi.fn(),
      }),
    );

    expect(markup).toContain('Нет складского факта');
    expect(markup).toContain('Снимок рецептуры недоступен');
    expect(markup).not.toContain('>0 кг<');
  });

  it('renders the accounting balance separately from an unavailable physical warehouse fact', () => {
    const accountingOnly: CommercialRawMaterialRiskContract = {
      ...unavailable,
      materialId: null,
      label: 'Гранула ПВД',
      stockAvailability: 'unavailable',
      reason: 'stock_fact_missing',
      actualQty: null,
      unit: null,
      package: null,
      oneCQty: 125,
      oneCUnit: 'кг',
      source: null,
      risk: 'unknown',
    };

    const markup = renderToStaticMarkup(
      createElement(CommercialRawMaterials, {
        items: [accountingOnly],
        status: 'ready',
        error: null,
        hasMore: false,
        onRetry: vi.fn(),
        onLoadMore: vi.fn(),
        onOpenOrder: vi.fn(),
      }),
    );

    expect(markup).toContain('Факт склада');
    expect(markup).toContain('Нет складского факта');
    expect(markup).toContain('Учетный остаток');
    expect(markup).toContain('125 кг');
    expect(markup).toContain('Обновлено:');
    expect(markup).not.toContain('1С');
  });

  it('keys rows by definition id when multiple catalog rows have no stock id', () => {
    expect(
      commercialRawMaterialRowKey({
        rawMaterialDefinitionId: 'base-primary',
        materialId: null,
      }),
    ).toBe('base-primary');
    expect(
      commercialRawMaterialRowKey({
        rawMaterialDefinitionId: 'base-secondary',
        materialId: null,
      }),
    ).toBe('base-secondary');
  });

  it('summarizes and orders the loaded page without inventing unavailable values', () => {
    expect(
      sortCommercialMaterialRisks([unavailable, known]).map((item) => item.materialId),
    ).toEqual(['rm-known', 'rm-unknown']);
    expect(commercialMaterialRiskSummary([unavailable, known])).toEqual({
      total: 2,
      critical: 1,
      attention: 0,
      unavailable: 1,
    });
  });

  it('preserves the loaded page order inside the same risk level', () => {
    const firstAttention = {
      ...known,
      materialId: 'rm-attention-first',
      risk: 'attention' as const,
    };
    const secondAttention = {
      ...known,
      materialId: 'rm-attention-second',
      risk: 'attention' as const,
    };

    expect(
      sortCommercialMaterialRisks([secondAttention, firstAttention]).map((item) => item.materialId),
    ).toEqual(['rm-attention-second', 'rm-attention-first']);
  });

  it('removes only the strict pilot presentation prefix from a material label', () => {
    expect(commercialRawMaterialDisplayLabel('Пилот · ПВД 10803-020')).toBe('ПВД 10803-020');
    expect(commercialRawMaterialDisplayLabel('Пилот ПВД 10803-020')).toBe('Пилот ПВД 10803-020');
    expect(commercialRawMaterialDisplayLabel('Пилот · Пилот · ПВД')).toBe('Пилот · ПВД');
  });

  it('collapses affected orders behind a count while preserving safe navigation', () => {
    const markup = renderToStaticMarkup(
      createElement(CommercialRawMaterials, {
        items: [known],
        status: 'ready',
        error: null,
        hasMore: false,
        onRetry: vi.fn(),
        onLoadMore: vi.fn(),
        onOpenOrder: vi.fn(),
      }),
    );

    expect(markup).toContain('class="commercial-material-summary"');
    expect(markup).toContain('<summary>Затронутые заявки · 1');
    expect(markup).toContain('aria-label="Открыть заявку A-12"');
  });

  it('treats the initial request state as loading instead of flashing an empty result', () => {
    const markup = renderToStaticMarkup(
      createElement(CommercialRawMaterials, {
        items: [],
        status: 'idle',
        error: null,
        hasMore: false,
        onRetry: vi.fn(),
        onLoadMore: vi.fn(),
        onOpenOrder: vi.fn(),
      }),
    );

    expect(markup).toContain('Загрузка складских фактов');
    expect(markup).not.toContain('Складские материалы не найдены');
  });

  it('prioritizes the real stock and keeps an unavailable plan compact', () => {
    const markup = renderToStaticMarkup(
      createElement(CommercialRawMaterials, {
        items: [{ ...unavailable, rollsInMovement: null }, known],
        status: 'ready',
        error: null,
        hasMore: false,
        onRetry: vi.fn(),
        onLoadMore: vi.fn(),
        onOpenOrder: vi.fn(),
      }),
    );

    expect(markup).toContain('class="commercial-material-actual"');
    expect(markup).toContain('Фактический остаток');
    expect(markup).toContain('class="commercial-material-actual-value">150 кг</strong>');
    expect(markup).toContain('План не рассчитан');
    expect(markup).toContain('data-plan-cells="1"');
    expect(markup).toContain('data-plan-cells="3"');
    expect(markup.match(/Нет явного планового веса/g)).toHaveLength(1);
    expect(markup).not.toContain('Пилот · ПВД без планового веса');
    expect(markup).toContain('ПВД без планового веса');
    expect(markup).toContain('dateTime="2026-07-13T08:00:00.000Z"');
    expect(markup).toContain('A-12 · 2 рул.');
    expect(markup).toContain('Плановая потребность</dt><dd>80 кг');
    expect(markup).toContain('Ожидаемый дефицит</dt><dd>30 кг');
    expect(markup).not.toMatch(
      /Подтверждённый резерв|Нет подтверждённого факта резерва|Денежные показатели|₽|руб\.|Изменить остаток|Скорректировать склад|Оприходовать/,
    );
  });

  it('marks long server-provided package and quantity values as responsive text', () => {
    const longValue: CommercialRawMaterialRiskContract = {
      ...unavailable,
      label: 'Пилот · Очень длинное название сырья без пробелов_ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      package: 'Упаковка_ABCDEFGHIJKLMNOPQRSTUVWXYZ_012345678901234567890',
      actualQty: 1_234_567.891,
      unit: 'килограммов_ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    };
    const markup = renderToStaticMarkup(
      createElement(CommercialRawMaterials, {
        items: [longValue],
        status: 'ready',
        error: null,
        hasMore: false,
        onRetry: vi.fn(),
        onLoadMore: vi.fn(),
        onOpenOrder: vi.fn(),
      }),
    );

    expect(markup).toContain('class="commercial-material-package"');
    expect(markup).toContain('class="commercial-material-actual-value"');
    expect(markup).toContain('Упаковка_ABCDEFGHIJKLMNOPQRSTUVWXYZ_012345678901234567890');
    expect(markup).toContain('килограммов_ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  });

  it('explains a stale source without claiming that a known plan is unavailable', () => {
    const staleKnownPlan: CommercialRawMaterialRiskContract = {
      ...known,
      deficitQty: null,
      risk: 'attention',
      source: {
        kind: '1C',
        capturedAt: '2026-07-20T08:00:00.000Z',
        stale: true,
      },
    };
    const markup = renderToStaticMarkup(
      createElement(CommercialRawMaterials, {
        items: [staleKnownPlan],
        status: 'ready',
        error: null,
        hasMore: false,
        onRetry: vi.fn(),
        onLoadMore: vi.fn(),
        onOpenOrder: vi.fn(),
      }),
    );

    expect(markup).toContain('Плановая потребность</dt><dd>80 кг');
    expect(markup).toContain('Ожидаемый дефицит</dt><dd>Данные источника устарели');
    expect(markup).not.toContain('Ожидаемый дефицит</dt><dd>Планирование недоступно');
  });

  it('keeps affected orders as navigation and exposes retry/pagination states', () => {
    const markup = renderToStaticMarkup(
      createElement(CommercialRawMaterials, {
        items: [known],
        status: 'error',
        error: 'Складской источник недоступен',
        hasMore: true,
        onRetry: vi.fn(),
        onLoadMore: vi.fn(),
        onOpenOrder: vi.fn(),
      }),
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Складской источник недоступен');
    expect(markup).toContain('Повторить');
    expect(markup).toContain('Показать ещё');
    expect(markup).toContain('aria-label="Открыть заявку A-12"');
  });

  it('shows current Big-Bag weight, unit price, and recalculated total', () => {
    const markup = renderToStaticMarkup(
      createElement(CommercialRawMaterials, {
        items: [known],
        bigBags: [
          {
            id: 'bag-1',
            code: 'BB-001',
            material: 'ПВД первичный',
            status: 'available',
            location: 'warehouse',
            currentKg: 480,
            currentMeasuredAt: '2026-08-06T00:10:00.000Z',
            priceKopecksPerKg: 2_500,
            totalKopecks: 1_200_000,
            priceEffectiveAt: '2026-08-05T12:00:00.000Z',
          },
        ],
        status: 'ready',
        error: null,
        hasMore: false,
        onRetry: vi.fn(),
        onLoadMore: vi.fn(),
        onOpenOrder: vi.fn(),
      }),
    );

    expect(markup).toContain('Big-Bag');
    expect(markup).toContain('BB-001');
    expect(markup).toContain('480 кг');
    expect(markup).toContain('25 ₽/кг');
    expect(markup).toContain('12 000 ₽');
  });

  it('renders the same compact search controls used by the shared raw-material surface', () => {
    const markup = renderToStaticMarkup(
      createElement(CommercialRawMaterials, {
        items: [known],
        status: 'ready',
        error: null,
        hasMore: false,
        activeQuery: 'ПВД',
        onSearch: vi.fn(),
        onRetry: vi.fn(),
        onLoadMore: vi.fn(),
        onOpenOrder: vi.fn(),
      }),
    );

    expect(markup).toContain('class="safe-inventory-toolbar commercial-raw-material-toolbar"');
    expect(markup).toContain('aria-label="Поиск по сырью"');
    expect(markup).toContain('value="ПВД"');
    expect(markup).toContain('>Найти<');
    expect(markup).toContain('>Сбросить<');
  });

  it('requests a searched cursor page from the safe commercial endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: [known], nextCursor: null }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await fetchCommercialRawMaterialRisks({
      cursor: 'cursor/1',
      limit: 10,
      q: '  ПВД первичный  ',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/commercial/raw-materials?limit=10&q=%D0%9F%D0%92%D0%94+%D0%BF%D0%B5%D1%80%D0%B2%D0%B8%D1%87%D0%BD%D1%8B%D0%B9&cursor=cursor%2F1',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('requests Big-Bag values from the role-safe commercial endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    });
    vi.stubGlobal('fetch', fetchMock);

    await fetchCommercialBigBagValues();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/commercial/raw-materials/big-bags',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

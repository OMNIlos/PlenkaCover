import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchStockProductionTemplates } from './stockProductionTemplates';

const position = {
  rollCount: 2,
  filmType: 'Полотно',
  actualThickness: '80 мкм',
  accountingThickness: '80 мкм',
  baseRawMaterialDefinitionId: 'rmd-base-primary',
  spoolType: 'Тонкая',
  plannedWeightKg: 40,
  recipeParameters: [],
};

function stockTemplate(overrides: Record<string, unknown> = {}) {
  const id = typeof overrides.id === 'string' ? overrides.id : 'stock-template-1';
  const positions = Array.isArray(overrides.positions) ? overrides.positions : [position];
  return {
    id,
    name: 'Запас 80',
    description: 'Базовый запас',
    status: 'active',
    version: 3,
    positions,
    versions: [
      {
        id: 'stock-template-version-3',
        templateId: id,
        version: 3,
        positions,
        createdAt: '2026-07-27T09:00:00.000Z',
      },
    ],
    usageCount: 7,
    lastUsedAt: '2026-07-27T10:00:00.000Z',
    updatedAt: '2026-07-27T11:00:00.000Z',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchStockProductionTemplates', () => {
  it('accepts the current backend projection and forwards the abort signal', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse([
        stockTemplate({
          positions: [position, { ...position, filmType: 'Рукав', rollCount: 4 }],
        }),
      ]),
    );
    const controller = new AbortController();

    const result = await fetchStockProductionTemplates({ signal: controller.signal });

    expect(result[0].positions).toHaveLength(2);
    expect(result[0].versions[0].positions).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/commercial/stock-production-templates',
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('rejects malformed 2xx projections instead of publishing partial rows', async () => {
    const without = (key: string) => {
      const source = stockTemplate();
      delete (source as Record<string, unknown>)[key];
      return source;
    };
    const malformedResponses: unknown[] = [
      {},
      [without('usageCount')],
      [stockTemplate({ usageCount: '7' })],
      [stockTemplate({ status: 'unknown' })],
      [stockTemplate({ updatedAt: 'сегодня' })],
      [without('positions')],
      [
        stockTemplate({
          positions: [
            {
              rollCount: 2,
              filmType: 'Полотно',
              actualThickness: '80 мкм',
              accountingThickness: '80 мкм',
              baseRawMaterialDefinitionId: 'rmd-base-primary',
            },
          ],
        }),
      ],
      [without('versions')],
      [
        stockTemplate({
          versions: [
            {
              id: 'stock-template-version-3',
              templateId: 'another-template',
              version: 3,
              positions: [position],
              createdAt: '2026-07-27T09:00:00.000Z',
            },
          ],
        }),
      ],
    ];
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    for (const response of malformedResponses) {
      fetchMock.mockResolvedValueOnce(jsonResponse(response));
      await expect(fetchStockProductionTemplates()).rejects.toThrow(
        'Некорректный ответ каталога шаблонов на запас.',
      );
    }
  });
});

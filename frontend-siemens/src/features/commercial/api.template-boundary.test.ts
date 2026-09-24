import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCommercialTemplates } from './api';

function okResponse(json: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  };
}

function currentTemplate(overrides: Record<string, unknown> = {}) {
  const currentPositions = [
    {
      rollCount: 3,
      filmType: 'Рукав',
      actualThickness: '80 мкм',
      accountingThickness: '78 мкм',
      widthMm: 1700,
      plannedLengthM: 275,
      rawMaterialId: 'legacy-pvd',
      baseRawMaterialDefinitionId: null,
      recipeDefinitionVersionId: 'recipe-v2',
      spoolType: 'Шпуля 76 мм',
      birka: 'ГОСТ',
      manualBirka: null,
      comment: '',
      plannedWeightKg: 32.5,
      recipeParameters: [
        { label: 'Сырьё', value: 'ПВД 10803-020' },
        { label: 'Цвет', value: '' },
      ],
    },
    {
      rollCount: 2,
      filmType: 'Полурукав',
      actualThickness: '60 мкм',
      accountingThickness: '60 мкм',
      recipeParameters: [],
    },
  ];
  const previousPositions = [
    {
      rollCount: 1,
      filmType: 'Рукав',
      actualThickness: '70 мкм',
      accountingThickness: '70 мкм',
      recipeParameters: [],
    },
  ];

  return {
    id: 'template-1',
    counterpartyId: 'counterparty-1',
    name: 'Рукав 80',
    description: null,
    status: 'active',
    ownerRole: 'production_lead',
    positions: currentPositions,
    usageCount: 4,
    lastUsedAt: '2026-08-09T10:11:12.123Z',
    createdById: null,
    createdAt: '2026-08-01T08:00:00.000Z',
    updatedAt: '2026-08-10T09:00:00.000Z',
    version: 2,
    versions: [
      {
        id: 'template-version-2',
        templateId: 'template-1',
        version: 2,
        positions: currentPositions,
        createdById: 'production-user-1',
        createdAt: '2026-08-10T09:00:00.000Z',
      },
      {
        id: 'template-version-1',
        templateId: 'template-1',
        version: 1,
        positions: previousPositions,
        createdById: null,
        createdAt: '2026-08-01T08:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

function without(key: string) {
  const template = currentTemplate();
  delete (template as Record<string, unknown>)[key];
  return template;
}

afterEach(() => vi.unstubAllGlobals());

describe('commercial intake template response boundary', () => {
  it('parses the current backend DTO without losing positions or immutable versions', async () => {
    const payload = currentTemplate();
    const fetchMock = vi.fn().mockResolvedValue(okResponse([payload]));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const result = await fetchCommercialTemplates('counterparty-1', {
      signal: controller.signal,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'template-1',
      counterpartyId: 'counterparty-1',
      status: 'active',
      ownerRole: 'production_lead',
      usageCount: 4,
      activeVersionId: 'template-version-2',
    });
    expect(result[0]?.positions).toEqual(payload.positions);
    expect(result[0]?.versions).toEqual(payload.versions);
    expect(payload).not.toHaveProperty('activeVersionId');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/commercial/counterparties/counterparty-1/templates',
      expect.objectContaining({ method: 'GET', signal: controller.signal }),
    );
  });

  it('rejects malformed facts, duplicate ids and unknown enums instead of inventing defaults', async () => {
    const duplicateTemplate = currentTemplate({ id: 'duplicate-template' });
    const duplicateVersionId = currentTemplate();
    duplicateVersionId.versions = [
      duplicateVersionId.versions[0],
      { ...duplicateVersionId.versions[1], id: 'template-version-2' },
    ];
    const duplicateVersionNumber = currentTemplate();
    duplicateVersionNumber.versions = [
      duplicateVersionNumber.versions[0],
      { ...duplicateVersionNumber.versions[1], version: 2 },
    ];
    const missingPositionFact = currentTemplate();
    (missingPositionFact as Record<string, unknown>).positions = [
      { rollCount: 1, filmType: 'Рукав', actualThickness: '80', accountingThickness: '80' },
    ];
    const mismatchedVersion = currentTemplate();
    mismatchedVersion.versions = [
      { ...mismatchedVersion.versions[0], templateId: 'another-template' },
    ];

    const malformedResponses: unknown[] = [
      {},
      [without('id')],
      [without('description')],
      [without('usageCount')],
      [without('versions')],
      [currentTemplate({ status: 'mystery' })],
      [currentTemplate({ ownerRole: 'unknown_role' })],
      [currentTemplate({ description: undefined })],
      [currentTemplate({ lastUsedAt: 'yesterday' })],
      [currentTemplate({ counterpartyId: 'another-counterparty' })],
      [currentTemplate({ versions: [] })],
      [currentTemplate({ version: 3 })],
      [currentTemplate(), duplicateTemplate, { ...duplicateTemplate }],
      [duplicateVersionId],
      [duplicateVersionNumber],
      [missingPositionFact],
      [mismatchedVersion],
    ];
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    for (const response of malformedResponses) {
      fetchMock.mockResolvedValueOnce(okResponse(response));
      await expect(fetchCommercialTemplates('counterparty-1')).rejects.toThrow(
        'Некорректный ответ каталога шаблонов контрагента.',
      );
    }
  });
});

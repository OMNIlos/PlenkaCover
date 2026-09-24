import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  commercialProductionHandoffProjection,
  confirmCover,
  createCommercialOrderFromDraft,
  fetchCounterpartyTemplates,
  fetchCommercialOrders,
  forceProduction,
  normalizeCommercialWarehouseCoverage,
  promoteCommercialDraft,
  rawMaterialIdFromLabel,
  rejectCover,
  requestCoverRecheck,
  saveCommercialOrderPosition,
  selectCommercialWarehouseCoverRoute,
  sendCommercialOrderToProduction,
  submitCommercialOrderToFinance,
  updateCounterpartyTemplateFromFields,
  type ServerCommercialOrder,
} from './commercial';
import * as commercialApi from './commercial';
import { clearSession } from './authStorage';
import { defaultIntakeDraft } from '../domain/prototypeRuntime';
import {
  commercialObjectBelongsToSection,
  getCommercialNextStep,
  getWorkQueueMeta,
} from '../domain/selectors';

const serverOrder: ServerCommercialOrder = {
  id: 'order-after-action',
  orderNumber: 'CO-77',
  creatorRole: 'commercial',
  counterpartyId: 'counterparty-1',
  requestType: 'client_order',
  productionIndicator: 'not_started',
  warehouseCoverStatus: 'full_confirmed',
  paymentStatus: 'paid',
  shipmentStatus: 'not_shipped',
  commercialStage: 'in_work',
  draftedAt: null,
  sentToFinanceAt: '2026-07-08T09:02:00.000Z',
  financeConfirmedAt: '2026-07-08T09:03:00.000Z',
  commercialLockedAt: '2026-07-08T09:03:00.000Z',
  canEditParameters: false,
  canSendToFinance: false,
  canPromoteDraft: false,
  canSendToProduction: false,
  productionHandoffState: 'not_ready',
  productionOrderId: null,
  commercialConfirmationPolicy: 'required',
  createdAt: '2026-07-08T09:00:00.000Z',
  updatedAt: '2026-07-08T09:05:00.000Z',
  externalId: null,
  sourceVersion: null,
  counterparty: {
    id: 'counterparty-1',
    displayName: 'ООО Тест',
    legalName: 'ООО Тест',
    inn: '7700000000',
    billingSource: 'manual_platform',
    syncStatus: 'ready',
  },
  positions: [
    {
      id: 'position-1',
      rollCount: 2,
      filmType: 'ПВД',
      actualThickness: '80 мкм',
      accountingThickness: '80 мкм',
      rawMaterialId: null,
      spoolType: 'Тонкая',
      birka: 'Гост',
      comment: null,
      plannedWeightKg: null,
      warehouseCoverStatus: 'full_confirmed',
      recipe: null,
    },
  ],
  coverProposals: [],
  problems: [],
  stockBatchCode: null,
  financeSummary: null,
};

function okResponse(json: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  };
}

function counterpartyTemplateResponse(overrides: Record<string, unknown> = {}) {
  const id = typeof overrides.id === 'string' ? overrides.id : 'tpl-canonical';
  const counterpartyId =
    typeof overrides.counterpartyId === 'string' ? overrides.counterpartyId : 'cp-uralpak';
  const createdAt =
    typeof overrides.createdAt === 'string' ? overrides.createdAt : '2026-07-09T09:00:00.000Z';
  const positions = Array.isArray(overrides.positions)
    ? overrides.positions
    : [
        {
          rollCount: 3,
          filmType: 'Рукав',
          actualThickness: '80 мкм',
          accountingThickness: '80 мкм',
          rawMaterialId: 'rm-pvd-15803',
          recipeParameters: [],
        },
      ];
  return {
    id,
    counterpartyId,
    name: 'Канонический шаблон',
    description: null,
    status: 'active',
    ownerRole: 'production_lead',
    positions,
    usageCount: 0,
    lastUsedAt: null,
    createdById: null,
    createdAt,
    updatedAt: '2026-07-09T10:00:00.000Z',
    version: 1,
    versions: [
      {
        id: `${id}-version-1`,
        templateId: id,
        version: 1,
        positions,
        createdById: null,
        createdAt,
      },
    ],
    ...overrides,
  };
}

function stubPostThenCommercialOrders() {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(okResponse({ ok: true }))
    .mockResolvedValueOnce(okResponse([serverOrder]));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestAt(fetchMock: ReturnType<typeof stubPostThenCommercialOrders>, index: number) {
  return fetchMock.mock.calls[index] as [string, RequestInit];
}

beforeEach(() => clearSession());
afterEach(() => vi.unstubAllGlobals());

describe('commercial warehouse cover write actions', () => {
  it('uses the stable request id and structured recipe XOR in the legacy live owner', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(serverOrder));
    vi.stubGlobal('fetch', fetchMock);

    await createCommercialOrderFromDraft(
      {
        ...defaultIntakeDraft,
        positions: [
          {
            ...defaultIntakeDraft.positions[0],
            baseRawMaterialDefinitionId: '',
            recipeDefinitionVersionId: 'recipe-green-v3',
            rawMaterialId: 'legacy-must-not-leak',
          },
        ],
      },
      'commercial',
      'submit',
      '00000000-0000-4000-8000-000000000203',
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.clientRequestId).toBe('00000000-0000-4000-8000-000000000203');
    expect(body.positions[0]).toMatchObject({
      recipeDefinitionVersionId: 'recipe-green-v3',
    });
    expect(body.positions[0]).not.toHaveProperty('baseRawMaterialDefinitionId');
    expect(body.positions[0]).not.toHaveProperty('rawMaterialId');
    expect(body.positions[0]).not.toHaveProperty('recipeParameters');
  });

  it('sends the production-lead confirmation flow as submit without delegation or draft fields', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ ...serverOrder, creatorRole: 'production_lead' }));
    vi.stubGlobal('fetch', fetchMock);
    const position = { ...defaultIntakeDraft.positions[0], plannedWeightKg: '41,2' };

    await createCommercialOrderFromDraft(
      { ...defaultIntakeDraft, positions: [position] },
      'production_lead',
      'submit',
      '00000000-0000-4000-8000-000000000220',
    );

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/commercial/orders');
    expect(JSON.parse(init.body as string)).toEqual({
      clientRequestId: '00000000-0000-4000-8000-000000000220',
      counterpartyId: 'cp-uralpak',
      requestType: 'client_order',
      mode: 'submit',
      templateId: 'tpl-uralpak-sleeve-80',
      positions: [
        {
          rollCount: 3,
          filmType: 'Рукав',
          actualThickness: '80 мкм',
          accountingThickness: '78 мкм',
          widthMm: 1700,
          plannedLengthM: 275,
          baseRawMaterialDefinitionId: 'rmd-base-primary',
          spoolType: 'Тонкая',
          birka: 'ГОСТ',
          comment: 'Основная позиция для повторного заказа.',
          plannedWeightKg: 41.2,
        },
      ],
    });
  });

  it('keeps postpay production handoff ready but manual after invoice and saved terms', () => {
    const postpayAfterInvoice = {
      paymentTermsType: 'postpay_100_30d',
      invoiceStatus: 'invoiced',
      canSendToProduction: true,
      productionHandoffState: 'ready',
      productionOrderId: null,
    } as const;

    expect(commercialProductionHandoffProjection(postpayAfterInvoice)).toEqual({
      state: 'ready',
      manualActionEnabled: true,
      productionCreated: false,
    });
  });

  it('keeps 50/50 production handoff blocked until invoice prepayment is paid', () => {
    const beforePrepayment = {
      paymentTermsType: 'prepay_50_postpay_50_30d',
      invoiceStatus: 'invoiced',
      invoicePrepaymentStatus: 'unpaid',
      canSendToProduction: false,
      productionHandoffState: 'not_ready',
      productionOrderId: null,
    } as const;
    const afterPrepayment = {
      ...beforePrepayment,
      invoicePrepaymentStatus: 'paid',
      canSendToProduction: true,
      productionHandoffState: 'ready',
    } as const;

    expect(commercialProductionHandoffProjection(beforePrepayment)).toEqual({
      state: 'not_ready',
      manualActionEnabled: false,
      productionCreated: false,
    });
    expect(commercialProductionHandoffProjection(afterPrepayment)).toEqual({
      state: 'ready',
      manualActionEnabled: true,
      productionCreated: false,
    });
  });

  it('does not enable a manual handoff from an inconsistent backend projection', () => {
    expect(
      commercialProductionHandoffProjection({
        canSendToProduction: true,
        productionHandoffState: 'not_ready',
      }),
    ).toEqual({
      state: 'not_ready',
      manualActionEnabled: false,
      productionCreated: false,
    });
  });

  it('createCommercialOrderFromDraft keeps backend draft mode in the drafts bucket', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        ...serverOrder,
        id: 'draft-order',
        orderNumber: 'D-77',
        commercialStage: 'draft',
        paymentStatus: 'unpaid',
        draftedAt: '2026-07-08T09:00:00.000Z',
        sentToFinanceAt: null,
        financeConfirmedAt: null,
        commercialLockedAt: null,
        canEditParameters: true,
        canSendToFinance: false,
        canPromoteDraft: true,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await createCommercialOrderFromDraft(
      defaultIntakeDraft,
      'commercial',
      'draft',
      '00000000-0000-4000-8000-000000000204',
    );

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/commercial/orders');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({ mode: 'draft' });
    expect(result.statusLabel).toBe('Черновик');
    expect(result.filterTags).toContain('Черновики');
    expect(result.actions).toContainEqual(
      expect.objectContaining({ id: 'commercial-promote-draft', label: 'Оформить заявку' }),
    );
    expect(result.actions).not.toContainEqual(
      expect.objectContaining({ id: 'commercial-transfer-selected' }),
    );
  });

  it('createCommercialOrderFromDraft sends the selected template id to backend', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(serverOrder));
    vi.stubGlobal('fetch', fetchMock);

    await createCommercialOrderFromDraft(
      {
        ...defaultIntakeDraft,
        templateId: 'tpl-custom-production-70',
        templateVersionId: 'tpl-custom-production-70-version-4',
        template: 'УралПак · рукав 70 мкм',
      },
      'commercial',
      'submit',
      '00000000-0000-4000-8000-000000000205',
    );

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/commercial/orders');
    expect(JSON.parse(init.body as string)).toMatchObject({
      counterpartyId: 'cp-uralpak',
      templateId: 'tpl-custom-production-70',
      templateVersionId: 'tpl-custom-production-70-version-4',
    });
  });

  it('uses the immutable backend version id as the active reusable template version', async () => {
    const response = counterpartyTemplateResponse();
    response.version = 4;
    response.versions = [
      {
        id: 'tpl-canonical-version-4',
        templateId: response.id,
        version: 4,
        positions: response.positions,
        createdById: null,
        createdAt: '2026-07-09T10:00:00.000Z',
      },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([response])));

    const result = await fetchCounterpartyTemplates(['cp-uralpak']);

    expect(result.templates[0]?.activeVersionId).toBe('tpl-canonical-version-4');
    expect(result.versions[0]?.id).toBe('tpl-canonical-version-4');
  });

  it('keeps a legacy template reusable without inventing a persisted version id', async () => {
    const response = counterpartyTemplateResponse({ versions: [] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([response])));

    const result = await fetchCounterpartyTemplates(['cp-uralpak']);

    expect(result.templates[0]?.activeVersionId).toBe('');
    expect(result.versions).toEqual([]);
    expect(result.draftPositions['tpl-canonical']).toHaveLength(1);
  });

  it('createCommercialOrderFromDraft forwards the checked template-save flag', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(serverOrder));
    vi.stubGlobal('fetch', fetchMock);

    await createCommercialOrderFromDraft(
      { ...defaultIntakeDraft, saveAsTemplate: true },
      'commercial',
      'submit',
      '00000000-0000-4000-8000-000000000221',
    );

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/commercial/orders');
    expect(JSON.parse(init.body as string)).toMatchObject({ saveAsTemplate: true });
  });

  it('createCommercialOrderFromDraft sends migrated baseline template ids to backend', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(serverOrder));
    vi.stubGlobal('fetch', fetchMock);

    await createCommercialOrderFromDraft(
      {
        ...defaultIntakeDraft,
        templateId: 'tpl-uralpak-sleeve-80',
        template: 'УралПак · рукав 80 мкм',
      },
      'commercial',
      'submit',
      '00000000-0000-4000-8000-000000000206',
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.counterpartyId).toBe('cp-uralpak');
    expect(body.templateId).toBe('tpl-uralpak-sleeve-80');
    expect(body.positions[0]).toMatchObject({
      rollCount: 3,
      actualThickness: '80 мкм',
      widthMm: 1700,
      plannedLengthM: 275,
    });
  });

  it('fetchCounterpartyTemplates keeps the saved roll weight in template fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse([
        counterpartyTemplateResponse({
          id: 'tpl-custom-production-70',
          counterpartyId: 'cp-uralpak',
          name: 'УралПак · Codex 70 мкм',
          status: 'active',
          ownerRole: 'production_lead',
          usageCount: 0,
          lastUsedAt: null,
          createdAt: '2026-07-09T09:00:00.000Z',
          updatedAt: '2026-07-09T09:00:00.000Z',
          positions: [
            {
              id: 'pos-template-1',
              rollCount: 5,
              filmType: 'Рукав',
              actualThickness: '70 мкм',
              accountingThickness: '70 мкм',
              rawMaterialId: 'rm-pvd-10803',
              baseRawMaterialDefinitionId: null,
              recipeDefinitionVersionId: 'recipe-green-v3',
              spoolType: 'Шпуля 152 мм',
              birka: 'Прозрачный',
              recipeParameters: [
                { label: 'Позиции', value: '5 рулонов, рукав 70 мкм' },
                { label: 'Рулоны', value: '5 шт. по 32.5 кг' },
                { label: 'Сырье', value: 'ПВД 10803-020' },
              ],
            },
          ],
        }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchCounterpartyTemplates(['cp-uralpak']);

    const [path] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/commercial/counterparties/cp-uralpak/templates');
    expect(result.versions[0].fields).toContainEqual(
      expect.objectContaining({ label: 'Рулоны', value: '5 шт. по 32.5 кг' }),
    );
    expect(result.draftPositions['tpl-custom-production-70']?.[0]).toMatchObject({
      baseRawMaterialDefinitionId: '',
      recipeDefinitionVersionId: 'recipe-green-v3',
      plannedWeightKg: '32.5',
    });
  });

  it('does not present the first row as the full composition of a multi-position template', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse([
        counterpartyTemplateResponse({
          id: 'tpl-multi',
          counterpartyId: 'cp-uralpak',
          name: 'Две позиции',
          status: 'active',
          ownerRole: 'production_lead',
          createdAt: '2026-07-09T09:00:00.000Z',
          positions: [
            {
              id: 'pos-first',
              rollCount: 2,
              filmType: 'FIRST-ONLY',
              actualThickness: '40 мкм',
              accountingThickness: '40 мкм',
              rawMaterialId: 'rm-first',
              spoolType: 'Шпуля 76 мм',
              recipeParameters: [],
            },
            {
              id: 'pos-second',
              rollCount: 7,
              filmType: 'SECOND-ONLY',
              actualThickness: '90 мкм',
              accountingThickness: '90 мкм',
              rawMaterialId: 'rm-second',
              spoolType: 'Шпуля 152 мм',
              recipeParameters: [],
            },
          ],
        }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchCounterpartyTemplates(['cp-uralpak']);

    expect(result.versions[0].fields).toEqual([
      expect.objectContaining({ label: 'Количество позиций', value: '2' }),
    ]);
    expect(JSON.stringify(result.versions[0].fields)).not.toContain('FIRST-ONLY');
    expect(JSON.stringify(result.versions[0].fields)).not.toContain('SECOND-ONLY');
    expect(result.draftPositions['tpl-multi']).toHaveLength(2);
  });

  it('fetchCounterpartyTemplates does not duplicate color fields from recipe and birka', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse([
        counterpartyTemplateResponse({
          id: 'tpl-uralpak-sleeve-80',
          counterpartyId: 'cp-uralpak',
          name: 'УралПак · рукав 80 мкм',
          status: 'active',
          ownerRole: 'production_lead',
          usageCount: 18,
          lastUsedAt: null,
          createdAt: '2026-06-08T00:00:00.000Z',
          updatedAt: '2026-07-09T10:00:00.000Z',
          positions: [
            {
              rollCount: 3,
              filmType: 'Рукав',
              actualThickness: '80 мкм',
              accountingThickness: '80 мкм',
              rawMaterialId: 'rm-pvd-15803',
              spoolType: 'Шпуля 76 мм',
              birka: 'Прозрачный',
              recipeParameters: [
                { label: 'Цвет', value: 'Прозрачный с маркировкой' },
                { label: 'Рулоны', value: '3 шт. по 41.2 кг' },
              ],
            },
          ],
        }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchCounterpartyTemplates(['cp-uralpak']);
    const colorFields = result.versions[0].fields.filter((field) => field.label === 'Цвет');

    expect(colorFields).toEqual([expect.objectContaining({ value: 'Прозрачный с маркировкой' })]);
  });

  it('maps only explicit canonical template metadata without fallback facts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse([
        counterpartyTemplateResponse({
          id: 'tpl-explicit-metadata',
          usageCount: 7,
          lastUsedAt: '2026-07-08T12:34:56.000Z',
          createdById: 'production-lead-7',
          createdAt: '2026-07-07T08:00:00.000Z',
          updatedAt: '2026-07-09T10:00:00.000Z',
        }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchCounterpartyTemplates(['cp-uralpak']);

    expect(result.templates).toEqual([
      expect.objectContaining({
        status: 'active',
        ownerRole: 'Зав. производства',
        usageCount: 7,
        lastUsedAt: '2026-07-08',
        updatedAt: '2026-07-09',
      }),
    ]);
    expect(result.versions[0]).toEqual(
      expect.objectContaining({
        createdBy: 'production-lead-7',
        createdAt: '2026-07-07',
      }),
    );
  });

  it('rejects malformed successful template responses instead of inventing catalog facts', async () => {
    const without = (key: string) => {
      const source = counterpartyTemplateResponse();
      delete (source as Record<string, unknown>)[key];
      return source;
    };
    const malformedPosition = counterpartyTemplateResponse({
      positions: [
        {
          rollCount: 3,
          filmType: 'Рукав',
          actualThickness: '80 мкм',
          accountingThickness: '80 мкм',
        },
      ],
    });
    const malformedVersion = counterpartyTemplateResponse({
      versions: [
        {
          id: 'tpl-canonical-version-1',
          templateId: 'another-template',
          version: 1,
          positions: [
            {
              rollCount: 3,
              filmType: 'Рукав',
              actualThickness: '80 мкм',
              accountingThickness: '80 мкм',
              recipeParameters: [],
            },
          ],
          createdById: null,
          createdAt: '2026-07-09T09:00:00.000Z',
        },
      ],
    });
    const malformedResponses: unknown[] = [
      {},
      [without('status')],
      [counterpartyTemplateResponse({ status: 'mystery' })],
      [without('usageCount')],
      [counterpartyTemplateResponse({ usageCount: '0' })],
      [without('updatedAt')],
      [counterpartyTemplateResponse({ updatedAt: 'сегодня' })],
      [without('ownerRole')],
      [counterpartyTemplateResponse({ ownerRole: 'unknown_role' })],
      [without('positions')],
      [malformedPosition],
      [without('versions')],
      [malformedVersion],
      [counterpartyTemplateResponse({ counterpartyId: 'cp-another' })],
    ];
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    for (const response of malformedResponses) {
      fetchMock.mockResolvedValueOnce(okResponse(response));
      await expect(fetchCounterpartyTemplates(['cp-uralpak'])).rejects.toThrow(
        'Некорректный ответ шаблонов контрагента.',
      );
    }
  });

  it('bounds counterparty template request fan-out', async () => {
    const resolvers: Array<(response: ReturnType<typeof okResponse>) => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<ReturnType<typeof okResponse>>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const request = fetchCounterpartyTemplates(
      Array.from({ length: 7 }, (_, index) => `cp-${index + 1}`),
    );
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(6);

    for (const resolve of resolvers.slice(0, 6)) resolve(okResponse([]));
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(7);
    resolvers[6]?.(okResponse([]));
    await expect(request).resolves.toEqual({ templates: [], versions: [], draftPositions: {} });
  });

  it('updateCounterpartyTemplateFromFields patches an existing backend template', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse(
        counterpartyTemplateResponse({
          id: 'tpl-custom-production-70',
          counterpartyId: 'cp-uralpak',
          name: 'УралПак · рукав 70 мкм',
          status: 'active',
          ownerRole: 'production_lead',
          usageCount: 0,
          lastUsedAt: null,
          createdAt: '2026-07-09T09:00:00.000Z',
          updatedAt: '2026-07-09T10:00:00.000Z',
          positions: [
            {
              id: 'pos-template-1',
              rollCount: 10,
              filmType: 'Рукав',
              actualThickness: '70 мкм',
              accountingThickness: '70 мкм',
              widthMm: 1650,
              plannedLengthM: 420,
              rawMaterialId: 'rm-pvd-10803',
              spoolType: 'Шпуля 152 мм',
              birka: 'Прозрачный',
              recipeParameters: [{ label: 'Рулоны', value: '10 шт. по 32.5 кг' }],
            },
          ],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await updateCounterpartyTemplateFromFields(
      'cp-uralpak',
      'tpl-custom-production-70',
      'УралПак · рукав 70 мкм',
      [
        {
          ...defaultIntakeDraft.positions[0],
          rollCount: '10',
          filmType: 'Рукав',
          actualThickness: '70 мкм',
          accountingThickness: '70 мкм',
          widthMm: '1650',
          plannedLengthM: '420',
          plannedWeightKg: '32.5',
          baseRawMaterialDefinitionId: '',
          recipeDefinitionVersionId: 'recipe-green-v3',
          spoolType: 'Тонкая',
          birka: 'ГОСТ',
          manualBirka: '',
          comment: '',
        },
      ],
    );

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(
      '/api/commercial/counterparties/cp-uralpak/templates/tpl-custom-production-70',
    );
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string).positions[0]).toMatchObject({
      rollCount: 10,
      actualThickness: '70 мкм',
      widthMm: 1650,
      plannedLengthM: 420,
      recipeDefinitionVersionId: 'recipe-green-v3',
    });
    expect(JSON.parse(init.body as string).positions[0]).not.toHaveProperty('rawMaterialId');
    expect(result.versions[0].fields).toContainEqual(
      expect.objectContaining({ label: 'Рулоны', value: '10 шт. по 32.5 кг' }),
    );
    expect(result.versions[0].fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Ширина, мм', value: '1650' }),
        expect.objectContaining({ label: 'Метраж, м', value: '420' }),
      ]),
    );
  });

  it('sends every structured position when a counterparty template is updated', async () => {
    const response = counterpartyTemplateResponse({
      id: 'tpl-multi-edit',
      counterpartyId: 'cp-uralpak',
      name: 'Две позиции',
      positions: [
        {
          id: 'server-position-1',
          rollCount: 2,
          filmType: 'Рукав',
          actualThickness: '80 мкм',
          accountingThickness: '78 мкм',
          widthMm: 1700,
          plannedLengthM: 275,
          plannedWeightKg: 41.2,
          baseRawMaterialDefinitionId: 'material-primary',
          spoolType: 'Тонкая',
          birka: 'ГОСТ',
          recipeParameters: [],
        },
        {
          id: 'server-position-2',
          rollCount: 4,
          filmType: 'Полотно',
          actualThickness: '60 мкм',
          accountingThickness: '58 мкм',
          widthMm: 1400,
          plannedLengthM: 350,
          plannedWeightKg: 34.5,
          recipeDefinitionVersionId: 'recipe-secondary-v2',
          spoolType: 'Толстая',
          birka: 'i',
          manualBirka: 'Маркировка клиента',
          comment: 'Не объединять с первой позицией',
          recipeParameters: [],
        },
      ],
    });
    const fetchMock = vi.fn().mockResolvedValue(okResponse(response));
    vi.stubGlobal('fetch', fetchMock);

    const saved = await updateCounterpartyTemplateFromFields(
      'cp-uralpak',
      'tpl-multi-edit',
      'Две позиции',
      [
        {
          ...defaultIntakeDraft.positions[0],
          id: 'draft-position-1',
          rollCount: '2',
          filmType: 'Рукав',
          actualThickness: '80 мкм',
          accountingThickness: '78 мкм',
          widthMm: '1700',
          plannedLengthM: '275',
          plannedWeightKg: '41.2',
          baseRawMaterialDefinitionId: 'material-primary',
          recipeDefinitionVersionId: '',
          spoolType: 'Тонкая',
          birka: 'ГОСТ',
          comment: '',
        },
        {
          ...defaultIntakeDraft.positions[1],
          id: 'draft-position-2',
          rollCount: '4',
          filmType: 'Полотно',
          actualThickness: '60 мкм',
          accountingThickness: '58 мкм',
          widthMm: '1400',
          plannedLengthM: '350',
          plannedWeightKg: '34,5',
          baseRawMaterialDefinitionId: '',
          recipeDefinitionVersionId: 'recipe-secondary-v2',
          spoolType: 'Толстая',
          birka: 'i',
          manualBirka: 'Маркировка клиента',
          comment: 'Не объединять с первой позицией',
        },
      ],
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).positions).toEqual([
      {
        rollCount: 2,
        filmType: 'Рукав',
        actualThickness: '80 мкм',
        accountingThickness: '78 мкм',
        widthMm: 1700,
        plannedLengthM: 275,
        baseRawMaterialDefinitionId: 'material-primary',
        spoolType: 'Тонкая',
        birka: 'ГОСТ',
        plannedWeightKg: 41.2,
      },
      {
        rollCount: 4,
        filmType: 'Полотно',
        actualThickness: '60 мкм',
        accountingThickness: '58 мкм',
        widthMm: 1400,
        plannedLengthM: 350,
        recipeDefinitionVersionId: 'recipe-secondary-v2',
        spoolType: 'Толстая',
        birka: 'i',
        manualBirka: 'Маркировка клиента',
        comment: 'Не объединять с первой позицией',
        plannedWeightKg: 34.5,
      },
    ]);
    expect(saved.draftPositions['tpl-multi-edit']).toEqual([
      expect.objectContaining({
        id: 'server-position-1',
        baseRawMaterialDefinitionId: 'material-primary',
      }),
      expect.objectContaining({
        id: 'server-position-2',
        recipeDefinitionVersionId: 'recipe-secondary-v2',
        manualBirka: 'Маркировка клиента',
        comment: 'Не объединять с первой позицией',
      }),
    ]);
  });

  it.each(['archived', 'active'] as const)(
    'updateCounterpartyTemplateStatus persists the %s lifecycle state',
    async (status) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(okResponse(counterpartyTemplateResponse({ status })));
      vi.stubGlobal('fetch', fetchMock);

      const result = await (
        commercialApi as never as {
          updateCounterpartyTemplateStatus: (
            counterpartyId: string,
            templateId: string,
            nextStatus: typeof status,
          ) => ReturnType<typeof fetchCounterpartyTemplates>;
        }
      ).updateCounterpartyTemplateStatus('cp-uralpak', 'tpl-canonical', status);

      const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(path).toBe('/api/commercial/counterparties/cp-uralpak/templates/tpl-canonical/status');
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(init.body as string)).toEqual({ status });
      expect(result.templates[0]).toEqual(expect.objectContaining({ status }));
    },
  );

  it('promoteCommercialDraft uses a separate endpoint and maps the order to incoming', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        ...serverOrder,
        id: 'promoted-order',
        orderNumber: 'A-77',
        commercialStage: 'incoming',
        paymentStatus: 'unpaid',
        canPromoteDraft: false,
        canSendToFinance: true,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await promoteCommercialDraft('draft-order');

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/commercial/orders/draft-order/promote-draft');
    expect(init.method).toBe('POST');
    expect(result.statusLabel).not.toBe('Черновик');
    expect(result.filterTags).toContain('Входящие заявки');
    expect(result.actions).toContainEqual(
      expect.objectContaining({ id: 'commercial-transfer-selected' }),
    );
  });

  it('submitCommercialOrderToFinance does not set a price label from commercial', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        ...serverOrder,
        commercialStage: 'sent_to_finance',
        financeSummary: {
          id: 'finance-order-1',
          invoiceStatus: 'not_invoiced',
          paymentStatus: 'unpaid',
          amountValue: 0,
          amountLabel: null,
          schedules: [],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await submitCommercialOrderToFinance('order-1');

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/commercial/orders/order-1/submit-to-finance');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ amount: 0 });
  });

  it('maps finance-confirmed live orders to the commercial in-work section', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse([
        {
          ...serverOrder,
          commercialStage: 'in_work',
          paymentStatus: 'partial',
          financeSummary: {
            id: 'finance-order-1',
            invoiceStatus: 'invoiced',
            paymentStatus: 'partial',
            amountValue: 0,
            amountLabel: 'Направлено коммерцией',
            schedules: [],
          },
        },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const [result] = await fetchCommercialOrders();

    expect(result.statusLabel).toBe('В работе');
    expect(result.filterTags).toContain('В работе');
    expect(commercialObjectBelongsToSection(result, 'В работе')).toBe(true);
    expect(commercialObjectBelongsToSection(result, 'Входящие заявки')).toBe(false);
  });

  it('keeps a needs-production commercial order active after it moves to in-work', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse([
        {
          ...serverOrder,
          commercialStage: undefined,
          draftedAt: null,
          sentToFinanceAt: null,
          financeConfirmedAt: null,
          warehouseCoverStatus: 'needs_production',
          paymentStatus: 'unpaid',
          positions: [
            {
              ...serverOrder.positions[0],
              warehouseCoverStatus: 'needs_production',
            },
          ],
        },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const [result] = await fetchCommercialOrders();

    expect(result.statusLabel).toBe('Передано');
    expect(commercialObjectBelongsToSection(result, 'В работе')).toBe(true);
    expect(getWorkQueueMeta('commercial', result).queueBucket).toBe('active');
  });

  it('uses the backend handoff flag for the commercial production action', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse([
        {
          ...serverOrder,
          commercialStage: 'in_work',
          paymentStatus: 'partial',
          canSendToProduction: true,
          productionHandoffState: 'ready',
        },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const [result] = await fetchCommercialOrders();

    expect(result.actions).toContainEqual(
      expect.objectContaining({
        id: `commercial-send-to-production:${serverOrder.id}`,
        label: 'Отправить зав. производства',
        enabled: true,
      }),
    );
    expect(result.nextOwner).toBe('Коммерция');
    expect(getCommercialNextStep(result)).toEqual(
      expect.objectContaining({
        actionId: `commercial-send-to-production:${serverOrder.id}`,
        label: 'Отправить зав. производства',
        owner: 'Коммерция',
      }),
    );
  });

  it('sendCommercialOrderToProduction posts the explicit handoff and refetches commercial', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ id: 'production-order-1' }))
      .mockResolvedValueOnce(
        okResponse([
          {
            ...serverOrder,
            commercialStage: 'in_work',
            paymentStatus: 'partial',
            canSendToProduction: false,
            productionHandoffState: 'sent',
            productionOrderId: 'production-order-1',
          },
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendCommercialOrderToProduction('order / 1');

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/commercial/orders/order%20%2F%201/send-to-production',
    );
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe('POST');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/commercial/orders');
    expect(result[0]?.id).toBe(serverOrder.id);
  });

  it('requestCoverRecheck posts escaped order id and returns refetched commercial orders', async () => {
    const fetchMock = stubPostThenCommercialOrders();

    const result = await requestCoverRecheck('A 1');

    const [postPath, postInit] = requestAt(fetchMock, 0);
    expect(postPath).toBe('/api/commercial/orders/A%201/warehouse-cover/recheck');
    expect(postInit.method).toBe('POST');
    expect(JSON.parse(postInit.body as string)).toEqual({});

    const [getPath, getInit] = requestAt(fetchMock, 1);
    expect(getPath).toBe('/api/commercial/orders');
    expect(getInit.method).toBe('GET');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'order-after-action', title: 'CO-77 · ООО Тест' });
  });

  it('confirmCover posts escaped order and proposal ids and returns refetched commercial orders', async () => {
    const fetchMock = stubPostThenCommercialOrders();

    const result = await confirmCover('A 1', 'P/7');

    const [postPath, postInit] = requestAt(fetchMock, 0);
    expect(postPath).toBe('/api/commercial/orders/A%201/warehouse-cover/P%2F7/confirm');
    expect(postInit.method).toBe('POST');
    expect(JSON.parse(postInit.body as string)).toEqual({});

    const [getPath, getInit] = requestAt(fetchMock, 1);
    expect(getPath).toBe('/api/commercial/orders');
    expect(getInit.method).toBe('GET');
    expect(result[0]?.id).toBe('order-after-action');
  });

  it('rejectCover posts reason with escaped ids and returns refetched commercial orders', async () => {
    const fetchMock = stubPostThenCommercialOrders();

    const result = await rejectCover('A 1', 'P/7', 'не подходит клиенту');

    const [postPath, postInit] = requestAt(fetchMock, 0);
    expect(postPath).toBe('/api/commercial/orders/A%201/warehouse-cover/P%2F7/reject');
    expect(postInit.method).toBe('POST');
    expect(JSON.parse(postInit.body as string)).toEqual({ reason: 'не подходит клиенту' });

    const [getPath, getInit] = requestAt(fetchMock, 1);
    expect(getPath).toBe('/api/commercial/orders');
    expect(getInit.method).toBe('GET');
    expect(result[0]?.id).toBe('order-after-action');
  });

  it('forceProduction posts escaped order id with empty body and returns refetched commercial orders', async () => {
    const fetchMock = stubPostThenCommercialOrders();

    const result = await forceProduction('A 1');

    const [postPath, postInit] = requestAt(fetchMock, 0);
    expect(postPath).toBe('/api/commercial/orders/A%201/force-production');
    expect(postInit.method).toBe('POST');
    expect(JSON.parse(postInit.body as string)).toEqual({});

    const [getPath, getInit] = requestAt(fetchMock, 1);
    expect(getPath).toBe('/api/commercial/orders');
    expect(getInit.method).toBe('GET');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'order-after-action', title: 'CO-77 · ООО Тест' });
  });

  it('forceProduction posts reason when provided', async () => {
    const fetchMock = stubPostThenCommercialOrders();

    await forceProduction('A 1', 'клиент срочно');

    const [postPath, postInit] = requestAt(fetchMock, 0);
    expect(postPath).toBe('/api/commercial/orders/A%201/force-production');
    expect(postInit.method).toBe('POST');
    expect(JSON.parse(postInit.body as string)).toEqual({ reason: 'клиент срочно' });
  });

  it('resolves a raw material id from the live warehouse source', () => {
    expect(
      rawMaterialIdFromLabel('Новый материал склада', [
        {
          id: 'stock-new',
          rawMaterialId: 'rm-new',
          label: 'Новый материал склада',
          materialKind: 'primary',
          qty: 400,
          actualQty: 400,
          unit: 'кг',
          source: 'warehouse_fact',
          sourceOfTruthStatus: 'актуально',
          updatedAt: '2026-07-13T09:10:00.000Z',
        },
      ]),
    ).toBe('rm-new');
  });

  it('saves a position with one patch and one positional route mutation', async () => {
    const routedOrder: ServerCommercialOrder = {
      ...serverOrder,
      warehouseCoverStatus: 'needs_production',
      positions: [
        {
          ...serverOrder.positions[0],
          warehouseCoverStatus: 'needs_production',
        },
      ],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse(serverOrder))
      .mockResolvedValueOnce(okResponse(routedOrder));
    vi.stubGlobal('fetch', fetchMock);

    const result = await saveCommercialOrderPosition(
      'order-after-action',
      'position-1',
      {
        rollCount: 4,
        filmType: 'Полурукав',
        actualThickness: '90 мкм',
        accountingThickness: '70 мкм',
        rawMaterialId: 'rm-live',
      },
      {
        status: 'needs_production',
        reason: 'Коммерция выбрала маршрут покрытия в правке позиции',
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/commercial/orders/order-after-action/positions/position-1',
    );
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe('PATCH');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      '/api/commercial/orders/order-after-action/warehouse-cover/route',
    );
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).method).toBe('POST');
    expect(fetchMock.mock.calls.some(([path]) => String(path).includes('force-production'))).toBe(
      false,
    );
    expect(result.commercialOrder?.warehouseCoverStatus).toBe('needs_production');
  });

  it('selectCommercialWarehouseCoverRoute persists commercial partial cover choice', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        ...serverOrder,
        warehouseCoverStatus: 'partial_proposed',
        positions: [
          {
            ...serverOrder.positions[0],
            warehouseCoverStatus: 'partial_proposed',
          },
        ],
        coverProposals: [
          {
            id: 'proposal-1',
            positionId: 'position-1',
            coverType: 'partial',
            coverQty: 1,
            reserveQty: 1,
            productionQty: 1,
            matchedRollIds: [],
            status: 'partial_proposed',
            createdAt: '2026-07-08T09:20:00.000Z',
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await selectCommercialWarehouseCoverRoute('order-after-action', {
      positionId: 'position-1',
      status: 'partial_proposed',
      coverQty: 1,
      reason: 'коммерция выбрала часть сырьем',
    });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/commercial/orders/order-after-action/warehouse-cover/route');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      positionId: 'position-1',
      status: 'partial_proposed',
      coverQty: 1,
      reason: 'коммерция выбрала часть сырьем',
    });
    expect(result.warehouseCoverProposals?.[0]).toMatchObject({
      positionId: 'position-1',
      coverQty: 1,
      missingQty: 1,
      warehouseCoverStatus: 'partial_proposed',
    });
  });
});

describe('commercial warehouse coverage v2 projection boundary', () => {
  it('keeps only the safe aggregate and drops finance, membership, and scan rows', () => {
    const result = normalizeCommercialWarehouseCoverage({
      workflowVersion: 2,
      state: 'production_required',
      stateVersion: 5,
      generation: 3,
      availability: 'unavailable',
      reasonCodes: ['no_compatible_rolls'],
      nextOwner: 'commercial',
      availableActions: [],
      requiredRollCount: 2,
      matchedRollCount: 0,
      uncertainRollCount: 0,
      calculatedAt: '2026-07-24T10:00:00.000Z',
      stale: false,
      financeRolls: [{ rollCode: 'SECRET-ROLL', positionId: 'secret-position' }],
      members: [{ membershipId: 'secret-membership' }],
      rows: [{ scanRowId: 'secret-scan-row' }],
    });

    expect(result).toMatchObject({
      workflowVersion: 2,
      state: 'production_required',
      matchedRollCount: 0,
    });
    expect(JSON.stringify(result)).not.toMatch(/SECRET-ROLL|financeRolls|membershipId|scanRowId/u);
  });
});

import { afterEach, expect, it, vi } from 'vitest';

import { defaultIntakeDraft } from '../domain/prototypeRuntime';
import { createCommercialOrderFromDraft } from './commercial';

function okResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createResult() {
  return {
    id: 'order-server-only',
    orderNumber: 'A-9001',
    creatorRole: 'production_lead',
    counterpartyId: 'cp-server-only',
    requestType: 'client_order',
    productionIndicator: 'not_started',
    warehouseCoverStatus: 'not_checked',
    paymentStatus: 'unpaid',
    shipmentStatus: 'not_shipped',
    commercialStage: 'incoming',
    draftedAt: null,
    sentToFinanceAt: null,
    financeConfirmedAt: null,
    commercialLockedAt: null,
    canEditParameters: true,
    canSendToFinance: true,
    canPromoteDraft: false,
    canSendToProduction: false,
    productionHandoffState: 'not_ready',
    productionOrderId: null,
    commercialConfirmationPolicy: 'required',
    createdAt: '2026-08-10T09:00:00.000Z',
    updatedAt: '2026-08-10T09:00:00.000Z',
    externalId: null,
    sourceVersion: null,
    counterparty: {
      id: 'cp-server-only',
      displayName: 'Серверный клиент',
      legalName: 'ООО Серверный клиент',
      inn: '7700000000',
      billingSource: 'one_c',
      syncStatus: 'synced',
    },
    stockBatchCode: null,
    positions: [
      {
        id: 'position-server-only',
        rollCount: 3,
        filmType: 'Рукав',
        actualThickness: '80 мкм',
        accountingThickness: '78 мкм',
        rawMaterialId: null,
        spoolType: 'Тонкая',
        birka: 'ГОСТ',
        comment: null,
        plannedWeightKg: 41.2,
        warehouseCoverStatus: 'not_checked',
        recipe: null,
      },
    ],
    coverProposals: [],
    problems: [],
    financeSummary: null,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it('posts a selected non-fixture live counterparty id without creating a duplicate counterparty', async () => {
  const fetchMock = vi.fn().mockResolvedValue(okResponse(createResult()));
  vi.stubGlobal('fetch', fetchMock);

  await createCommercialOrderFromDraft(
    {
      ...defaultIntakeDraft,
      counterparty: 'Серверный клиент',
      counterpartyId: 'cp-server-only',
      templateId: undefined,
      template: 'Ручной ввод параметров',
    },
    'production_lead',
    'submit',
    '00000000-0000-4000-8000-000000000301',
  );

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(path).toBe('/api/commercial/orders');
  expect(JSON.parse(init.body as string)).toMatchObject({
    counterpartyId: 'cp-server-only',
    clientRequestId: '00000000-0000-4000-8000-000000000301',
  });
  expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain(
    '/api/commercial/counterparties',
  );
});

it('blocks live quick-create before any non-idempotent counterparty fact can be retried', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const form = {
    ...defaultIntakeDraft,
    counterparty: '__new__',
    counterpartyId: undefined,
    counterpartyQuickCreateSaved: true,
    newCounterpartyName: 'ООО Новый клиент',
    newCounterpartyInn: '7700000001',
    templateId: undefined,
  };

  await expect(
    createCommercialOrderFromDraft(
      form,
      'production_lead',
      'submit',
      '00000000-0000-4000-8000-000000000303',
    ),
  ).rejects.toThrow('Выберите запись из справочника');
  await expect(
    createCommercialOrderFromDraft(
      form,
      'production_lead',
      'submit',
      '00000000-0000-4000-8000-000000000303',
    ),
  ).rejects.toThrow('Выберите запись из справочника');
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([
  ['missing stage', (value: Record<string, unknown>) => delete value.commercialStage],
  ['unknown indicator', (value: Record<string, unknown>) => (value.productionIndicator = 'maybe')],
  ['missing capability', (value: Record<string, unknown>) => delete value.canSendToFinance],
  [
    'missing position id',
    (value: Record<string, unknown>) =>
      delete (value.positions as Array<Record<string, unknown>>)[0]?.id,
  ],
])('rejects a malformed create 2xx response: %s', async (_label, mutate) => {
  const response = createResult() as unknown as Record<string, unknown>;
  mutate(response);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(response)));

  await expect(
    createCommercialOrderFromDraft(
      {
        ...defaultIntakeDraft,
        counterparty: 'Серверный клиент',
        counterpartyId: 'cp-server-only',
        templateId: undefined,
      },
      'production_lead',
      'submit',
      '00000000-0000-4000-8000-000000000302',
    ),
  ).rejects.toThrow('Некорректный ответ создания заявки');
});

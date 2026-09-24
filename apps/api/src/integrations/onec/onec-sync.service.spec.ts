import type {
  OneCCounterpartySnapshot,
  OneCInvoiceLineSource,
  OneCInvoiceSnapshot,
  OneCNomenclatureSnapshot,
  OneCOrganizationSnapshot,
  OneCPaymentSnapshot,
  OneCProductionMaterialLineSource,
  OneCProductionOutputLineSource,
  OneCProductionReportSnapshot,
  OneCShipmentLineSource,
  OneCShipmentSnapshot,
  OneCStockSnapshot,
  OneCWarehouseSnapshot,
} from '@plenka/contracts';
import { Prisma } from '@prisma/client';
import { OneCSyncService } from './onec-sync.service';

const ACTOR = { userId: 'admin-1', role: 'admin' as const };
const AT = '2026-07-29T08:00:00.000Z';
const REPORT_ID = '33333333-3333-4333-8333-333333333333';

function nomenclature(index: number, sourceVersion = `v${index}`): OneCNomenclatureSnapshot {
  const key = index.toString(16).padStart(8, '0');
  return {
    sourceKind: '1C',
    subjectType: 'nomenclature',
    externalId: `${key}-1111-4111-8111-111111111111`,
    sourceVersion,
    staleness: 'fresh',
    capturedAt: AT,
    parsed: {
      code: String(index).padStart(9, '0'),
      article: null,
      name: `Сырье ${index}`,
      fullName: `Сырье ${index}`,
      kindExternalId: 'kind-raw',
      kindName: 'Сырье',
      unitExternalId: 'unit-kg',
      unitName: 'кг',
      deleted: false,
      archived: false,
    },
    rawPayload: { Ref_Key: `${key}-1111-4111-8111-111111111111`, safe: true },
  };
}

function counterparty(
  externalId = 'aaaaaaaa-1111-4111-8111-111111111111',
  sourceVersion = 'cp-v1',
): OneCCounterpartySnapshot {
  return {
    sourceKind: '1C',
    subjectType: 'counterparty',
    externalId,
    sourceVersion,
    staleness: 'fresh',
    capturedAt: AT,
    parsed: {
      displayName: 'ООО Точный контрагент',
      legalName: 'ООО «Точный контрагент»',
      inn: '1234567890',
      kpp: '123456789',
      code: '000000123',
    },
    rawPayload: { Ref_Key: externalId, safe: true },
  };
}

function organization(sourceVersion = 'org-v1'): OneCOrganizationSnapshot {
  return {
    sourceKind: '1C',
    subjectType: 'organization',
    externalId: 'bbbbbbbb-1111-4111-8111-111111111111',
    sourceVersion,
    staleness: 'fresh',
    capturedAt: AT,
    parsed: {
      code: '0001',
      name: 'Организация',
      fullName: 'ООО «Организация»',
      inn: '1234567890',
      kpp: '123456789',
      deleted: false,
    },
    rawPayload: { safe: true },
  };
}

function warehouse(sourceVersion = 'warehouse-v1'): OneCWarehouseSnapshot {
  return {
    sourceKind: '1C',
    subjectType: 'warehouse',
    externalId: 'cccccccc-1111-4111-8111-111111111111',
    sourceVersion,
    staleness: 'fresh',
    capturedAt: AT,
    parsed: {
      code: '000000001',
      name: 'Основной склад',
      warehouseType: 'ОптовыйСклад',
      deleted: false,
    },
    rawPayload: { safe: true },
  };
}

function invoice(sourceVersion = 'invoice-v1'): OneCInvoiceSnapshot {
  return {
    sourceKind: '1C',
    subjectType: 'invoice',
    externalId: 'dddddddd-1111-4111-8111-111111111111',
    sourceVersion,
    staleness: 'fresh',
    capturedAt: AT,
    parsed: {
      invoiceNo: 'СЧ-1',
      date: '2026-07-01T00:00:00',
      total: 100,
      currency: 'RUB',
      counterpartyExternalId: null,
      organizationExternalId: organization().externalId,
      posted: true,
      deleted: false,
    },
    rawPayload: { safe: true },
  };
}

function invoiceLine(): OneCInvoiceLineSource {
  return {
    invoiceExternalId: invoice().externalId!,
    parsed: {
      lineNumber: 1,
      nomenclatureExternalId: nomenclature(1).externalId,
      name: 'Сырье 1',
      quantity: 2,
      price: 50,
      amount: 100,
      unitExternalId: 'unit-kg',
    },
    rawPayload: { safe: true },
  };
}

function payment(externalId: string, invoiceExternalId: string | null): OneCPaymentSnapshot {
  return {
    sourceKind: '1C',
    subjectType: 'payment',
    externalId,
    sourceVersion: 'payment-v1',
    staleness: 'fresh',
    capturedAt: AT,
    parsed: {
      number: 'ПП-1',
      date: '2026-07-02T00:00:00',
      amount: 100,
      counterpartyExternalId: null,
      organizationExternalId: organization().externalId,
      documentBasisExternalId: invoice().externalId,
      documentBasisType: invoiceExternalId
        ? 'StandardODATA.Document_СчетНаОплатуПокупателю'
        : 'StandardODATA.Document_РеализацияТоваровУслуг',
      invoiceExternalId,
      posted: true,
      deleted: false,
    },
    rawPayload: { safe: true },
  };
}

function shipment(
  externalId = 'eeeeeeee-1111-4111-8111-111111111111',
  invoiceExternalId: string | null = invoice().externalId,
): OneCShipmentSnapshot {
  return {
    sourceKind: '1C',
    subjectType: 'shipment',
    externalId,
    sourceVersion: 'shipment-v1',
    staleness: 'fresh',
    capturedAt: AT,
    parsed: {
      number: 'РТУ-1',
      date: '2026-07-03T00:00:00',
      total: 100,
      counterpartyExternalId: null,
      organizationExternalId: organization().externalId,
      invoiceExternalId,
      posted: true,
      deleted: false,
    },
    rawPayload: { safe: true },
  };
}

function shipmentLine(): OneCShipmentLineSource {
  return {
    shipmentExternalId: shipment().externalId!,
    parsed: {
      lineNumber: 1,
      nomenclatureExternalId: nomenclature(1).externalId,
      name: null,
      quantity: 2,
      price: 50,
      amount: 100,
      unitExternalId: 'unit-kg',
    },
    rawPayload: { safe: true },
  };
}

function balance(accountCode: '10.01' | '41.01', quantity: number): OneCStockSnapshot {
  return {
    sourceKind: '1C',
    subjectType: 'stock',
    externalId: null,
    sourceVersion: null,
    staleness: 'fresh',
    capturedAt: AT,
    parsed: {
      account: `account-${accountCode}`,
      accountCode,
      organizationExternalId: organization().externalId,
      nomenclatureExternalId: nomenclature(1).externalId,
      qty: quantity,
      amount: quantity * 10,
      subconto: [nomenclature(1).externalId!],
    },
    rawPayload: { safe: true },
  };
}

function productionReport(sourceVersion = 'report-v1'): OneCProductionReportSnapshot {
  return {
    sourceKind: '1C',
    subjectType: 'production_report',
    externalId: REPORT_ID,
    sourceVersion,
    staleness: 'fresh',
    capturedAt: AT,
    parsed: {
      number: 'ОП-000001',
      date: '2026-07-29T05:00:00.000Z',
      posted: true,
      deleted: false,
      organizationExternalId: '44444444-4444-4444-8444-444444444444',
      warehouseExternalId: '55555555-5555-4555-8555-555555555555',
      departmentExternalId: '66666666-6666-4666-8666-666666666666',
    },
    rawPayload: {
      Ref_Key: REPORT_ID,
      DataVersion: sourceVersion,
      Number: 'ОП-000001',
    },
  };
}

function productionOutputLine(
  lineNumber: number,
  quantity: number,
  reportExternalId = REPORT_ID,
): OneCProductionOutputLineSource {
  return {
    reportExternalId,
    parsed: {
      lineNumber,
      nomenclatureExternalId: `77777777-7777-4777-8777-${String(lineNumber).padStart(12, '0')}`,
      unitExternalId: '88888888-8888-4888-8888-888888888888',
      unitName: 'кг',
      quantity,
    },
    rawPayload: { unsafeLinePayload: `output-${lineNumber}` },
  };
}

function productionMaterialLine(
  lineNumber: number,
  quantity: number,
  reportExternalId = REPORT_ID,
): OneCProductionMaterialLineSource {
  return {
    reportExternalId,
    parsed: {
      lineNumber,
      nomenclatureExternalId: `99999999-9999-4999-8999-${String(lineNumber).padStart(12, '0')}`,
      productExternalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      unitExternalId: '88888888-8888-4888-8888-888888888888',
      unitName: 'кг',
      quantity,
    },
    rawPayload: { unsafeLinePayload: `material-${lineNumber}` },
  };
}

function persistedProductionReport(
  report = productionReport(),
  outputLines = [productionOutputLine(1, -1.234567), productionOutputLine(2, 2.5)],
  materialLines = [productionMaterialLine(1, -3.75)],
) {
  return {
    externalId: report.externalId,
    sourceVersion: report.sourceVersion,
    number: report.parsed.number,
    date: new Date(report.parsed.date!),
    posted: report.parsed.posted,
    deleted: report.parsed.deleted,
    organizationExternalId: report.parsed.organizationExternalId,
    warehouseExternalId: report.parsed.warehouseExternalId,
    departmentExternalId: report.parsed.departmentExternalId,
    outputLines: outputLines.map((line) => ({
      reportExternalId: line.reportExternalId,
      ...line.parsed,
    })),
    materialLines: materialLines.map((line) => ({
      reportExternalId: line.reportExternalId,
      ...line.parsed,
    })),
  };
}

function createHarness(incoming: OneCNomenclatureSnapshot[] = [nomenclature(1)]) {
  const prisma: any = {
    oneCSyncRun: {
      create: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({
          id: `run-${prisma.oneCSyncRun.create.mock.calls.length}`,
          ...data,
          startedAt: new Date(AT),
        }),
      ),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    oneCNomenclatureItem: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    counterparty: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({ id: 'counterparty-created' }),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    oneCOrganization: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    oneCWarehouse: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    oneCInvoice: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    oneCInvoiceLine: {
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    oneCPayment: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    oneCShipment: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    oneCShipmentLine: {
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    oneCStockBalance: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    oneCProductionReport: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({}),
    },
    oneCProductionOutputLine: {
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    oneCProductionMaterialLine: {
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    rawMaterialStock: {
      findUnique: jest.fn().mockResolvedValue({ actualQty: 320 }),
      update: jest.fn(),
    },
    rawMaterialDefinition: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({
          id: `raw-${prisma.rawMaterialDefinition.create.mock.calls.length}`,
          ...data,
        }),
      ),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    sourceSnapshot: {
      create: jest.fn().mockResolvedValue({ id: 'snapshot-1' }),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  prisma.$transaction = jest
    .fn()
    .mockImplementation((callback: (tx: any) => unknown) => callback(prisma));

  const audit = { record: jest.fn().mockResolvedValue({}) };
  const adapter: any = {
    stockPushConfiguration: jest.fn().mockReturnValue({ mode: 'http', enabled: false }),
    checkHealth: jest.fn().mockResolvedValue({
      mode: 'http',
      status: 'ready',
      checkedAt: AT,
      latencyMs: 1,
    }),
    pullNomenclature: jest
      .fn()
      .mockImplementation(({ skip = 0 }: { skip?: number } = {}) =>
        Promise.resolve(skip === 0 ? incoming : []),
      ),
    pullCounterparties: jest.fn().mockResolvedValue([]),
    pullOrganizations: jest.fn().mockResolvedValue([]),
    pullWarehouses: jest.fn().mockResolvedValue([]),
    pullInvoices: jest.fn().mockResolvedValue([]),
    pullInvoiceLines: jest.fn().mockResolvedValue([]),
    pullPayments: jest.fn().mockResolvedValue([]),
    pullShipments: jest.fn().mockResolvedValue([]),
    pullShipmentLines: jest.fn().mockResolvedValue([]),
    pullProductionReports: jest.fn().mockResolvedValue([]),
    pullProductionOutputLines: jest.fn().mockResolvedValue([]),
    pullProductionMaterialLines: jest.fn().mockResolvedValue([]),
    pullBalances: jest.fn().mockResolvedValue([]),
  };

  return {
    prisma,
    audit,
    adapter,
    service: new OneCSyncService(prisma, audit as any, adapter),
  };
}

describe('OneCSyncService', () => {
  it('reads all stable pages at offsets 0, 250 and 500', async () => {
    const { service } = createHarness([]);
    const readPage = jest
      .fn()
      .mockResolvedValueOnce(Array.from({ length: 250 }, (_, index) => nomenclature(index)))
      .mockResolvedValueOnce(Array.from({ length: 250 }, (_, index) => nomenclature(index + 250)))
      .mockResolvedValueOnce([nomenclature(500)]);

    const result = await service.fetchAll(readPage);

    expect(result).toHaveLength(501);
    expect(readPage.mock.calls.map(([options]) => options.skip)).toEqual([0, 250, 500]);
  });

  it('uses the validated runtime page size for every stable page', async () => {
    const service = new OneCSyncService(
      {} as never,
      {} as never,
      {} as never,
      { onecSyncPageSize: 100 } as never,
    );
    const readPage = jest
      .fn()
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, index) => nomenclature(index)))
      .mockResolvedValueOnce([nomenclature(100)]);

    await service.fetchAll(readPage);

    expect(readPage.mock.calls.map(([options]) => options)).toEqual([
      { top: 100, skip: 0 },
      { top: 100, skip: 100 },
    ]);
  });

  it('rejects a duplicate externalId across page boundaries', async () => {
    const { service } = createHarness([]);
    const first = Array.from({ length: 250 }, (_, index) => nomenclature(index));
    const readPage = jest.fn().mockResolvedValueOnce(first).mockResolvedValueOnce([first[0]]);

    await expect(service.fetchAll(readPage)).rejects.toThrow(/ONEC_DUPLICATE_EXTERNAL_ID/);
  });

  it('preview computes a diff and writes only run/audit facts', async () => {
    const { service, prisma, audit } = createHarness([nomenclature(1)]);

    const result = await service.run(ACTOR, 'preview');

    expect(result.status).toBe('completed');
    expect(result.counters.nomenclature).toMatchObject({ created: 1, fetched: 1 });
    expect(prisma.oneCNomenclatureItem.upsert).not.toHaveBeenCalled();
    expect(prisma.rawMaterialDefinition.create).not.toHaveBeenCalled();
    expect(prisma.sourceSnapshot.createMany).not.toHaveBeenCalled();
    expect(prisma.oneCNomenclatureItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.oneCNomenclatureItem.deleteMany).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:onec_sync_previewed',
        detail: expect.objectContaining({ runId: expect.any(String) }),
      }),
    );
  });

  it('releases the active sync lock when the start audit write fails', async () => {
    const { service, prisma, audit, adapter } = createHarness([]);
    audit.record.mockRejectedValueOnce(new Error('audit unavailable')).mockResolvedValueOnce({});

    await expect(service.run(ACTOR, 'apply')).rejects.toThrow('audit unavailable');

    expect(adapter.checkHealth).not.toHaveBeenCalled();
    expect(prisma.oneCSyncRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: expect.objectContaining({
        status: 'failed',
        activeScopeKey: null,
        errorCode: 'ONEC_SYNC_FAILED',
      }),
    });
  });

  it('applies nomenclature idempotently and never writes physical stock quantity', async () => {
    const incoming = [nomenclature(1), nomenclature(2)];
    const { service, prisma } = createHarness(incoming);
    prisma.oneCNomenclatureItem.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce(
      incoming.map((snapshot) => ({
        externalId: snapshot.externalId,
        sourceVersion: snapshot.sourceVersion,
      })),
    );

    const first = await service.run(ACTOR, 'apply');
    const second = await service.run(ACTOR, 'apply');

    expect(first.counters.nomenclature).toMatchObject({ created: 2, unchanged: 0 });
    expect(second.counters.nomenclature).toMatchObject({ created: 0, unchanged: 2 });
    expect(prisma.sourceSnapshot.createMany).toHaveBeenCalledTimes(2);
    expect(prisma.sourceSnapshot.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(prisma.oneCNomenclatureItem.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.rawMaterialDefinition.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'custom', isProductionSelectable: true }),
      }),
    );
    expect(prisma.rawMaterialDefinition.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ actualQty: expect.anything() }) }),
    );
  });

  it('projects duplicate 1C raw-material names with exact display names and stable internal keys', async () => {
    const first = nomenclature(1);
    const duplicateName = nomenclature(2);
    first.parsed.name = 'С'.repeat(120);
    first.parsed.fullName = first.parsed.name;
    duplicateName.parsed.name = first.parsed.name;
    duplicateName.parsed.fullName = first.parsed.fullName;
    const { service, prisma } = createHarness([first, duplicateName]);
    prisma.rawMaterialDefinition.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'raw-1', externalId: first.externalId });

    const result = await service.run(ACTOR, 'apply');

    expect(result.counters.nomenclature).toMatchObject({ conflicts: 0 });
    expect(prisma.oneCNomenclatureItem.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.rawMaterialDefinition.create).toHaveBeenCalledTimes(2);
    const suffix = ` · 1c:${duplicateName.externalId}`;
    const expectedNormalizedName = `${'с'.repeat(120 - suffix.length)}${suffix}`;
    expect(prisma.rawMaterialDefinition.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: first.parsed.name,
          normalizedName: expectedNormalizedName,
        }),
      }),
    );
    expect(expectedNormalizedName).toHaveLength(120);
  });

  it('repairs an unchanged raw nomenclature mirror that has no material projection', async () => {
    const snapshot = nomenclature(1);
    const { service, prisma } = createHarness([snapshot]);
    prisma.oneCNomenclatureItem.findMany.mockResolvedValue([
      {
        externalId: snapshot.externalId,
        sourceVersion: snapshot.sourceVersion,
        rawMaterialDefinitionId: null,
      },
    ]);

    const result = await service.run(ACTOR, 'apply');

    expect(result.counters.nomenclature).toMatchObject({ unchanged: 1 });
    expect(prisma.rawMaterialDefinition.create).toHaveBeenCalledTimes(1);
  });

  it('projects unchanged account 10.01 nomenclature as raw material regardless of 1C kind', async () => {
    const product = nomenclature(3);
    product.parsed.kindName = 'Товары';
    const accountingBalance = balance('10.01', 125);
    accountingBalance.parsed.nomenclatureExternalId = product.externalId;
    accountingBalance.parsed.subconto = [product.externalId!];
    const { service, prisma, adapter } = createHarness([product]);
    prisma.oneCNomenclatureItem.findMany.mockResolvedValue([
      {
        externalId: product.externalId,
        sourceVersion: product.sourceVersion,
        rawMaterialDefinitionId: null,
      },
    ]);
    adapter.pullBalances.mockImplementation((accountCode: '10.01' | '41.01') =>
      Promise.resolve(accountCode === '10.01' ? [accountingBalance] : []),
    );

    const result = await service.run(ACTOR, 'apply');

    expect(result.counters.nomenclature).toMatchObject({ unchanged: 1 });
    expect(prisma.rawMaterialDefinition.create).toHaveBeenCalledTimes(1);
    expect(prisma.rawMaterialDefinition.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          externalId: product.externalId,
          name: product.parsed.name,
        }),
      }),
    );
  });

  it('keeps non-raw nomenclature in the mirror without touching the raw-material domain', async () => {
    const product = nomenclature(3);
    product.parsed.kindName = 'Товар';
    const { service, prisma } = createHarness([product]);

    await service.run(ACTOR, 'apply');

    expect(prisma.oneCNomenclatureItem.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.rawMaterialDefinition.findUnique).not.toHaveBeenCalled();
    expect(prisma.rawMaterialDefinition.create).not.toHaveBeenCalled();
    expect(prisma.rawMaterialDefinition.update).not.toHaveBeenCalled();
  });

  it('updates only source-owned counterparty fields on exact externalId', async () => {
    const { service, prisma, adapter } = createHarness([]);
    const snapshot = counterparty();
    adapter.pullCounterparties.mockResolvedValue([snapshot]);
    prisma.counterparty.findMany.mockResolvedValue([
      {
        id: 'counterparty-1',
        externalId: snapshot.externalId,
        sourceVersion: 'cp-old',
        inn: 'old',
        kpp: null,
      },
    ]);

    await service.run(ACTOR, 'apply');

    const data = prisma.counterparty.update.mock.calls[0][0].data;
    expect(data).toEqual({
      displayName: snapshot.parsed.displayName,
      legalName: snapshot.parsed.legalName,
      inn: snapshot.parsed.inn,
      kpp: snapshot.parsed.kpp,
      sourceCode: snapshot.parsed.code,
      billingSource: '1C',
      syncStatus: 'ready',
      externalId: snapshot.externalId,
      sourceVersion: snapshot.sourceVersion,
    });
    expect(JSON.stringify(data)).not.toMatch(/contact|bank|passport|personal/i);
  });

  it('binds one exact unbound INN+KPP match instead of creating a duplicate', async () => {
    const { service, prisma, adapter } = createHarness([]);
    const snapshot = counterparty();
    adapter.pullCounterparties.mockResolvedValue([snapshot]);
    prisma.counterparty.findMany.mockResolvedValue([
      {
        id: 'manual-counterparty',
        externalId: null,
        sourceVersion: null,
        inn: snapshot.parsed.inn,
        kpp: snapshot.parsed.kpp,
      },
    ]);

    await service.run(ACTOR, 'apply');

    expect(prisma.counterparty.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'manual-counterparty' } }),
    );
    expect(prisma.counterparty.create).not.toHaveBeenCalled();
  });

  it('records an ambiguous INN+KPP as conflict and updates neither candidate', async () => {
    const { service, prisma, adapter, audit } = createHarness([]);
    const snapshot = counterparty();
    adapter.pullCounterparties.mockResolvedValue([snapshot]);
    prisma.counterparty.findMany.mockResolvedValue([
      {
        id: 'candidate-1',
        externalId: null,
        sourceVersion: null,
        inn: snapshot.parsed.inn,
        kpp: snapshot.parsed.kpp,
      },
      {
        id: 'candidate-2',
        externalId: null,
        sourceVersion: null,
        inn: snapshot.parsed.inn,
        kpp: snapshot.parsed.kpp,
      },
    ]);

    const result = await service.run(ACTOR, 'apply');

    expect(result.counters.counterparty?.conflicts).toBe(1);
    expect(prisma.counterparty.update).not.toHaveBeenCalled();
    expect(prisma.counterparty.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'problem:onec_mapping_conflict',
        detail: expect.objectContaining({
          counters: expect.objectContaining({
            counterparty: expect.objectContaining({ conflicts: 1 }),
          }),
        }),
      }),
    );
  });

  it('creates a counterparty when no stable identity match exists', async () => {
    const { service, prisma, adapter } = createHarness([]);
    adapter.pullCounterparties.mockResolvedValue([counterparty()]);

    await service.run(ACTOR, 'apply');

    expect(prisma.counterparty.create).toHaveBeenCalledTimes(1);
  });

  it('applies organization and warehouse catalogs idempotently', async () => {
    const { service, prisma, adapter } = createHarness([]);
    const org = organization();
    const storage = warehouse();
    adapter.pullOrganizations.mockResolvedValue([org]);
    adapter.pullWarehouses.mockResolvedValue([storage]);
    prisma.oneCOrganization.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ externalId: org.externalId, sourceVersion: org.sourceVersion }]);
    prisma.oneCWarehouse.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { externalId: storage.externalId, sourceVersion: storage.sourceVersion },
      ]);

    const first = await service.run(ACTOR, 'apply');
    const second = await service.run(ACTOR, 'apply');

    expect(first.counters.organization).toMatchObject({ created: 1, unchanged: 0 });
    expect(first.counters.warehouse).toMatchObject({ created: 1, unchanged: 0 });
    expect(second.counters.organization).toMatchObject({ created: 0, unchanged: 1 });
    expect(second.counters.warehouse).toMatchObject({ created: 0, unchanged: 1 });
    expect(prisma.oneCOrganization.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.oneCWarehouse.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.sourceSnapshot.createMany).toHaveBeenCalledTimes(2);
  });

  it('upserts invoice and shipment lines by their compound document line identity', async () => {
    const { service, prisma, adapter } = createHarness([nomenclature(1)]);
    adapter.pullInvoices.mockResolvedValue([invoice()]);
    adapter.pullInvoiceLines.mockResolvedValue([invoiceLine()]);
    adapter.pullShipments.mockResolvedValue([shipment()]);
    adapter.pullShipmentLines.mockResolvedValue([shipmentLine()]);

    await service.run(ACTOR, 'apply');

    expect(prisma.oneCInvoiceLine.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          invoiceExternalId_lineNumber: {
            invoiceExternalId: invoice().externalId,
            lineNumber: 1,
          },
        },
      }),
    );
    expect(prisma.oneCShipmentLine.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          shipmentExternalId_lineNumber: {
            shipmentExternalId: shipment().externalId,
            lineNumber: 1,
          },
        },
      }),
    );
  });

  it('replaces changed invoice lines transactionally and skips an unchanged rerun', async () => {
    const { service, prisma, adapter } = createHarness([]);
    const line = invoiceLine();
    line.parsed.nomenclatureExternalId = null;
    adapter.pullInvoiceLines.mockResolvedValue([line]);
    adapter.pullInvoices
      .mockResolvedValueOnce([invoice('invoice-v1')])
      .mockResolvedValueOnce([invoice('invoice-v2')])
      .mockResolvedValueOnce([invoice('invoice-v2')]);
    prisma.oneCInvoice.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ externalId: invoice().externalId, sourceVersion: 'invoice-v1' }])
      .mockResolvedValueOnce([{ externalId: invoice().externalId, sourceVersion: 'invoice-v2' }]);

    await service.run(ACTOR, 'apply');
    await service.run(ACTOR, 'apply');
    const unchanged = await service.run(ACTOR, 'apply');

    expect(unchanged.counters.invoice).toMatchObject({ updated: 0, unchanged: 1 });
    expect(prisma.oneCInvoiceLine.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.oneCInvoiceLine.deleteMany).toHaveBeenCalledTimes(2);
    expect(prisma.sourceSnapshot.createMany).toHaveBeenCalledTimes(2);
  });

  it('persists only exact existing invoice GUID links for payments and shipments', async () => {
    const { service, prisma, adapter } = createHarness([]);
    const linkedPayment = payment('ffffffff-1111-4111-8111-111111111111', invoice().externalId);
    const unlinkedPayment = payment('11111111-2222-4222-8222-222222222222', null);
    adapter.pullInvoices.mockResolvedValue([invoice()]);
    adapter.pullPayments.mockResolvedValue([linkedPayment, unlinkedPayment]);
    adapter.pullShipments.mockResolvedValue([
      shipment(),
      shipment('22222222-2222-4222-8222-222222222222', '99999999-9999-4999-8999-999999999999'),
    ]);

    await service.run(ACTOR, 'apply');

    const paymentLinks = prisma.oneCPayment.upsert.mock.calls.map(
      ([call]: any[]) => call.create.invoiceExternalId,
    );
    const shipmentLinks = prisma.oneCShipment.upsert.mock.calls.map(
      ([call]: any[]) => call.create.invoiceExternalId,
    );
    expect(paymentLinks).toEqual([invoice().externalId, null]);
    expect(shipmentLinks).toEqual([invoice().externalId, null]);
  });

  it('stores accounting quantities separately and preserves negative balances', async () => {
    const { service, prisma, adapter } = createHarness([nomenclature(1)]);
    adapter.pullOrganizations.mockResolvedValue([organization()]);
    adapter.pullBalances.mockImplementation((accountCode: '10.01' | '41.01') =>
      Promise.resolve([
        accountCode === '10.01' ? balance(accountCode, 250) : balance(accountCode, -5),
      ]),
    );

    await service.run(ACTOR, 'apply');

    const quantities = prisma.oneCStockBalance.upsert.mock.calls.map(
      ([call]: any[]) => call.create.quantity,
    );
    expect(quantities).toEqual([250, -5]);
    expect(prisma.rawMaterialStock.findUnique).not.toHaveBeenCalled();
    expect(prisma.rawMaterialStock.update).not.toHaveBeenCalled();
  });

  it('previews production diffs without mutating the mirror or source snapshots', async () => {
    const { service, prisma, adapter } = createHarness([]);
    adapter.pullProductionReports.mockResolvedValue([productionReport()]);
    adapter.pullProductionOutputLines.mockResolvedValue([productionOutputLine(1, -1.234567)]);
    adapter.pullProductionMaterialLines.mockResolvedValue([productionMaterialLine(1, -3.75)]);

    const result = await service.run(ACTOR, 'preview');

    expect(result.counters.production_report).toEqual({
      fetched: 1,
      created: 1,
      updated: 0,
      unchanged: 0,
      conflicts: 0,
    });
    expect(result.counters.production_output_line).toMatchObject({
      fetched: 1,
      created: 1,
      conflicts: 0,
    });
    expect(result.counters.production_material_line).toMatchObject({
      fetched: 1,
      created: 1,
      conflicts: 0,
    });
    expect(prisma.oneCProductionReport.upsert).not.toHaveBeenCalled();
    expect(prisma.oneCProductionOutputLine.upsert).not.toHaveBeenCalled();
    expect(prisma.oneCProductionMaterialLine.upsert).not.toHaveBeenCalled();
    expect(prisma.sourceSnapshot.createMany).not.toHaveBeenCalled();
  });

  it('replaces changed report lines transactionally and is idempotent', async () => {
    const report = productionReport();
    const outputLines = [productionOutputLine(1, -1.234567), productionOutputLine(2, 2.5)];
    const materialLines = [productionMaterialLine(1, -3.75)];
    const { service, prisma, adapter } = createHarness([]);
    adapter.pullProductionReports.mockResolvedValue([report]);
    adapter.pullProductionOutputLines.mockResolvedValue(outputLines);
    adapter.pullProductionMaterialLines.mockResolvedValue(materialLines);
    prisma.oneCProductionReport.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([persistedProductionReport(report, outputLines, materialLines)]);

    const first = await service.run(ACTOR, 'apply');
    const second = await service.run(ACTOR, 'apply');

    expect(first.counters.production_report).toMatchObject({ created: 1, unchanged: 0 });
    expect(second.counters.production_report).toMatchObject({ created: 0, unchanged: 1 });
    expect(prisma.oneCProductionReport.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.oneCProductionOutputLine.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.oneCProductionOutputLine.deleteMany).toHaveBeenCalledWith({
      where: { reportExternalId: REPORT_ID, lineNumber: { notIn: [1, 2] } },
    });
    expect(prisma.oneCProductionMaterialLine.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.sourceSnapshot.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    const snapshot = prisma.sourceSnapshot.createMany.mock.calls[0][0].data;
    expect(snapshot.subjectType).toBe('production_report');
    expect(snapshot.rawPayload).toEqual(report.rawPayload);
    expect(snapshot.parsed).toMatchObject({
      outputLines: outputLines.map((line) => line.parsed),
      materialLines: materialLines.map((line) => line.parsed),
    });
    expect(JSON.stringify(snapshot)).not.toContain('unsafeLinePayload');
  });

  it('keeps a production transaction alive beyond the Prisma default timeout', async () => {
    const { service, prisma, adapter } = createHarness([]);
    adapter.pullProductionReports.mockResolvedValue([productionReport()]);
    adapter.pullProductionOutputLines.mockResolvedValue([productionOutputLine(1, 1)]);
    adapter.pullProductionMaterialLines.mockResolvedValue([productionMaterialLine(1, 1)]);
    prisma.$transaction.mockImplementation(
      (
        callback: (tx: typeof prisma) => unknown,
        options?: { timeout?: number },
      ): Promise<unknown> => {
        if (!options?.timeout || options.timeout < 60_000) {
          return Promise.reject(new Error('P2028: interactive transaction expired'));
        }
        return Promise.resolve(callback(prisma));
      },
    );

    await expect(service.run(ACTOR, 'apply')).resolves.toMatchObject({
      mode: 'apply',
      status: 'completed',
    });
  });

  it('updates the parent when exact line content changes or a line disappears', async () => {
    const report = productionReport();
    const currentOutput = [productionOutputLine(1, 1), productionOutputLine(2, 2)];
    const currentMaterial = [productionMaterialLine(1, 3), productionMaterialLine(2, 4)];
    const incomingOutput = [productionOutputLine(1, 1.000001), productionOutputLine(2, 2)];
    const incomingMaterial = [productionMaterialLine(1, 3)];
    const { service, prisma, adapter } = createHarness([]);
    adapter.pullProductionReports.mockResolvedValue([report]);
    adapter.pullProductionOutputLines.mockResolvedValue(incomingOutput);
    adapter.pullProductionMaterialLines.mockResolvedValue(incomingMaterial);
    prisma.oneCProductionReport.findMany.mockResolvedValue([
      persistedProductionReport(report, currentOutput, currentMaterial),
    ]);

    const result = await service.run(ACTOR, 'apply');

    expect(result.counters.production_report).toMatchObject({ updated: 1, unchanged: 0 });
    expect(result.counters.production_output_line).toMatchObject({
      fetched: 2,
      updated: 1,
      unchanged: 1,
    });
    expect(result.counters.production_material_line).toMatchObject({
      fetched: 1,
      updated: 0,
      unchanged: 1,
    });
    expect(prisma.oneCProductionMaterialLine.deleteMany).toHaveBeenCalledWith({
      where: { reportExternalId: REPORT_ID, lineNumber: { notIn: [1] } },
    });
  });

  it('counts orphan production lines as conflicts and never persists them', async () => {
    const orphanReportId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const { service, prisma, adapter } = createHarness([]);
    adapter.pullProductionOutputLines.mockResolvedValue([
      productionOutputLine(1, 2, orphanReportId),
    ]);
    adapter.pullProductionMaterialLines.mockResolvedValue([
      productionMaterialLine(1, -2, orphanReportId),
    ]);

    const result = await service.run(ACTOR, 'apply');

    expect(result.counters.production_output_line).toEqual({
      fetched: 1,
      created: 0,
      updated: 0,
      unchanged: 0,
      conflicts: 1,
    });
    expect(result.counters.production_material_line).toEqual({
      fetched: 1,
      created: 0,
      updated: 0,
      unchanged: 0,
      conflicts: 1,
    });
    expect(prisma.oneCProductionOutputLine.upsert).not.toHaveBeenCalled();
    expect(prisma.oneCProductionMaterialLine.upsert).not.toHaveBeenCalled();
    expect(prisma.sourceSnapshot.createMany).not.toHaveBeenCalled();
  });

  it('preserves signed finite production quantities without touching physical stock', async () => {
    const { service, prisma, adapter } = createHarness([]);
    adapter.pullProductionReports.mockResolvedValue([productionReport()]);
    adapter.pullProductionOutputLines.mockResolvedValue([productionOutputLine(1, -0.000001)]);
    adapter.pullProductionMaterialLines.mockResolvedValue([productionMaterialLine(1, 0.000001)]);

    await service.run(ACTOR, 'apply');

    expect(prisma.oneCProductionOutputLine.upsert.mock.calls[0][0].create.quantity).toBe(
      '-0.000001',
    );
    expect(prisma.oneCProductionMaterialLine.upsert.mock.calls[0][0].create.quantity).toBe(
      '0.000001',
    );
    expect(prisma.rawMaterialStock.update).not.toHaveBeenCalled();
  });

  it.each([
    ['output scale', 'output', 0.0000001],
    ['material range', 'material', 1_000_000_000_000],
    ['negative range', 'output', -1_000_000_000_000],
    ['NaN', 'output', Number.NaN],
    ['Infinity', 'material', Number.POSITIVE_INFINITY],
  ] as const)(
    'rejects non-representable production quantity %s before mirror mutation',
    async (_case, stream, quantity) => {
      const { service, prisma, adapter } = createHarness([]);
      adapter.pullProductionReports.mockResolvedValue([productionReport()]);
      if (stream === 'output') {
        adapter.pullProductionOutputLines.mockResolvedValue([productionOutputLine(1, quantity)]);
      } else {
        adapter.pullProductionMaterialLines.mockResolvedValue([
          productionMaterialLine(1, quantity),
        ]);
      }

      await expect(service.run(ACTOR, 'apply')).rejects.toThrow('ONEC_INVALID_PRODUCTION_QUANTITY');

      expect(prisma.oneCProductionReport.upsert).not.toHaveBeenCalled();
      expect(prisma.oneCProductionOutputLine.upsert).not.toHaveBeenCalled();
      expect(prisma.oneCProductionMaterialLine.upsert).not.toHaveBeenCalled();
      expect(prisma.sourceSnapshot.createMany).not.toHaveBeenCalled();
    },
  );

  it('persists canonical zero and treats equivalent representable forms as unchanged', async () => {
    const report = productionReport();
    const negativeZero = productionOutputLine(1, -0);
    const persisted = persistedProductionReport(report, [productionOutputLine(1, 0)], []);
    const { service, prisma, adapter } = createHarness([]);
    adapter.pullProductionReports.mockResolvedValue([report]);
    adapter.pullProductionOutputLines.mockResolvedValue([negativeZero]);
    prisma.oneCProductionReport.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        ...persisted,
        outputLines: persisted.outputLines.map((line) => ({
          ...line,
          quantity: new Prisma.Decimal('0.000000'),
        })),
      },
    ]);

    await service.run(ACTOR, 'apply');
    const unchanged = await service.run(ACTOR, 'apply');

    expect(prisma.oneCProductionOutputLine.upsert.mock.calls[0][0].create.quantity).toBe('0');
    expect(unchanged.counters.production_report).toMatchObject({ updated: 0, unchanged: 1 });
    expect(unchanged.counters.production_output_line).toMatchObject({
      updated: 0,
      unchanged: 1,
    });
    expect(prisma.oneCProductionReport.upsert).toHaveBeenCalledTimes(1);
  });

  it('appends a distinct snapshot for every A to B to A report change only', async () => {
    const report = productionReport();
    const lineA = productionOutputLine(1, 1);
    const lineB = productionOutputLine(1, 2);
    const { service, prisma, adapter } = createHarness([]);
    adapter.pullProductionReports.mockResolvedValue([report]);
    adapter.pullProductionOutputLines
      .mockResolvedValueOnce([lineA])
      .mockResolvedValueOnce([lineB])
      .mockResolvedValueOnce([lineA])
      .mockResolvedValueOnce([lineA]);
    prisma.oneCProductionReport.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([persistedProductionReport(report, [lineA], [])])
      .mockResolvedValueOnce([persistedProductionReport(report, [lineB], [])])
      .mockResolvedValueOnce([persistedProductionReport(report, [lineA], [])]);

    await service.run(ACTOR, 'apply');
    await service.run(ACTOR, 'apply');
    await service.run(ACTOR, 'apply');
    const unchanged = await service.run(ACTOR, 'apply');

    const snapshotFingerprints = prisma.sourceSnapshot.createMany.mock.calls.map(
      ([call]: [{ data: { sourceFingerprint: string } }]) => call.data.sourceFingerprint,
    );
    expect(snapshotFingerprints).toHaveLength(3);
    expect(new Set(snapshotFingerprints)).toHaveProperty('size', 3);
    expect(unchanged.counters.production_report).toMatchObject({ updated: 0, unchanged: 1 });
  });
});

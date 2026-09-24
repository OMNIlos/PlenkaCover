import { MockOneCAdapter } from './mock-onec.adapter';

describe('MockOneCAdapter (full contract, deterministic)', () => {
  const mock = new MockOneCAdapter();

  it('pullCounterparties reconciles with the seed by externalId (УралПак)', async () => {
    const snaps = await mock.pullCounterparties();
    const uralpak = snaps.find((s) => s.externalId === 'mock-counterparty-uralpak');
    expect(uralpak).toBeDefined();
    expect(uralpak!.subjectType).toBe('counterparty');
    expect(uralpak!.sourceKind).toBe('mock_1C');
    expect(uralpak!.parsed.displayName).toBe('УралПак');
    expect(uralpak!.staleness).toBe('fresh');
    expect(uralpak!.sourceVersion).toBeTruthy();
  });

  it('is deterministic (same externalIds across calls)', async () => {
    const a = (await mock.pullCounterparties()).map((s) => s.externalId);
    const b = (await mock.pullCounterparties()).map((s) => s.externalId);
    expect(a).toEqual(b);
  });

  it('pullCounterparty returns a single snapshot for a known externalId', async () => {
    const snap = await mock.pullCounterparty('mock-counterparty-uralpak');
    expect(snap.externalId).toBe('mock-counterparty-uralpak');
    expect(snap.parsed.inn).toBe('6600000000');
  });

  it('pullInvoice stays back-compatible (СЧ-<ref>, subjectType invoice)', async () => {
    const snap = await mock.pullInvoice('A-1024');
    expect(snap.sourceKind).toBe('mock_1C');
    expect(snap.subjectType).toBe('invoice');
    expect(snap.parsed.invoiceNo).toBe('СЧ-A-1024');
    expect(snap.parsed.total).toBe(150000);
    expect(snap.parsed.currency).toBe('RUB');
    expect(snap.rawPayload).toBeDefined();
  });

  it('finds a deterministic invoice only by the exact platform order marker', async () => {
    const candidates = await mock.findInvoicesByOrderReference('PLENKA_ORDER=ЗК-0042');

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      subjectType: 'invoice',
      parsed: {
        orderReference: 'PLENKA_ORDER=ЗК-0042',
        invoiceNo: 'СЧ-ЗК-0042',
        posted: true,
        total: 150000,
      },
    });
    await expect(mock.findInvoicesByOrderReference('ЗК-0042')).resolves.toEqual([]);
  });

  it('pulls the exact invoice and payment by external Ref_Key', async () => {
    const [candidate] = await mock.findInvoicesByOrderReference('PLENKA_ORDER=ЗК-0042');

    await expect(mock.pullInvoiceByExternalId(candidate.externalId!)).resolves.toMatchObject({
      externalId: candidate.externalId,
      parsed: { lines: [expect.objectContaining({ amount: 150000 })] },
    });
    const [payment] = await mock.pullPayments();
    await expect(mock.pullPaymentByExternalId(payment.externalId!)).resolves.toMatchObject({
      externalId: payment.externalId,
    });
  });

  it('finds invoices by exact number without fuzzy matching', async () => {
    await expect(mock.findInvoicesByExactNumber('СЧ-ЗК-0042')).resolves.toHaveLength(1);
    await expect(mock.findInvoicesByExactNumber('ЗК-0042')).resolves.toEqual([]);
  });

  it('pullPayments / pullShipments / pullStock return typed snapshots', async () => {
    expect((await mock.pullPayments())[0].subjectType).toBe('payment');
    expect((await mock.pullShipments())[0].subjectType).toBe('shipment');
    const stock = await mock.pullStock();
    expect(stock.find((s) => s.externalId === 'mock-stock-rm-pvd-15803')).toBeDefined();
  });

  it('returns deterministic fixtures for every production read catalog', async () => {
    expect((await mock.pullNomenclature())[0].parsed).toMatchObject({
      name: 'ПВД 15803-020',
      kindName: 'Сырье',
      unitName: 'кг',
    });
    expect((await mock.pullOrganizations())[0].subjectType).toBe('organization');
    expect((await mock.pullWarehouses())[0].subjectType).toBe('warehouse');
    expect((await mock.pullInvoices())[0].subjectType).toBe('invoice');
    expect((await mock.pullBalances('10.01'))[0].parsed.accountCode).toBe('10.01');
  });

  it('returns stable paged production reports with kg and шт output lines', async () => {
    const reports = await mock.pullProductionReports({ top: 1, skip: 0 });
    const outputLines = await mock.pullProductionOutputLines({ top: 2, skip: 0 });
    const materialLines = await mock.pullProductionMaterialLines({ top: 1, skip: 0 });

    expect(reports).toMatchObject([
      {
        subjectType: 'production_report',
        parsed: { posted: true, deleted: false, date: '2026-07-01T10:00:00.000Z' },
      },
    ]);
    expect(outputLines.map((line) => line.parsed.unitName)).toEqual(['кг', 'шт']);
    expect(materialLines).toMatchObject([
      {
        parsed: { unitName: 'кг', productExternalId: outputLines[0].parsed.nomenclatureExternalId },
      },
    ]);
    await expect(mock.pullProductionOutputLines({ top: 1, skip: 1 })).resolves.toHaveLength(1);
  });

  it('pushStock never represents a mock intent as a created 1C document', async () => {
    expect(mock.stockPushConfiguration()).toEqual({ mode: 'mock', enabled: false });
    const ack = await mock.pushStock([{ materialId: 'rm-pvd-15803', qty: 320, unit: 'кг' }]);
    expect(ack).toMatchObject({
      accepted: false,
      mode: 'mock',
      documentCreated: false,
      count: 1,
    });
    expect(ack.ref).toContain('mock');
  });

  it('reports deterministic safe connection health', async () => {
    const result = await mock.checkHealth();
    expect(result).toMatchObject({ mode: 'mock', status: 'ready' });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(() => new Date(result.checkedAt).toISOString()).not.toThrow();
    expect(JSON.stringify(result)).not.toMatch(/password|authorization|token/i);
  });
});

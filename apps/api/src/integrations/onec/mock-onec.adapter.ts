import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  OneCCounterpartySnapshot,
  OneCInvoiceLineSource,
  OneCInvoiceSnapshot,
  OneCHealthResult,
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
import type {
  OneCAdapter,
  OneCListOptions,
  OneCStockItem,
  OneCStockPushAck,
  OneCStockPushConfiguration,
} from './onec.adapter';

/**
 * Deterministic mock 1С (ТЗ §11.8 mock-first). Full read contract + the one write (`pushStock`).
 * externalIds are stable `mock-<subject>-<key>` values that MATCH the seed (Task 9) so the mock
 * reconciles with our demo entities. `rawPayload` is a clearly-marked mock stub (admin-only, ТЗ §8).
 * NOT a production sync — real 1С needs discovery, access and a test environment first.
 */
@Injectable()
export class MockOneCAdapter implements OneCAdapter {
  private readonly now = () => new Date().toISOString();
  private readonly exactInvoices = new Map<string, OneCInvoiceSnapshot>();

  stockPushConfiguration(): OneCStockPushConfiguration {
    return { mode: 'mock', enabled: false };
  }

  async checkHealth(): Promise<OneCHealthResult> {
    const startedAt = Date.now();
    return {
      mode: 'mock',
      status: 'ready',
      checkedAt: this.now(),
      latencyMs: Date.now() - startedAt,
      endpointLabel: 'mock_1C',
    };
  }

  async pullCounterparties(_opts?: OneCListOptions): Promise<OneCCounterpartySnapshot[]> {
    return [
      this.counterparty('mock-counterparty-uralpak', {
        displayName: 'УралПак',
        legalName: 'ООО «УралПак»',
        inn: '6600000000',
        kpp: null,
        code: '000000001',
      }),
    ];
  }

  async pullCounterparty(externalId: string): Promise<OneCCounterpartySnapshot> {
    const all = await this.pullCounterparties();
    return (
      all.find((s) => s.externalId === externalId) ??
      this.counterparty(externalId, {
        displayName: `Контрагент ${externalId}`,
        legalName: null,
        inn: null,
        kpp: null,
        code: null,
      })
    );
  }

  async pullNomenclature(_opts?: OneCListOptions): Promise<OneCNomenclatureSnapshot[]> {
    return [
      {
        sourceKind: 'mock_1C',
        subjectType: 'nomenclature',
        externalId: 'mock-nomenclature-pvd-15803',
        sourceVersion: 'v1',
        staleness: 'fresh',
        capturedAt: this.now(),
        parsed: {
          code: '000000001',
          article: null,
          name: 'ПВД 15803-020',
          fullName: 'ПВД 15803-020',
          kindExternalId: 'mock-kind-raw-material',
          kindName: 'Сырье',
          unitExternalId: 'mock-unit-kg',
          unitName: 'кг',
          deleted: false,
          archived: false,
        },
        rawPayload: { _mock: true },
      },
    ];
  }

  async pullOrganizations(_opts?: OneCListOptions): Promise<OneCOrganizationSnapshot[]> {
    return [
      {
        sourceKind: 'mock_1C',
        subjectType: 'organization',
        externalId: 'mock-organization-plenka',
        sourceVersion: 'v1',
        staleness: 'fresh',
        capturedAt: this.now(),
        parsed: {
          code: '0001',
          name: 'Плёнки Контур',
          fullName: 'ООО «Плёнки Контур»',
          inn: '6600000000',
          kpp: '660001001',
          deleted: false,
        },
        rawPayload: { _mock: true },
      },
    ];
  }

  async pullWarehouses(_opts?: OneCListOptions): Promise<OneCWarehouseSnapshot[]> {
    return [
      {
        sourceKind: 'mock_1C',
        subjectType: 'warehouse',
        externalId: 'mock-warehouse-main',
        sourceVersion: 'v1',
        staleness: 'fresh',
        capturedAt: this.now(),
        parsed: {
          code: '000000001',
          name: 'Основной склад',
          warehouseType: 'ОптовыйСклад',
          deleted: false,
        },
        rawPayload: { _mock: true },
      },
    ];
  }

  async pullInvoice(orderRefOrExternalId: string): Promise<OneCInvoiceSnapshot> {
    return {
      sourceKind: 'mock_1C',
      subjectType: 'invoice',
      externalId: `mock-invoice-${orderRefOrExternalId.toLowerCase()}`,
      sourceVersion: 'v1',
      staleness: 'fresh',
      capturedAt: this.now(),
      parsed: {
        invoiceNo: `СЧ-${orderRefOrExternalId}`,
        date: null,
        total: 150000,
        currency: 'RUB',
        counterpartyExternalId: 'mock-counterparty-uralpak',
        posted: false,
      },
      rawPayload: { _mock: true, _raw: `<Документ ref="${orderRefOrExternalId}">…</Документ>` },
    };
  }

  async findInvoicesByOrderReference(orderReference: string): Promise<OneCInvoiceSnapshot[]> {
    const prefix = 'PLENKA_ORDER=';
    if (!orderReference.startsWith(prefix) || orderReference.length === prefix.length) {
      return [];
    }
    const invoice = this.exactInvoice(orderReference);
    this.exactInvoices.set(invoice.externalId!, invoice);
    return [invoice];
  }

  async findInvoicesByExactNumber(invoiceNumber: string): Promise<OneCInvoiceSnapshot[]> {
    const prefix = 'СЧ-';
    if (!invoiceNumber.startsWith(prefix) || invoiceNumber.length === prefix.length) {
      return [];
    }
    return this.findInvoicesByOrderReference(`PLENKA_ORDER=${invoiceNumber.slice(prefix.length)}`);
  }

  async pullInvoiceByExternalId(externalId: string): Promise<OneCInvoiceSnapshot> {
    const exact = this.exactInvoices.get(externalId);
    if (exact) return exact;
    const fullSync = await this.pullInvoices();
    const existing = fullSync.find((snapshot) => snapshot.externalId === externalId);
    if (existing) return existing;
    return {
      ...(await this.pullInvoice(externalId)),
      externalId,
    };
  }

  async pullInvoices(_opts?: OneCListOptions): Promise<OneCInvoiceSnapshot[]> {
    return [await this.pullInvoice('FULL-SYNC-0001')];
  }

  async pullInvoiceLines(_opts?: OneCListOptions): Promise<OneCInvoiceLineSource[]> {
    return [
      {
        invoiceExternalId: 'mock-invoice-full-sync-0001',
        parsed: {
          lineNumber: 1,
          nomenclatureExternalId: 'mock-nomenclature-pvd-15803',
          name: 'ПВД 15803-020',
          quantity: 100,
          price: 1500,
          amount: 150000,
          unitExternalId: 'mock-unit-kg',
        },
        rawPayload: { _mock: true },
      },
    ];
  }

  async pullPayments(_opts?: OneCListOptions): Promise<OneCPaymentSnapshot[]> {
    const linkedInvoice = [...this.exactInvoices.values()].at(-1);
    return [
      {
        sourceKind: 'mock_1C',
        subjectType: 'payment',
        externalId: 'mock-payment-0001',
        sourceVersion: 'v1',
        staleness: 'fresh',
        capturedAt: this.now(),
        parsed: {
          number: 'ПП-0001',
          date: null,
          amount: 75000,
          currency: linkedInvoice?.parsed.currency ?? 'RUB',
          counterpartyExternalId: 'mock-counterparty-uralpak',
          invoiceExternalId: linkedInvoice?.externalId ?? null,
          invoiceNumberReference: linkedInvoice?.parsed.invoiceNo ?? null,
          orderReference: linkedInvoice?.parsed.orderReference ?? null,
          posted: true,
        },
        rawPayload: { _mock: true },
      },
    ];
  }

  async pullPaymentByExternalId(externalId: string): Promise<OneCPaymentSnapshot> {
    const payments = await this.pullPayments();
    const existing = payments.find((snapshot) => snapshot.externalId === externalId);
    return existing ?? { ...payments[0], externalId };
  }

  async pullShipments(_opts?: OneCListOptions): Promise<OneCShipmentSnapshot[]> {
    return [
      {
        sourceKind: 'mock_1C',
        subjectType: 'shipment',
        externalId: 'mock-shipment-0001',
        sourceVersion: 'v1',
        staleness: 'fresh',
        capturedAt: this.now(),
        parsed: {
          number: 'РТУ-0001',
          date: null,
          total: 13140,
          counterpartyExternalId: 'mock-counterparty-uralpak',
          posted: true,
        },
        rawPayload: { _mock: true },
      },
    ];
  }

  async pullShipmentLines(_opts?: OneCListOptions): Promise<OneCShipmentLineSource[]> {
    return [
      {
        shipmentExternalId: 'mock-shipment-0001',
        parsed: {
          lineNumber: 1,
          nomenclatureExternalId: 'mock-nomenclature-pvd-15803',
          name: 'ПВД 15803-020',
          quantity: 10,
          price: 1314,
          amount: 13140,
          unitExternalId: 'mock-unit-kg',
        },
        rawPayload: { _mock: true },
      },
    ];
  }

  async pullProductionReports(opts?: OneCListOptions): Promise<OneCProductionReportSnapshot[]> {
    return pageMockItems([this.productionReport()], opts);
  }

  async pullProductionOutputLines(
    opts?: OneCListOptions,
  ): Promise<OneCProductionOutputLineSource[]> {
    return pageMockItems(
      [
        {
          reportExternalId: 'mock-production-report-0001',
          parsed: {
            lineNumber: 1,
            nomenclatureExternalId: 'mock-nomenclature-finished-kg',
            unitExternalId: 'mock-unit-kg',
            unitName: 'кг',
            quantity: 1,
          },
          rawPayload: { _mock: true },
        },
        {
          reportExternalId: 'mock-production-report-0001',
          parsed: {
            lineNumber: 2,
            nomenclatureExternalId: 'mock-nomenclature-finished-piece',
            unitExternalId: 'mock-unit-piece',
            unitName: 'шт',
            quantity: 1,
          },
          rawPayload: { _mock: true },
        },
      ],
      opts,
    );
  }

  async pullProductionMaterialLines(
    opts?: OneCListOptions,
  ): Promise<OneCProductionMaterialLineSource[]> {
    return pageMockItems(
      [
        {
          reportExternalId: 'mock-production-report-0001',
          parsed: {
            lineNumber: 1,
            nomenclatureExternalId: 'mock-nomenclature-pvd-15803',
            productExternalId: 'mock-nomenclature-finished-kg',
            unitExternalId: 'mock-unit-kg',
            unitName: 'кг',
            quantity: 1,
          },
          rawPayload: { _mock: true },
        },
      ],
      opts,
    );
  }

  async pullStock(_opts?: OneCListOptions): Promise<OneCStockSnapshot[]> {
    return [this.stock('mock-stock-rm-pvd-15803', 320), this.stock('mock-stock-rm-pvd-10803', 140)];
  }

  async pullBalances(
    accountCode: '10.01' | '41.01',
    _opts?: OneCListOptions,
  ): Promise<OneCStockSnapshot[]> {
    const snapshot = this.stock(`mock-balance-${accountCode}-pvd-15803`, 320);
    snapshot.parsed.account = `mock-account-${accountCode}`;
    snapshot.parsed.accountCode = accountCode;
    snapshot.parsed.organizationExternalId = 'mock-organization-plenka';
    snapshot.parsed.nomenclatureExternalId = 'mock-nomenclature-pvd-15803';
    return [snapshot];
  }

  async pushStock(items: OneCStockItem[]): Promise<OneCStockPushAck> {
    return {
      accepted: false,
      mode: 'mock',
      documentCreated: false,
      count: items.length,
      ref: `mock-stock-push-${Date.now()}`,
    };
  }

  private counterparty(
    externalId: string,
    parsed: OneCCounterpartySnapshot['parsed'],
  ): OneCCounterpartySnapshot {
    return {
      sourceKind: 'mock_1C',
      subjectType: 'counterparty',
      externalId,
      sourceVersion: 'v1',
      staleness: 'fresh',
      capturedAt: this.now(),
      parsed,
      rawPayload: { _mock: true, source: 'mock_1C' },
    };
  }

  private stock(externalId: string, qty: number): OneCStockSnapshot {
    return {
      sourceKind: 'mock_1C',
      subjectType: 'stock',
      externalId,
      sourceVersion: 'v1',
      staleness: 'fresh',
      capturedAt: this.now(),
      parsed: { account: '10', qty, amount: qty * 100, subconto: ['Материалы'] },
      rawPayload: { _mock: true },
    };
  }

  private productionReport(): OneCProductionReportSnapshot {
    return {
      sourceKind: 'mock_1C',
      subjectType: 'production_report',
      externalId: 'mock-production-report-0001',
      sourceVersion: 'v1',
      staleness: 'fresh',
      capturedAt: this.now(),
      parsed: {
        number: 'ОПЗС-0001',
        date: '2026-07-01T10:00:00.000Z',
        posted: true,
        deleted: false,
        organizationExternalId: 'mock-organization-plenka',
        warehouseExternalId: 'mock-warehouse-main',
        departmentExternalId: 'mock-department-production',
      },
      rawPayload: { _mock: true },
    };
  }

  private exactInvoice(orderReference: string): OneCInvoiceSnapshot {
    const orderNumber = orderReference.slice('PLENKA_ORDER='.length);
    return {
      sourceKind: 'mock_1C',
      subjectType: 'invoice',
      externalId: deterministicGuid(`invoice:${orderReference}`),
      sourceVersion: 'v1',
      staleness: 'fresh',
      capturedAt: this.now(),
      parsed: {
        invoiceNo: `СЧ-${orderNumber}`,
        date: this.now(),
        total: 150000,
        subtotal: 125000,
        taxTotal: 25000,
        currency: 'RUB',
        counterpartyExternalId: 'mock-counterparty-uralpak',
        orderReference,
        posted: true,
        deleted: false,
        lines: [
          {
            lineNumber: 1,
            nomenclatureExternalId: 'mock-nomenclature-pvd-15803',
            name: 'Плёнка по заявке',
            quantity: 20,
            price: 7500,
            amount: 150000,
            unitExternalId: 'mock-unit-roll',
          },
        ],
      },
      rawPayload: { _mock: true, orderReference },
    };
  }
}

function pageMockItems<T>(items: readonly T[], opts?: OneCListOptions): T[] {
  const skip = opts?.skip ?? 0;
  const top = opts?.top;
  return items.slice(skip, top === undefined ? undefined : skip + top);
}

function deterministicGuid(value: string): string {
  const chars = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  chars[12] = '4';
  chars[16] = '8';
  const hex = chars.join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

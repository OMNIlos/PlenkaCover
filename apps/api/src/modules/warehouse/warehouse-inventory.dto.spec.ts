import {
  WAREHOUSE_INVENTORY_LIFECYCLE_LABELS,
  WAREHOUSE_INVENTORY_LIFECYCLE_STATUSES,
  WAREHOUSE_INVENTORY_ORIGINS,
  WAREHOUSE_INVENTORY_PROVENANCE_KINDS,
  WAREHOUSE_INVENTORY_SORT_DIRECTIONS,
  WAREHOUSE_INVENTORY_SORT_KEYS,
  WAREHOUSE_INVENTORY_VIEWS,
} from '@plenka/contracts';
import { instanceToPlain, plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { WarehouseInventoryQueryDto } from './dto/warehouse-inventory-query.dto';
import {
  WarehouseInventoryRollDetailResponseDto,
  WarehouseInventoryRollItemResponseDto,
  WarehouseInventoryRollPageResponseDto,
} from './dto/warehouse-inventory-response.dto';

async function validateQuery(input: Record<string, unknown>) {
  return validate(plainToInstance(WarehouseInventoryQueryDto, input));
}

function serialize<T extends object>(type: new () => T, input: Record<string, unknown>) {
  return instanceToPlain(plainToInstance(type, input));
}

describe('warehouse inventory DTOs', () => {
  describe('contract vocabularies', () => {
    it('publishes the exact origins, lifecycle states, labels, provenance kinds, and sorts', () => {
      expect(WAREHOUSE_INVENTORY_ORIGINS).toEqual(['client', 'reserve']);
      expect(WAREHOUSE_INVENTORY_LIFECYCLE_STATUSES).toEqual([
        'awaiting_shipment',
        'available',
        'reserved',
        'defect',
        'in_transit',
        'delivered',
        'processed',
      ]);
      expect(WAREHOUSE_INVENTORY_LIFECYCLE_LABELS).toEqual({
        awaiting_shipment: 'Ожидает отгрузки',
        available: 'Доступен',
        reserved: 'Зарезервирован',
        defect: 'Брак',
        in_transit: 'В пути',
        delivered: 'Выдан',
        processed: 'Обработан',
      });
      expect(WAREHOUSE_INVENTORY_PROVENANCE_KINDS).toEqual([
        'client_order',
        'stock_reserve',
        'manual',
      ]);
      expect(WAREHOUSE_INVENTORY_SORT_KEYS).toEqual(['receivedAt', 'rollCode']);
      expect(WAREHOUSE_INVENTORY_SORT_DIRECTIONS).toEqual(['asc', 'desc']);
      expect(WAREHOUSE_INVENTORY_VIEWS).toEqual(['current', 'processed']);
    });
  });

  describe('query validation', () => {
    it('applies stable defaults to an empty query', async () => {
      const query = plainToInstance(WarehouseInventoryQueryDto, {});

      expect(await validate(query)).toEqual([]);
      expect(query).toMatchObject({
        sort: 'receivedAt',
        direction: 'desc',
        limit: 25,
      });
    });

    it.each([
      'awaiting_shipment',
      'available',
      'reserved',
      'defect',
      'in_transit',
      'delivered',
      'processed',
    ])('accepts the %s lifecycle status', async (status) => {
      expect(await validateQuery({ status })).toEqual([]);
    });

    it('rejects an unknown lifecycle status', async () => {
      expect(await validateQuery({ status: 'ready' })).not.toEqual([]);
    });

    it.each(['current', 'processed'])('accepts the %s inventory view', async (view) => {
      expect(await validateQuery({ view })).toEqual([]);
    });

    it('rejects an unknown inventory view', async () => {
      expect(await validateQuery({ view: 'all' })).not.toEqual([]);
    });

    it.each(['receivedAt', 'rollCode'])('accepts the %s sort key', async (sort) => {
      expect(await validateQuery({ sort })).toEqual([]);
    });

    it('rejects a non-database-backed sort key', async () => {
      expect(await validateQuery({ sort: 'weightKg' })).not.toEqual([]);
    });

    it.each(['asc', 'desc'])('accepts the %s sort direction', async (direction) => {
      expect(await validateQuery({ direction })).toEqual([]);
    });

    it('rejects an unknown sort direction', async () => {
      expect(await validateQuery({ direction: 'newest' })).not.toEqual([]);
    });

    it.each([
      ['q', 'x'.repeat(100)],
      ['batch', 'x'.repeat(100)],
      ['counterparty', 'x'.repeat(200)],
    ])('accepts the maximum %s length', async (field, value) => {
      expect(await validateQuery({ [field]: value })).toEqual([]);
    });

    it.each([
      ['q', 'x'.repeat(101)],
      ['batch', 'x'.repeat(101)],
      ['counterparty', 'x'.repeat(201)],
    ])('rejects %s above its maximum length', async (field, value) => {
      expect(await validateQuery({ [field]: value })).not.toEqual([]);
    });

    it.each(['q', 'batch', 'counterparty'])('rejects a non-string %s', async (field) => {
      expect(await validateQuery({ [field]: 42 })).not.toEqual([]);
    });

    it.each(['minAgeDays', 'maxAgeDays'])(
      'accepts the inclusive numeric bounds for %s',
      async (field) => {
        expect(await validateQuery({ [field]: '0' })).toEqual([]);
        expect(await validateQuery({ [field]: '3650' })).toEqual([]);
      },
    );

    it.each(['minAgeDays', 'maxAgeDays'])(
      'rejects out-of-range and fractional values for %s',
      async (field) => {
        expect(await validateQuery({ [field]: -1 })).not.toEqual([]);
        expect(await validateQuery({ [field]: 3651 })).not.toEqual([]);
        expect(await validateQuery({ [field]: 1.5 })).not.toEqual([]);
      },
    );

    it('accepts a non-empty cursor up to 1000 characters', async () => {
      expect(await validateQuery({ cursor: 'x' })).toEqual([]);
      expect(await validateQuery({ cursor: 'x'.repeat(1000) })).toEqual([]);
    });

    it('rejects an empty, oversized, or non-string cursor', async () => {
      expect(await validateQuery({ cursor: '' })).not.toEqual([]);
      expect(await validateQuery({ cursor: 'x'.repeat(1001) })).not.toEqual([]);
      expect(await validateQuery({ cursor: 42 })).not.toEqual([]);
    });

    it('accepts stringified inclusive limit bounds', async () => {
      expect(await validateQuery({ limit: '1' })).toEqual([]);
      expect(await validateQuery({ limit: '100' })).toEqual([]);
    });

    it('rejects out-of-range and fractional limits', async () => {
      expect(await validateQuery({ limit: 0 })).not.toEqual([]);
      expect(await validateQuery({ limit: 101 })).not.toEqual([]);
      expect(await validateQuery({ limit: 1.5 })).not.toEqual([]);
    });
  });

  describe('safe response projection', () => {
    const item = {
      id: 'roll-1',
      rollCode: 'R-001',
      origin: 'client',
      lifecycleStatus: 'awaiting_shipment',
      lifecycleStatusLabel: 'Ожидает отгрузки',
      counterpartyName: 'ТестПак',
      batchCode: null,
      weightKg: 24.5,
      specification: 'Рукав · 80 мкм · 1200 мм · 300 м',
      receivedAt: '2026-08-07T07:00:00.000Z',
      processedAt: null,
    };

    it('serializes every list field and excludes injected source data', () => {
      expect(
        serialize(WarehouseInventoryRollItemResponseDto, {
          ...item,
          legalName: 'ООО «Секрет»',
          positionSnapshot: { raw: true },
          currentCoverageFact: { fingerprint: 'secret' },
        }),
      ).toEqual(item);
    });

    it('serializes exact nested detail fields and recursively excludes injected source data', () => {
      const detail = {
        ...item,
        specificationDetails: {
          filmType: 'Рукав',
          actualThicknessMicron: 80,
          accountingThicknessMicron: 78,
          widthMm: 1200,
          plannedLengthM: 300,
          netKg: 24.5,
          spoolType: '76 мм',
          birka: 'ГОСТ',
          recipeName: 'ПНД натуральный',
          ingredients: ['ПНД 80%', 'Краситель 20%'],
        },
        provenance: {
          kind: 'client_order',
          orderNumber: 'A-17',
          batchCode: null,
        },
      };

      expect(
        serialize(WarehouseInventoryRollDetailResponseDto, {
          ...detail,
          legalName: 'ООО «Секрет»',
          positionSnapshot: { raw: true },
          currentCoverageFact: { fingerprint: 'secret' },
          specificationDetails: {
            ...detail.specificationDetails,
            positionSnapshot: { raw: true },
            currentCoverageFact: { fingerprint: 'secret' },
          },
          provenance: {
            ...detail.provenance,
            orderId: 'internal-order-id',
            counterpartyId: 'internal-counterparty-id',
          },
        }),
      ).toEqual(detail);
    });

    it('serializes page items through the safe nested DTO', () => {
      expect(
        serialize(WarehouseInventoryRollPageResponseDto, {
          items: [
            {
              ...item,
              legalName: 'ООО «Секрет»',
              positionSnapshot: { raw: true },
              currentCoverageFact: { fingerprint: 'secret' },
            },
          ],
          nextCursor: 'opaque-cursor',
          currentCoverageFact: { fingerprint: 'page-secret' },
        }),
      ).toEqual({
        items: [item],
        nextCursor: 'opaque-cursor',
      });
    });
  });
});

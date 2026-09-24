import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Actor } from '../../common/auth/actor';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import { ProductionCostInputService } from './production-cost-input.service';

const actor: Actor = {
  userId: 'finance-1',
  role: 'finance',
  capabilities: ['material_cost:manage'],
};
const priceDto = {
  operationKey: 'a74c43e8-2d6f-4d55-a3fc-7666320978f3',
  rawMaterialDefinitionId: 'material-1',
  priceKopecksPerKg: 12_345,
  source: 'Счёт поставщика № 10',
  effectiveFrom: '2026-08-01T00:00:00.000Z',
  reason: 'Новая поставка',
};
const additionalDto = {
  operationKey: '43a2dbf0-6d83-4024-825b-a1dd1a14985e',
  rollDispatchItemId: 'roll-1',
  amountKopecks: 50_000,
  source: 'Акт обслуживания',
  effectiveAt: '2026-08-02T10:00:00.000Z',
  reason: 'Ремонт оснастки для рулона',
};

function priceFingerprint() {
  return requestFingerprint(priceDto);
}

function fixture(options?: { priceReplayFingerprint?: string }) {
  const priceRow = {
    id: 'price-1',
    requestFingerprint: options?.priceReplayFingerprint ?? priceFingerprint(),
    rawMaterialDefinitionId: 'material-1',
    priceKopecksPerKg: 12_345,
    source: 'Счёт поставщика № 10',
    effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
    reason: 'Новая поставка',
    createdAt: new Date('2026-08-01T09:00:00.000Z'),
    rawMaterialDefinition: { name: 'ПНД' },
  };
  const tx = {
    materialPriceReference: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(priceRow),
    },
    rawMaterialDefinition: {
      findUnique: jest.fn().mockResolvedValue({ id: 'material-1' }),
    },
    additionalProductionCost: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }) => ({
        id: 'cost-1',
        requestFingerprint: data.requestFingerprint,
        rollDispatchItemId: data.rollDispatchItemId,
        productionOrderId: data.productionOrderId,
        allocationBasis: data.allocationBasis,
        amountKopecks: data.amountKopecks,
        source: data.source,
        effectiveAt: data.effectiveAt,
        reason: data.reason,
        createdAt: new Date('2026-08-02T11:00:00.000Z'),
      })),
    },
    rollDispatchItem: { findUnique: jest.fn().mockResolvedValue({ id: 'roll-1' }) },
    productionOrder: { findUnique: jest.fn().mockResolvedValue({ id: 'order-1' }) },
    domainEvent: { create: jest.fn().mockResolvedValue({ id: 'event-1' }) },
  };
  const prisma = {
    materialPriceReference: {
      findUnique: jest.fn().mockResolvedValue(options?.priceReplayFingerprint ? priceRow : null),
    },
    additionalProductionCost: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn().mockImplementation((work) => work(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'event-1' }) };
  return {
    tx,
    prisma,
    audit,
    service: new ProductionCostInputService(prisma as never, audit as never),
  };
}

describe('ProductionCostInputService', () => {
  it('records an effective price and its audit fact atomically', async () => {
    const context = fixture();

    await expect(context.service.setMaterialPrice(actor, priceDto)).resolves.toEqual(
      expect.objectContaining({
        rawMaterialDefinitionId: 'material-1',
        materialName: 'ПНД',
        priceKopecksPerKg: 12_345,
      }),
    );
    expect(context.tx.materialPriceReference.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requestFingerprint: priceFingerprint(),
          createdById: 'finance-1',
          createdByRole: 'finance',
        }),
      }),
    );
    expect(context.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:material_cost_reference_updated' }),
      context.tx,
    );
  });

  it('replays the same price command but rejects a divergent key reuse', async () => {
    await expect(
      fixture({ priceReplayFingerprint: priceFingerprint() }).service.setMaterialPrice(
        actor,
        priceDto,
      ),
    ).resolves.toEqual(expect.objectContaining({ id: 'price-1' }));

    await expect(
      fixture({ priceReplayFingerprint: 'different' }).service.setMaterialPrice(actor, priceDto),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('requires exactly one additional-cost target before touching the database', async () => {
    const context = fixture();

    await expect(
      context.service.recordAdditionalCost(actor, {
        ...additionalDto,
        rollDispatchItemId: undefined,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      context.service.recordAdditionalCost(actor, {
        ...additionalDto,
        productionOrderId: 'order-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(context.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('stores roll costs as direct and order costs as net-weight allocations', async () => {
    const roll = fixture();
    await expect(roll.service.recordAdditionalCost(actor, additionalDto)).resolves.toEqual(
      expect.objectContaining({
        targetKind: 'roll',
        targetId: 'roll-1',
        allocationBasis: 'direct',
      }),
    );

    const order = fixture();
    await expect(
      order.service.recordAdditionalCost(actor, {
        ...additionalDto,
        rollDispatchItemId: undefined,
        productionOrderId: 'order-1',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        targetKind: 'order',
        targetId: 'order-1',
        allocationBasis: 'finished_net_kg',
      }),
    );
    expect(order.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:additional_production_cost_recorded' }),
      order.tx,
    );
  });
});

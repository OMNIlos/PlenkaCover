import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WarehouseSpoolPriceService } from './warehouse-spool-price.service';

const actor = {
  userId: 'warehouse-user-1',
  role: 'warehouse' as const,
  capabilities: ['spool_price:manage' as const, 'spool_stock:receive' as const],
};

const command = {
  operationKey: '00000000-0000-4000-8000-000000000001',
  spoolTypeLabel: 'Шпуля 76 мм',
  priceKopecksPerMeter: 6_000,
  source: 'Прайс поставщика',
  effectiveFrom: '2026-08-01T00:00:00.000Z',
  reason: 'Новый прайс',
};

const receiptCommand = {
  ...command,
  operationKey: '00000000-0000-4000-8000-000000000002',
  quantityMillimeters: 125_500,
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'spool-price-1',
    operationKey: command.operationKey,
    requestFingerprint: '',
    spoolTypeKey: 'шпуля 76 мм',
    spoolTypeLabel: 'Шпуля 76 мм',
    priceKopecksPerMeter: 6_000n,
    source: 'Прайс поставщика',
    effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
    reason: 'Новый прайс',
    createdById: 'warehouse-user-1',
    createdByRole: 'warehouse',
    createdAt: new Date('2026-08-01T01:00:00.000Z'),
    ...overrides,
  };
}

function receiptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'spool-receipt-1',
    operationKey: receiptCommand.operationKey,
    requestFingerprint: '',
    spoolTypeKey: 'шпуля 76 мм',
    spoolTypeLabel: 'Шпуля 76 мм',
    quantityMillimeters: 125_500n,
    priceReferenceId: 'spool-price-1',
    priceReference: row(),
    receivedAt: new Date('2026-08-01T02:00:00.000Z'),
    receivedById: 'warehouse-user-1',
    receivedByRole: 'warehouse',
    createdAt: new Date('2026-08-01T02:00:00.000Z'),
    ...overrides,
  };
}

function fixture(labels = ['втулка 76', 'Шпуля 76 мм', '76 мм']) {
  const create = jest.fn(async ({ data }) => row(data));
  const findUnique = jest.fn().mockResolvedValue(null);
  const receiptCreate = jest.fn(async ({ data }) => receiptRow(data));
  const receiptFindUnique = jest.fn().mockResolvedValue(null);
  const groupBy = jest.fn().mockResolvedValue([]);
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue(labels.map((label) => ({ label }))),
    $executeRaw: jest.fn().mockResolvedValue(1),
    spoolPriceReference: { findUnique, create },
    spoolStockReceipt: { findUnique: receiptFindUnique, create: receiptCreate, groupBy },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn(async (callback) => callback(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'event-1' }) };
  return {
    prisma,
    tx,
    create,
    findUnique,
    receiptCreate,
    receiptFindUnique,
    groupBy,
    audit,
    service: new WarehouseSpoolPriceService(prisma as never, audit as never),
  };
}

describe('WarehouseSpoolPriceService', () => {
  it('lists only bounded exact observed business labels and preserves semantic variants', async () => {
    const context = fixture();

    await expect(context.service.listObservedTypes()).resolves.toEqual([
      { key: '76 мм', label: '76 мм' },
      { key: 'втулка 76', label: 'втулка 76' },
      { key: 'шпуля 76 мм', label: 'Шпуля 76 мм' },
    ]);
    expect(context.prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(context.create).not.toHaveBeenCalled();
    expect(context.audit.record).not.toHaveBeenCalled();
  });

  it('rejects ambiguous observed labels that normalize to one identity', async () => {
    const context = fixture(['Шпуля 76 мм', 'ШПУЛЯ 76 ММ']);
    await expect(context.service.listObservedTypes()).rejects.toBeInstanceOf(ConflictException);
  });

  it('cannot mint an unobserved spool taxonomy value', async () => {
    const context = fixture();
    await expect(
      context.service.record(actor, { ...command, spoolTypeLabel: 'Шпуля 77 мм' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(context.create).not.toHaveBeenCalled();
    expect(context.audit.record).not.toHaveBeenCalled();
  });

  it('creates one canonical reference and one audit fact atomically', async () => {
    const context = fixture();
    const result = await context.service.record(actor, command);

    expect(result).toEqual({
      id: 'spool-price-1',
      spoolTypeKey: 'шпуля 76 мм',
      spoolTypeLabel: 'Шпуля 76 мм',
      priceKopecksPerMeter: 6_000,
      source: 'Прайс поставщика',
      effectiveFrom: '2026-08-01T00:00:00.000Z',
      reason: 'Новый прайс',
      createdById: 'warehouse-user-1',
      createdByRole: 'warehouse',
      createdAt: '2026-08-01T01:00:00.000Z',
    });
    expect(context.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        spoolTypeKey: 'шпуля 76 мм',
        spoolTypeLabel: 'Шпуля 76 мм',
        priceKopecksPerMeter: 6_000n,
        createdById: 'warehouse-user-1',
      }),
    });
    expect(context.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:spool_price_reference_recorded',
        actorRole: 'warehouse',
        actorId: 'warehouse-user-1',
      }),
      context.tx,
    );
  });

  it('replays an exact operation and conflicts on changed reuse', async () => {
    const context = fixture();
    const first = await context.service.record(actor, command);
    const persisted = row({
      requestFingerprint: context.create.mock.calls[0][0].data.requestFingerprint,
    });
    context.findUnique.mockResolvedValue(persisted);

    await expect(context.service.record(actor, command)).resolves.toEqual(first);
    await expect(
      context.service.record(actor, { ...command, priceKopecksPerMeter: 7_000 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(context.create).toHaveBeenCalledTimes(1);
    expect(context.audit.record).toHaveBeenCalledTimes(1);
  });

  it('returns the concurrent operation winner after P2002 without a second event', async () => {
    const context = fixture();
    const probe = await context.service.record(actor, command);
    const persisted = row({
      requestFingerprint: context.create.mock.calls[0][0].data.requestFingerprint,
    });
    context.create.mockClear();
    context.audit.record.mockClear();
    context.findUnique.mockReset().mockResolvedValueOnce(null).mockResolvedValue(persisted);
    context.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique conflict', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(context.service.record(actor, command)).resolves.toEqual(probe);
    expect(context.audit.record).not.toHaveBeenCalled();
  });

  it('creates one price and receipt with both audit facts in one transaction', async () => {
    const context = fixture();

    await expect(context.service.recordReceipt(actor, receiptCommand)).resolves.toMatchObject({
      spoolTypeLabel: 'Шпуля 76 мм',
      quantityMillimeters: 125_500,
      priceKopecksPerMeter: 6_000,
    });
    expect(context.tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(context.receiptCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        quantityMillimeters: 125_500n,
        priceReferenceId: 'spool-price-1',
        receivedAt: new Date('2026-08-01T00:00:00.000Z'),
        receivedById: 'warehouse-user-1',
      }),
      include: { priceReference: true },
    });
    expect(context.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:spool_stock_receipt_recorded' }),
      context.tx,
    );
    expect(context.audit.record).toHaveBeenCalledTimes(2);
  });

  it('replays an exact receipt and rejects changed operation-key reuse', async () => {
    const context = fixture();
    const first = await context.service.recordReceipt(actor, receiptCommand);
    const persisted = receiptRow({
      requestFingerprint: context.receiptCreate.mock.calls[0][0].data.requestFingerprint,
      receivedAt: new Date(first.receivedAt),
    });
    context.receiptFindUnique.mockResolvedValue(persisted);

    await expect(context.service.recordReceipt(actor, receiptCommand)).resolves.toEqual(first);
    await expect(
      context.service.recordReceipt(actor, {
        ...receiptCommand,
        quantityMillimeters: 125_501,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(context.receiptCreate).toHaveBeenCalledTimes(1);
    expect(context.audit.record).toHaveBeenCalledTimes(2);
  });

  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid receipt quantity %s before persistence',
    async (quantityMillimeters) => {
      const context = fixture();

      await expect(
        context.service.recordReceipt(actor, { ...receiptCommand, quantityMillimeters }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(context.prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('reuses the exact dated price and writes only the receipt audit', async () => {
    const context = fixture();
    context.findUnique.mockImplementation(async ({ where }) =>
      'spoolTypeKey_effectiveFrom' in where ? row() : null,
    );

    await expect(context.service.recordReceipt(actor, receiptCommand)).resolves.toMatchObject({
      priceReferenceId: 'spool-price-1',
      priceKopecksPerMeter: 6_000,
    });
    expect(context.create).not.toHaveBeenCalled();
    expect(context.audit.record).toHaveBeenCalledTimes(1);
    expect(context.audit.record.mock.calls[0][0]).toMatchObject({
      type: 'audit:spool_stock_receipt_recorded',
    });
  });

  it('rejects a different price for the same type and effective date without writes', async () => {
    const context = fixture();
    context.findUnique.mockImplementation(async ({ where }) =>
      'spoolTypeKey_effectiveFrom' in where ? row({ priceKopecksPerMeter: 6_500n }) : null,
    );

    await expect(context.service.recordReceipt(actor, receiptCommand)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(context.receiptCreate).not.toHaveBeenCalled();
    expect(context.audit.record).not.toHaveBeenCalled();
  });

  it('lists every observed type with received totals, zeroes, and last receipt time', async () => {
    const context = fixture(['Тонкая', 'Толстая']);
    context.groupBy.mockResolvedValue([
      {
        spoolTypeKey: 'тонкая',
        _sum: { quantityMillimeters: 125_500n },
        _max: { receivedAt: new Date('2026-08-01T02:00:00.000Z') },
      },
    ]);

    await expect(context.service.listStock()).resolves.toEqual([
      {
        spoolTypeKey: 'толстая',
        spoolTypeLabel: 'Толстая',
        totalReceivedMillimeters: 0,
        lastReceivedAt: null,
      },
      {
        spoolTypeKey: 'тонкая',
        spoolTypeLabel: 'Тонкая',
        totalReceivedMillimeters: 125_500,
        lastReceivedAt: '2026-08-01T02:00:00.000Z',
      },
    ]);
  });
});

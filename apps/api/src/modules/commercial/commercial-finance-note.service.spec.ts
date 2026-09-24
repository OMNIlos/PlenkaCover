import { ConflictException } from '@nestjs/common';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import {
  commercialFinanceNoteFingerprintInput,
  CommercialFinanceNoteService,
} from './commercial-finance-note.service';

const OPERATION_KEY = '8c5c69ef-6bd3-4e25-9829-d32da8cd75dc';

function setup() {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'order-1' }]),
    commercialFinanceNoteCommand: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'command-1' }),
    },
    commercialOrder: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'order-1',
        version: 3,
        commercialFinanceNote: null,
        financeOrder: null,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'event-1' }) };
  const service = new CommercialFinanceNoteService(prisma as never, audit as never);
  return { audit, prisma, service, tx };
}

describe('CommercialFinanceNoteService', () => {
  it('updates the note with optimistic concurrency and an audit event', async () => {
    const { audit, service, tx } = setup();

    await expect(
      service.update({ userId: 'commercial-1', role: 'commercial' }, 'order-1', {
        commercialFinanceNote: ' 1200 за 20 рулонов ',
        expectedVersion: 3,
        operationKey: OPERATION_KEY,
      }),
    ).resolves.toEqual({
      id: 'order-1',
      version: 4,
      commercialFinanceNote: '1200 за 20 рулонов',
    });
    expect(tx.commercialOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', version: 3 },
      data: {
        commercialFinanceNote: '1200 за 20 рулонов',
        version: { increment: 1 },
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:commercial_finance_note_updated',
        oldValue: { commercialFinanceNote: null, version: 3 },
        newValue: {
          commercialFinanceNote: '1200 за 20 рулонов',
          version: 4,
        },
      }),
      tx,
    );
  });

  it('updates the note after a posted paid invoice and sends one safe notification', async () => {
    const { audit, service, tx } = setup();
    const productionClearedAt = new Date('2026-08-04T10:00:00.000Z');
    tx.commercialOrder.findUnique.mockResolvedValue({
      id: 'order-1',
      orderNumber: 'A-17',
      version: 3,
      commercialFinanceNote: null,
      financeOrder: {
        id: 'finance-1',
        invoiceSyncState: 'posted',
        invoiceStatus: 'invoiced',
        paymentStatus: 'paid',
        productionClearedAt,
        externalId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      },
      productionOrder: { id: 'production-1' },
    });

    await expect(
      service.update({ userId: 'commercial-1', role: 'commercial' }, 'order-1', {
        commercialFinanceNote: 'новая цена',
        expectedVersion: 3,
        operationKey: OPERATION_KEY,
      }),
    ).resolves.toEqual({
      id: 'order-1',
      version: 4,
      commercialFinanceNote: 'новая цена',
    });
    expect(tx.commercialOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', version: 3 },
      data: {
        commercialFinanceNote: 'новая цена',
        version: { increment: 1 },
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notification:commercial_order_amended',
        objectId: 'order-1',
        detail: {
          orderId: 'order-1',
          orderNumber: 'A-17',
          field: 'commercialFinanceNote',
          recipientRoles: ['finance', 'production_lead'],
        },
      }),
      tx,
    );
    expect(audit.record).toHaveBeenCalledTimes(2);
  });

  it('returns the original result for an idempotent replay', async () => {
    const { service, tx } = setup();
    const dto = {
      commercialFinanceNote: '1200 за 20 рулонов',
      expectedVersion: 3,
      operationKey: OPERATION_KEY,
    };
    tx.commercialFinanceNoteCommand.findUnique.mockResolvedValue({
      requestFingerprint: requestFingerprint(commercialFinanceNoteFingerprintInput('order-1', dto)),
      result: {
        id: 'order-1',
        version: 4,
        commercialFinanceNote: '1200 за 20 рулонов',
      },
    });

    await expect(
      service.update({ userId: 'commercial-1', role: 'commercial' }, 'order-1', dto),
    ).resolves.toEqual({
      id: 'order-1',
      version: 4,
      commercialFinanceNote: '1200 за 20 рулонов',
    });
    expect(tx.commercialOrder.updateMany).not.toHaveBeenCalled();
  });

  it('rejects reuse of an operation key with another payload', async () => {
    const { service, tx } = setup();
    tx.commercialFinanceNoteCommand.findUnique.mockResolvedValue({
      requestFingerprint: '0'.repeat(64),
      result: {},
    });

    await expect(
      service.update({ userId: 'commercial-1', role: 'commercial' }, 'order-1', {
        commercialFinanceNote: 'другая цена',
        expectedVersion: 3,
        operationKey: OPERATION_KEY,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

import { Test } from '@nestjs/testing';
import { OneCImportService } from './onec-import.service';
import { ONEC_ADAPTER } from './onec.adapter';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { MockOneCAdapter } from './mock-onec.adapter';

const actor = { userId: 'u1', role: 'finance' as const };

function setup(adapter: any = new MockOneCAdapter()) {
  const prisma: any = {
    sourceSnapshot: {
      create: jest.fn().mockResolvedValue({ id: 'snap-x' }),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };
  const audit = { record: jest.fn(), forObject: jest.fn().mockResolvedValue([]) };
  return { prisma, audit, adapter };
}

async function build(prisma: any, audit: any, adapter: any): Promise<OneCImportService> {
  const mod = await Test.createTestingModule({
    providers: [
      OneCImportService,
      { provide: PrismaService, useValue: prisma },
      { provide: AuditService, useValue: audit },
      { provide: ONEC_ADAPTER, useValue: adapter },
    ],
  }).compile();
  return mod.get(OneCImportService);
}

describe('OneCImportService', () => {
  it('importCounterparties persists a snapshot and records integration.onec_imported', async () => {
    const { prisma, audit, adapter } = setup();
    const service = await build(prisma, audit, adapter);
    const out = await service.importCounterparties(actor);

    expect(prisma.sourceSnapshot.create).toHaveBeenCalled();
    const created = prisma.sourceSnapshot.create.mock.calls[0][0].data;
    expect(created.subjectType).toBe('counterparty');
    expect(created.externalId).toBe('mock-counterparty-uralpak');
    expect(created.rawPayload).toBeDefined(); // full snapshot IS persisted (admin-only column)
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'integration.onec_imported' }),
    );
    // returned projections must NOT carry raw
    expect(out.every((s) => !('rawPayload' in s))).toBe(true);
  });

  it('imports one counterparty and one invoice through the same persistence boundary', async () => {
    const { prisma, audit, adapter } = setup();
    const service = await build(prisma, audit, adapter);

    const counterparty = await service.importCounterparty(actor, 'mock-counterparty-uralpak');
    const invoice = await service.importInvoice(actor, 'order-1');

    expect(counterparty.subjectType).toBe('counterparty');
    expect(invoice.subjectType).toBe('invoice');
    expect(prisma.sourceSnapshot.create).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(counterparty)).not.toContain('rawPayload');
    expect(JSON.stringify(invoice)).not.toContain('rawPayload');
  });

  it('does not put rawPayload into the audit event detail (ТЗ §8)', async () => {
    const { prisma, audit, adapter } = setup();
    const service = await build(prisma, audit, adapter);
    await service.importCounterparties(actor);
    const detail = audit.record.mock.calls[0][0].detail ?? {};
    expect(JSON.stringify(detail)).not.toContain('_mock');
  });

  it('records integration.onec_import_failed and rethrows when the adapter throws', async () => {
    const failing = {
      pullCounterparties: jest.fn().mockRejectedValue(new Error('OData GET failed: HTTP 500')),
    };
    const { prisma, audit, adapter } = setup(failing);
    const service = await build(prisma, audit, adapter);
    await expect(service.importCounterparties(actor)).rejects.toThrow(/HTTP 500/);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'integration.onec_import_failed' }),
    );
    expect(prisma.sourceSnapshot.create).not.toHaveBeenCalled();
  });

  it('only appends events (never updates/deletes) and never mutates a snapshot', async () => {
    const { prisma, audit, adapter } = setup();
    const service = await build(prisma, audit, adapter);
    await service.importCounterparties(actor);
    expect(prisma.sourceSnapshot.create).toHaveBeenCalledTimes(1);
    expect(prisma.sourceSnapshot.update).not.toHaveBeenCalled();
    expect(prisma.sourceSnapshot.delete).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('pushStock records intent only after live HTTP health and a created-document ack', async () => {
    const adapter = {
      stockPushConfiguration: jest.fn().mockReturnValue({ mode: 'http', enabled: true }),
      checkHealth: jest.fn().mockResolvedValue({ mode: 'http', status: 'ready' }),
      pushStock: jest.fn().mockResolvedValue({
        accepted: true,
        mode: 'http',
        documentCreated: true,
        count: 1,
        ref: 'КП00-000003',
      }),
    };
    const { prisma, audit } = setup(adapter);
    const service = await build(prisma, audit, adapter);
    const ack = await service.pushStock(actor, [
      { materialId: 'rm-pvd-15803', qty: 320, unit: 'кг' },
    ]);
    expect(ack).toMatchObject({
      accepted: true,
      mode: 'http',
      documentCreated: true,
    });
    expect(adapter.checkHealth).toHaveBeenCalledTimes(1);
    expect(adapter.pushStock).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'integration.onec_imported' }),
    );
  });

  it.each([
    [{ mode: 'mock', enabled: false }, 'mock_adapter'],
    [{ mode: 'http', enabled: false }, 'write_disabled'],
  ])('reports configuration %j as not ready without a network probe', async (config, code) => {
    const adapter = {
      stockPushConfiguration: jest.fn().mockReturnValue(config),
      checkHealth: jest.fn(),
      pushStock: jest.fn(),
    };
    const { prisma, audit } = setup(adapter);
    const service = await build(prisma, audit, adapter);

    await expect(service.stockPushReadiness()).resolves.toMatchObject({
      writeReady: false,
      readinessCode: code,
    });
    await expect(
      service.pushStock(actor, [{ materialId: 'rm-pvd-15803', qty: 320, unit: 'кг' }]),
    ).rejects.toMatchObject({ status: 503 });
    expect(adapter.checkHealth).not.toHaveBeenCalled();
    expect(adapter.pushStock).not.toHaveBeenCalled();
  });

  it('reports an enabled but unavailable HTTP endpoint as not ready', async () => {
    const adapter = {
      stockPushConfiguration: jest.fn().mockReturnValue({ mode: 'http', enabled: true }),
      checkHealth: jest.fn().mockResolvedValue({ mode: 'http', status: 'unavailable' }),
      pushStock: jest.fn(),
    };
    const { prisma, audit } = setup(adapter);
    const service = await build(prisma, audit, adapter);

    await expect(service.stockPushReadiness()).resolves.toMatchObject({
      writeReady: false,
      readinessCode: 'onec_unavailable',
    });
    await expect(
      service.pushStock(actor, [{ materialId: 'rm-pvd-15803', qty: 320, unit: 'кг' }]),
    ).rejects.toMatchObject({ status: 503 });
    expect(adapter.pushStock).not.toHaveBeenCalled();
  });

  it('rejects empty stock before health or adapter calls', async () => {
    const adapter = {
      stockPushConfiguration: jest.fn(),
      checkHealth: jest.fn(),
      pushStock: jest.fn(),
    };
    const { prisma, audit } = setup(adapter);
    const service = await build(prisma, audit, adapter);

    await expect(service.pushStock(actor, [])).rejects.toThrow(/at least one/i);
    expect(adapter.stockPushConfiguration).not.toHaveBeenCalled();
    expect(adapter.checkHealth).not.toHaveBeenCalled();
    expect(adapter.pushStock).not.toHaveBeenCalled();
  });

  it('pushStock records a failed append-only integration fact before rethrowing', async () => {
    const failure = new Error('1C write delivery outcome is unknown');
    const failing = {
      stockPushConfiguration: jest.fn().mockReturnValue({ mode: 'http', enabled: true }),
      checkHealth: jest.fn().mockResolvedValue({ mode: 'http', status: 'ready' }),
      pushStock: jest.fn().mockRejectedValue(failure),
    };
    const { prisma, audit, adapter } = setup(failing);
    const service = await build(prisma, audit, adapter);

    await expect(
      service.pushStock(actor, [{ materialId: 'rm-pvd-15803', qty: 320, unit: 'кг' }]),
    ).rejects.toBe(failure);
    expect(audit.record).toHaveBeenCalledWith({
      type: 'integration.onec_import_failed',
      actorRole: actor.role,
      actorId: actor.userId,
      label: 'onec_stock_push',
      reason: '1C write delivery outcome is unknown',
      detail: { direction: 'push', subjectType: 'stock', count: 1 },
    });
  });
});

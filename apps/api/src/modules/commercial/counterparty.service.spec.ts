import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { CounterpartyService } from './counterparty.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';

function mockPrisma() {
  const prisma = {
    counterparty: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  prisma.$transaction.mockImplementation((work: (client: typeof prisma) => unknown) =>
    work(prisma),
  );
  return prisma;
}

describe('CounterpartyService', () => {
  let service: CounterpartyService;
  let prisma: ReturnType<typeof mockPrisma>;
  let audit: { record: jest.Mock };

  beforeEach(async () => {
    prisma = mockPrisma();
    audit = { record: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        CounterpartyService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = mod.get(CounterpartyService);
  });

  const cp = (over: Record<string, unknown> = {}) => ({
    id: 'cp1',
    displayName: 'УралПак',
    legalName: 'ООО «УралПак»',
    inn: '6600000000',
    billingSource: 'manual_platform',
    syncStatus: 'ready',
    ...over,
  });

  it('list projects counterparties for a legal-visible role', async () => {
    prisma.counterparty.findMany.mockResolvedValue([cp()]);
    const result = await service.list('commercial');
    expect(result).toEqual([
      expect.objectContaining({
        id: 'cp1',
        displayName: 'УралПак',
        legalName: 'ООО «УралПак»',
        inn: '6600000000',
      }),
    ]);
  });

  it('list hides legalName/inn from non-legal roles (ТЗ §4/§15)', async () => {
    prisma.counterparty.findMany.mockResolvedValue([cp()]);
    const result = await service.list('operator');
    expect(result[0].legalName).toBeNull();
    expect(result[0].inn).toBeNull();
  });

  it('fails closed instead of truncating an oversized counterparty catalog', async () => {
    prisma.counterparty.findMany.mockResolvedValue(
      Array.from({ length: 501 }, (_, index) =>
        cp({ id: `cp-${index}`, displayName: `Контрагент ${index}` }),
      ),
    );

    await expect(service.list('production_lead')).rejects.toMatchObject({
      response: {
        code: 'COUNTERPARTY_CATALOG_TOO_LARGE',
      },
    });
    expect(prisma.counterparty.findMany).toHaveBeenCalledWith({
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      take: 501,
    });
  });

  it('search returns a bounded role-projected page and a deterministic name/id cursor', async () => {
    prisma.counterparty.findMany.mockResolvedValue([
      cp({ id: 'cp-a', displayName: 'УралПак', rawPayload: { source: 'internal' } }),
      cp({ id: 'cp-b', displayName: 'УралПак' }),
      cp({ id: 'cp-c', displayName: 'УралПак Север' }),
    ]);

    const result = await service.search('operator', { q: '  УРАЛПАК  ', limit: 2 });

    expect(result).toEqual({
      items: [
        {
          id: 'cp-a',
          displayName: 'УралПак',
          legalName: null,
          inn: null,
          billingSource: 'manual_platform',
          syncStatus: 'ready',
        },
        {
          id: 'cp-b',
          displayName: 'УралПак',
          legalName: null,
          inn: null,
          billingSource: 'manual_platform',
          syncStatus: 'ready',
        },
      ],
      nextCursor: expect.any(String),
    });
    expect(JSON.parse(Buffer.from(result.nextCursor!, 'base64url').toString('utf8'))).toEqual({
      displayName: 'УралПак',
      id: 'cp-b',
    });
    expect(prisma.counterparty.findMany).toHaveBeenCalledWith({
      where: { displayName: { contains: 'УРАЛПАК', mode: 'insensitive' } },
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      take: 3,
    });
  });

  it('search normalizes an INN query and continues after the exact name/id tuple', async () => {
    const cursor = Buffer.from(
      JSON.stringify({ displayName: 'Одинаковое имя', id: 'cp-10' }),
      'utf8',
    ).toString('base64url');
    prisma.counterparty.findMany.mockResolvedValue([
      cp({ id: 'cp-11', displayName: 'Одинаковое имя' }),
    ]);

    await expect(
      service.search('commercial', { q: '  77 00 123 456  ', cursor, limit: 20 }),
    ).resolves.toEqual({
      items: [expect.objectContaining({ id: 'cp-11', inn: '6600000000' })],
      nextCursor: null,
    });
    expect(prisma.counterparty.findMany).toHaveBeenCalledWith({
      where: {
        AND: [
          {
            OR: [
              { displayName: { contains: '77 00 123 456', mode: 'insensitive' } },
              { legalName: { contains: '77 00 123 456', mode: 'insensitive' } },
              { inn: { contains: '7700123456', mode: 'insensitive' } },
            ],
          },
          {
            OR: [
              { displayName: { gt: 'Одинаковое имя' } },
              { displayName: 'Одинаковое имя', id: { gt: 'cp-10' } },
            ],
          },
        ],
      },
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      take: 21,
    });
  });

  it('does not let a non-legal role infer hidden legal names or INNs through search', async () => {
    prisma.counterparty.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      cp({
        id: 'cp-private',
        displayName: 'Публичное имя',
        legalName: 'ООО Секретное юрлицо',
        inn: '7700123456',
      }),
    ]);

    await expect(service.search('production_lead', { q: '7700123456' })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    await expect(service.search('production_lead', { q: 'Публичное имя' })).resolves.toEqual({
      items: [
        {
          id: 'cp-private',
          displayName: 'Публичное имя',
          legalName: null,
          inn: null,
          billingSource: 'manual_platform',
          syncStatus: 'ready',
        },
      ],
      nextCursor: null,
    });
    expect(prisma.counterparty.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { displayName: { contains: '7700123456', mode: 'insensitive' } },
    });
    expect(prisma.counterparty.findMany.mock.calls[1]?.[0]).toMatchObject({
      where: { displayName: { contains: 'Публичное имя', mode: 'insensitive' } },
    });
  });

  it('search rejects limits above 50 before querying Prisma', async () => {
    await expect(service.search('commercial', { limit: 51 })).rejects.toMatchObject({
      status: 400,
    });
    expect(prisma.counterparty.findMany).not.toHaveBeenCalled();
  });

  it('search rejects a malformed cursor before querying Prisma', async () => {
    await expect(
      service.search('commercial', { cursor: 'not-a-counterparty-cursor', limit: 20 }),
    ).rejects.toMatchObject({ status: 400 });
    expect(prisma.counterparty.findMany).not.toHaveBeenCalled();
  });

  it('create persists a new counterparty and audits creation', async () => {
    prisma.counterparty.create.mockResolvedValue(
      cp({ id: 'cp9', displayName: 'СибПласт', legalName: null, inn: 'AB7700000000' }),
    );

    const result = await service.create(
      { userId: 'u1', role: 'commercial' },
      { displayName: 'СибПласт', inn: '  ab 77 0000 0000  ' },
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.counterparty.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          displayName: 'СибПласт',
          inn: 'AB7700000000',
          billingSource: 'manual_platform',
        }),
      }),
    );
    expect(result).toEqual(expect.objectContaining({ id: 'cp9', displayName: 'СибПласт' }));
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:commercial_counterparty_created',
        actorRole: 'commercial',
        actorId: 'u1',
      }),
      prisma,
    );
  });

  it('returns the committed unique winner after a normalized-INN P2002 race without audit', async () => {
    prisma.counterparty.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: 'counterparties_manual_inn_key' },
      }),
    );
    prisma.counterparty.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(cp({ inn: 'AB6600000000' }));

    const result = await service.create(
      { userId: 'u1', role: 'commercial' },
      { displayName: 'УралПак (дубль)', inn: ' ab 6600000000 ' },
    );

    expect(prisma.counterparty.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ inn: 'AB6600000000' }) }),
    );
    expect(prisma.counterparty.findFirst).toHaveBeenCalledWith({
      where: { inn: 'AB6600000000', billingSource: 'manual_platform' },
    });
    expect(result).toEqual(expect.objectContaining({ id: 'cp1' }));
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('reuses one 1C identity but rejects an ambiguous shared INN across branches', async () => {
    const external = cp({
      id: 'onec-1',
      inn: '6600000000',
      kpp: '660001001',
      billingSource: '1C',
    });
    prisma.counterparty.findMany.mockResolvedValueOnce([external]);

    await expect(
      service.create(
        { userId: 'u1', role: 'commercial' },
        { displayName: 'УралПак', inn: '6600000000' },
      ),
    ).resolves.toMatchObject({ id: 'onec-1' });
    expect(prisma.counterparty.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();

    prisma.counterparty.findMany.mockResolvedValueOnce([
      external,
      { ...external, id: 'onec-2', kpp: '660002002' },
    ]);
    await expect(
      service.create(
        { userId: 'u1', role: 'commercial' },
        { displayName: 'УралПак', inn: '6600000000' },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'COUNTERPARTY_INN_AMBIGUOUS' }),
    });
  });

  it('replays the manual winner even when multiple 1C branches share its INN', async () => {
    const manual = cp({ id: 'manual-1', inn: '6600000000' });
    prisma.counterparty.findFirst.mockResolvedValueOnce(manual);

    await expect(
      service.create(
        { userId: 'u1', role: 'commercial' },
        { displayName: 'Повтор', inn: '6600000000' },
      ),
    ).resolves.toMatchObject({ id: 'manual-1' });

    expect(prisma.counterparty.findMany).not.toHaveBeenCalled();
    expect(prisma.counterparty.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('recovers a non-canonical manual winner written by an older rolling node', async () => {
    prisma.counterparty.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    prisma.counterparty.findFirst.mockResolvedValue(null);
    prisma.$queryRaw.mockResolvedValueOnce([cp({ id: 'legacy-manual', inn: ' ab 6600000000 ' })]);

    await expect(
      service.create(
        { userId: 'u1', role: 'commercial' },
        { displayName: 'Повтор', inn: 'AB6600000000' },
      ),
    ).resolves.toMatchObject({ id: 'legacy-manual' });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('create without inn always inserts (no idempotency key)', async () => {
    prisma.counterparty.create.mockResolvedValue(
      cp({ id: 'cp10', displayName: 'Разовый', inn: null }),
    );
    await service.create({ userId: 'u1', role: 'commercial' }, { displayName: 'Разовый' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.counterparty.findFirst).not.toHaveBeenCalled();
    expect(prisma.counterparty.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ inn: null }) }),
    );
  });
});

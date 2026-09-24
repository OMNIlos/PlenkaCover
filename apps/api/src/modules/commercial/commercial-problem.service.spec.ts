import { BadRequestException } from '@nestjs/common';
import { CommercialProblemService } from './commercial-problem.service';

function problemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'problem-2',
    orderId: 'order-42',
    positionId: 'position-2',
    type: 'quality',
    status: 'open',
    reason: 'Толщина вне допуска',
    recovery: 'Перенастроить экструдер',
    actorRole: 'operator',
    createdAt: new Date('2026-08-03T10:00:00.000Z'),
    resolvedAt: null,
    resolutionCase: { ownerRole: 'production_lead' },
    order: {
      orderNumber: 'ЗК-42',
      title: 'Плёнка для клиента',
      positions: [
        { id: 'position-1', filmType: 'ПНД' },
        { id: 'position-2', filmType: 'ПВД' },
      ],
    },
    postId: 'post-sensitive',
    rollId: 'roll-sensitive',
    defectRecordId: 'defect-sensitive',
    resolvedById: 'user-sensitive',
    rawMeasurements: { weightKg: 12.4 },
    rawPayload: { deviceSerial: 'scale-sensitive' },
    operatorEvidence: { operatorId: 'operator-sensitive' },
    deviceEvidence: { scannerId: 'scanner-sensitive' },
    ...overrides,
  };
}

function encodeCursorFixture(value: unknown) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function makeService() {
  const prisma = {
    productionProblem: {
      findMany: jest.fn(),
    },
  };

  return {
    prisma,
    service: new CommercialProblemService(prisma as never),
  };
}

describe('CommercialProblemService', () => {
  it('returns newest order problems with safe order and position context', async () => {
    const { prisma, service } = makeService();
    prisma.productionProblem.findMany.mockResolvedValue([problemRow()]);

    const result = await service.list({ filter: 'open', limit: 20 });

    expect(result).toEqual({
      items: [
        {
          id: 'problem-2',
          orderId: 'order-42',
          orderNumber: 'ЗК-42',
          orderTitle: 'Плёнка для клиента',
          positionId: 'position-2',
          positionFilmType: 'ПВД',
          type: 'quality',
          status: 'open',
          reason: 'Толщина вне допуска',
          recovery: 'Перенастроить экструдер',
          reportedByRole: 'operator',
          ownerRole: 'production_lead',
          createdAt: '2026-08-03T10:00:00.000Z',
          resolvedAt: null,
        },
      ],
      nextCursor: null,
    });
    expect(prisma.productionProblem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: { not: null }, status: { not: 'resolved' } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 21,
      }),
    );
    expect(JSON.stringify(result)).not.toMatch(
      /postId|rollId|defectRecordId|resolvedById|rawMeasurements|rawPayload|operatorEvidence|deviceEvidence/,
    );
  });

  it.each([
    ['resolved', { orderId: { not: null }, status: 'resolved' }],
    ['all', { orderId: { not: null } }],
  ] as const)('maps the %s filter to Prisma', async (filter, where) => {
    const { prisma, service } = makeService();
    prisma.productionProblem.findMany.mockResolvedValue([]);

    await service.list({ filter, limit: 20 });

    expect(prisma.productionProblem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where }),
    );
  });

  it('uses a limit-plus-one page and resumes after an opaque deterministic cursor', async () => {
    const { prisma, service } = makeService();
    prisma.productionProblem.findMany
      .mockResolvedValueOnce([
        problemRow({
          id: 'problem-3',
          createdAt: new Date('2026-08-03T11:00:00.000Z'),
        }),
        problemRow({
          id: 'problem-2',
          createdAt: new Date('2026-08-03T10:00:00.000Z'),
        }),
        problemRow({
          id: 'problem-1',
          createdAt: new Date('2026-08-03T09:00:00.000Z'),
        }),
      ])
      .mockResolvedValueOnce([]);

    const firstPage = await service.list({ filter: 'all', limit: 2 });

    expect(firstPage.items.map(({ id }) => id)).toEqual(['problem-3', 'problem-2']);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(firstPage.nextCursor).not.toContain('problem-2');
    expect(firstPage.nextCursor).not.toContain('2026-08-03');
    expect(prisma.productionProblem.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ take: 3 }),
    );

    await service.list({
      filter: 'all',
      limit: 2,
      cursor: firstPage.nextCursor ?? undefined,
    });

    const cursorDate = new Date('2026-08-03T10:00:00.000Z');
    expect(prisma.productionProblem.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          orderId: { not: null },
          OR: [
            { createdAt: { lt: cursorDate } },
            { createdAt: cursorDate, id: { lt: 'problem-2' } },
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 3,
      }),
    );
  });

  it('keeps nullable order title, position, resolution owner, recovery, and resolution time', async () => {
    const { prisma, service } = makeService();
    prisma.productionProblem.findMany.mockResolvedValue([
      problemRow({
        positionId: null,
        recovery: null,
        resolvedAt: null,
        resolutionCase: null,
        order: {
          orderNumber: 'ЗК-42',
          title: null,
          positions: [{ id: 'position-1', filmType: 'ПНД' }],
        },
      }),
    ]);

    const result = await service.list({ filter: 'all', limit: 20 });

    expect(result.items[0]).toMatchObject({
      orderTitle: null,
      positionId: null,
      positionFilmType: null,
      recovery: null,
      ownerRole: null,
      resolvedAt: null,
    });
  });

  it.each([
    ['invalid JSON', 'not-a-cursor'],
    [
      'wrong createdAt type',
      encodeCursorFixture({ id: 'problem-2', createdAt: 0 }),
    ],
    [
      'wrong id type',
      encodeCursorFixture({ id: 2, createdAt: '2026-08-03T10:00:00.000Z' }),
    ],
    [
      'blank id',
      encodeCursorFixture({ id: '   ', createdAt: '2026-08-03T10:00:00.000Z' }),
    ],
    [
      'array payload',
      encodeCursorFixture(['problem-2', '2026-08-03T10:00:00.000Z']),
    ],
    ['non-object payload', encodeCursorFixture(null)],
    [
      'date-only timestamp',
      encodeCursorFixture({ id: 'problem-2', createdAt: '2026-08-03' }),
    ],
    [
      'noncanonical timestamp',
      encodeCursorFixture({ id: 'problem-2', createdAt: '2026-08-03T10:00:00Z' }),
    ],
    [
      'invalid timestamp',
      encodeCursorFixture({ id: 'problem-2', createdAt: 'not-a-date' }),
    ],
    [
      'padded base64url',
      `${encodeCursorFixture({
        id: 'problem-2',
        createdAt: '2026-08-03T10:00:00.000Z',
      })}=`,
    ],
    [
      'base64url with ignored characters',
      `${encodeCursorFixture({
        id: 'problem-2',
        createdAt: '2026-08-03T10:00:00.000Z',
      })}!!`,
    ],
  ])('rejects a malformed cursor with %s', async (_case, cursor) => {
    const { prisma, service } = makeService();

    await expect(service.list({ filter: 'open', limit: 20, cursor })).rejects.toEqual(
      new BadRequestException('Invalid commercial problem cursor.'),
    );
    expect(prisma.productionProblem.findMany).not.toHaveBeenCalled();
  });
});

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isBigBagScanToken, type DefectBagStatus, type DefectBagType } from '@plenka/contracts';
import type { Actor } from '../../common/auth/actor';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WarehouseBrowserSessionService } from './warehouse-browser-session.service';

export type WarehouseDefectBagMode = 'receiving' | 'shipping';

export type WarehouseDefectBagView = {
  id: string;
  code: string;
  status: DefectBagStatus;
  defectType: DefectBagType | null;
  weightKg: number;
  operatorName: string;
  postCode: string;
  postName: string;
  shiftLabel: string | null;
  weighedAt: string;
};

type DefectBagWithOrigin = {
  id: string;
  code: string;
  status: string;
  defectType: string | null;
  weightKg: number;
  weighedAt: Date;
  postSession: {
    operator: { displayName: string };
    post: { code: string; name: string };
    shift: { label: string } | null;
  };
};

type ScanInput = { operationKey: string; payload: string };
type MovementKind = 'receive' | 'ship';

const ORIGIN_INCLUDE = {
  postSession: {
    select: {
      operator: { select: { displayName: true } },
      post: { select: { code: true, name: true } },
      shift: { select: { label: true } },
    },
  },
} as const satisfies Prisma.DefectBagInclude;

@Injectable()
export class WarehouseDefectBagService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly browserSession: WarehouseBrowserSessionService,
  ) {}

  async list(mode: WarehouseDefectBagMode): Promise<WarehouseDefectBagView[]> {
    if (mode !== 'receiving' && mode !== 'shipping') {
      throw new BadRequestException({
        code: 'DEFECT_BAG_MODE_INVALID',
        message: 'mode must be receiving or shipping',
      });
    }
    const bags = await this.prisma.defectBag.findMany({
      where: { status: mode === 'receiving' ? 'ready_for_warehouse' : 'received' },
      include: ORIGIN_INCLUDE,
      orderBy: [{ weighedAt: 'asc' }, { id: 'asc' }],
    });
    return bags.map((bag) => this.project(bag));
  }

  receive(actor: Actor, input: ScanInput): Promise<WarehouseDefectBagView> {
    return this.transition(actor, input, 'receive');
  }

  ship(actor: Actor, input: ScanInput): Promise<WarehouseDefectBagView> {
    return this.transition(actor, input, 'ship');
  }

  private async transition(
    actor: Actor,
    input: ScanInput,
    kind: MovementKind,
  ): Promise<WarehouseDefectBagView> {
    if (!isBigBagScanToken(input.payload)) {
      throw new BadRequestException({
        code: 'DEFECT_BAG_QR_INVALID',
        message: 'Отсканируйте QR-код мешка брака.',
      });
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const identity = await this.browserSession.resolve(actor, tx);
        const actorId = actor.userId;
        if (!actorId)
          throw new ConflictException('Warehouse actor disappeared after authentication.');
        const token = await tx.defectBagScanToken.findUnique({
          where: { token: input.payload },
          select: { defectBagId: true },
        });
        if (!token) {
          throw new NotFoundException({
            code: 'DEFECT_BAG_QR_NOT_FOUND',
            message: 'Мешок брака по этому QR-коду не найден.',
          });
        }
        const earlyReplay = await tx.defectBagMovement.findUnique({
          where: { operationKey: input.operationKey },
        });
        if (earlyReplay) {
          return this.replayOrThrow(tx, earlyReplay, token.defectBagId, kind, actorId);
        }

        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "defect_bags" WHERE "id" = ${token.defectBagId} FOR UPDATE`,
        );
        const replay = await tx.defectBagMovement.findUnique({
          where: { operationKey: input.operationKey },
        });
        if (replay) return this.replayOrThrow(tx, replay, token.defectBagId, kind, actorId);

        const bag = await tx.defectBag.findUnique({
          where: { id: token.defectBagId },
          include: ORIGIN_INCLUDE,
        });
        if (!bag) {
          throw new NotFoundException({
            code: 'DEFECT_BAG_NOT_FOUND',
            message: 'Мешок брака не найден.',
          });
        }
        const expected = kind === 'receive' ? 'ready_for_warehouse' : 'received';
        const next = kind === 'receive' ? 'received' : 'shipped';
        if (bag.status !== expected) throw this.transitionConflict(kind);

        await tx.defectBagMovement.create({
          data: {
            operationKey: input.operationKey,
            defectBagId: bag.id,
            kind,
            actorId,
            sessionId: identity.session.id,
            postId: null,
            deviceId: null,
            captureChannel: 'warehouse_browser_hid',
          },
        });
        await tx.defectBag.update({ where: { id: bag.id }, data: { status: next } });
        await this.audit.record(
          {
            type: kind === 'receive' ? 'audit:defect_bag_received' : 'audit:defect_bag_shipped',
            actorRole: actor.role,
            actorId,
            objectId: bag.id,
            detail: {
              code: bag.code,
              defectType: bag.defectType,
              weightKg: bag.weightKg,
              status: next,
              sessionId: identity.session.id,
              captureChannel: 'warehouse_browser_hid',
            },
          },
          tx,
        );
        return this.project({ ...bag, status: next });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw this.operationKeyReused();
      }
      throw error;
    }
  }

  private async replayOrThrow(
    tx: Prisma.TransactionClient,
    movement: { defectBagId: string; kind: string; actorId: string },
    defectBagId: string,
    kind: MovementKind,
    actorId: string,
  ): Promise<WarehouseDefectBagView> {
    if (
      movement.defectBagId !== defectBagId ||
      movement.kind !== kind ||
      movement.actorId !== actorId
    ) {
      throw this.operationKeyReused();
    }
    const bag = await tx.defectBag.findUnique({
      where: { id: defectBagId },
      include: ORIGIN_INCLUDE,
    });
    if (!bag) throw new ConflictException('Stored defect-bag movement has no bag.');
    return this.project({ ...bag, status: kind === 'receive' ? 'received' : 'shipped' });
  }

  private project(bag: DefectBagWithOrigin): WarehouseDefectBagView {
    return {
      id: bag.id,
      code: bag.code,
      status: bag.status as DefectBagStatus,
      defectType: bag.defectType as DefectBagType | null,
      weightKg: bag.weightKg,
      operatorName: bag.postSession.operator.displayName,
      postCode: bag.postSession.post.code,
      postName: bag.postSession.post.name,
      shiftLabel: bag.postSession.shift?.label ?? null,
      weighedAt: bag.weighedAt.toISOString(),
    };
  }

  private transitionConflict(kind: MovementKind): ConflictException {
    return new ConflictException({
      code: kind === 'receive' ? 'DEFECT_BAG_NOT_READY_FOR_RECEIPT' : 'DEFECT_BAG_NOT_RECEIVED',
      message:
        kind === 'receive'
          ? 'Мешок брака не готов к приему.'
          : 'Перед отгрузкой мешок брака нужно принять.',
    });
  }

  private operationKeyReused(): ConflictException {
    return new ConflictException({
      code: 'DEFECT_BAG_OPERATION_KEY_REUSED',
      message: 'UUID операции уже использован для другого сканирования.',
    });
  }
}

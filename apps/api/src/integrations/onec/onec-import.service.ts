import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Role, OneCSnapshot, OneCSubjectType } from '@plenka/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import {
  ONEC_ADAPTER,
  type OneCAdapter,
  type OneCStockItem,
  type OneCStockPushAck,
} from './onec.adapter';
import { projectOneCSnapshot, type OneCSnapshotProjection } from './onec.projection';

export interface OneCImportActor {
  userId: string | null;
  role: Role;
}

export type OneCStockPushReadiness = {
  writeReady: boolean;
  readinessCode: 'ready' | 'mock_adapter' | 'write_disabled' | 'onec_unavailable';
  readinessMessage: string;
};

/**
 * Owns 1С import side effects (adapters stay pure ports): persists each pulled snapshot as a
 * `SourceSnapshot` (full, incl. admin-only rawPayload column), records an append-only `DomainEvent`
 * (`integration.onec_imported`, or `integration.onec_import_failed` + rethrow), and returns
 * business-safe **projections** (no raw, ТЗ §8). Import + retry writing events satisfies ТЗ §2/§7.
 */
@Injectable()
export class OneCImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(ONEC_ADAPTER) private readonly onec: OneCAdapter,
  ) {}

  importCounterparties(actor: OneCImportActor) {
    return this.importMany(actor, 'counterparty', () => this.onec.pullCounterparties());
  }

  importCounterparty(actor: OneCImportActor, externalId: string) {
    return this.importOne(actor, 'counterparty', () => this.onec.pullCounterparty(externalId));
  }

  importInvoice(actor: OneCImportActor, externalId: string) {
    return this.importOne(actor, 'invoice', () => this.onec.pullInvoice(externalId));
  }

  importPayments(actor: OneCImportActor) {
    return this.importMany(actor, 'payment', () => this.onec.pullPayments());
  }

  importShipments(actor: OneCImportActor) {
    return this.importMany(actor, 'shipment', () => this.onec.pullShipments());
  }

  importStock(actor: OneCImportActor) {
    return this.importMany(actor, 'stock', () => this.onec.pullStock());
  }

  async stockPushReadiness(): Promise<OneCStockPushReadiness> {
    const configuration = this.onec.stockPushConfiguration();
    if (configuration.mode !== 'http') {
      return {
        writeReady: false,
        readinessCode: 'mock_adapter',
        readinessMessage: 'Тестовая запись в 1С недоступна: активен mock-адаптер.',
      };
    }
    if (!configuration.enabled) {
      return {
        writeReady: false,
        readinessCode: 'write_disabled',
        readinessMessage: 'Запись в демо-1С выключена на VPS.',
      };
    }
    try {
      const health = await this.onec.checkHealth();
      if (health.mode === 'http' && health.status === 'ready') {
        return {
          writeReady: true,
          readinessCode: 'ready',
          readinessMessage: 'Демо-1С готова к тестовой записи.',
        };
      }
    } catch {
      // Readiness is deliberately a safe projection; transport details stay in admin diagnostics.
    }
    return {
      writeReady: false,
      readinessCode: 'onec_unavailable',
      readinessMessage: 'Демо-1С сейчас недоступна или не прошла HTTP-проверку.',
    };
  }

  async pushStock(actor: OneCImportActor, items: OneCStockItem[]) {
    if (items.length === 0) {
      throw new BadRequestException('1С stock push requires at least one item.');
    }
    let ack: OneCStockPushAck;
    try {
      const readiness = await this.stockPushReadiness();
      if (!readiness.writeReady) {
        throw new ServiceUnavailableException({
          code: 'ONEC_STOCK_PUSH_NOT_READY',
          message: readiness.readinessMessage,
        });
      }
      ack = await this.onec.pushStock(items);
      if (
        ack.mode !== 'http' ||
        ack.accepted !== true ||
        ack.documentCreated !== true ||
        ack.count !== items.length ||
        !ack.ref
      ) {
        throw new ServiceUnavailableException(
          '1С did not confirm a created and posted HTTP document.',
        );
      }
    } catch (error) {
      await this.audit.record({
        type: 'integration.onec_import_failed',
        actorRole: actor.role,
        actorId: actor.userId,
        label: 'onec_stock_push',
        reason: error instanceof Error ? error.message : 'unknown 1С stock push error',
        detail: { direction: 'push', subjectType: 'stock', count: items.length },
      });
      throw error;
    }
    await this.audit.record({
      type: 'integration.onec_imported',
      actorRole: actor.role,
      actorId: actor.userId,
      label: 'onec_stock_push',
      detail: {
        direction: 'push',
        subjectType: 'stock',
        mode: ack.mode,
        documentCreated: ack.documentCreated,
        count: ack.count,
        ref: ack.ref,
      },
    });
    return ack;
  }

  private async importOne<TParsed>(
    actor: OneCImportActor,
    subjectType: OneCSubjectType,
    pull: () => Promise<OneCSnapshot<TParsed>>,
  ): Promise<OneCSnapshotProjection<TParsed>> {
    const imported = await this.importMany(actor, subjectType, async () => [await pull()]);
    return imported[0];
  }

  private async importMany<TParsed>(
    actor: OneCImportActor,
    subjectType: OneCSubjectType,
    pull: () => Promise<OneCSnapshot<TParsed>[]>,
  ): Promise<OneCSnapshotProjection<TParsed>[]> {
    let snaps: OneCSnapshot<TParsed>[];
    try {
      snaps = await pull();
    } catch (err) {
      await this.audit.record({
        type: 'integration.onec_import_failed',
        actorRole: actor.role,
        actorId: actor.userId,
        label: `onec_import_${subjectType}`,
        reason: err instanceof Error ? err.message : 'unknown 1С import error',
      });
      throw err;
    }

    for (const snap of snaps) {
      await this.prisma.sourceSnapshot.create({
        data: {
          sourceKind: snap.sourceKind,
          subjectType: snap.subjectType,
          // subjectId links to an internal record; reconciling externalId→local id is a
          // later concern (finance/commercial import flows), so it stays null on raw import.
          subjectId: null,
          externalId: snap.externalId,
          sourceVersion: snap.sourceVersion,
          ownerRole: actor.role,
          capturedAt: new Date(snap.capturedAt),
          importedAt: new Date(),
          checkedAt: new Date(),
          staleness: snap.staleness,
          parsed: snap.parsed as unknown as Prisma.InputJsonValue,
          rawPayload: snap.rawPayload as Prisma.InputJsonValue,
        },
      });
      await this.audit.record({
        type: 'integration.onec_imported',
        actorRole: actor.role,
        actorId: actor.userId,
        label: `onec_import_${subjectType}`,
        // NB: no rawPayload in the event detail — metadata only (ТЗ §8).
        detail: { subjectType, externalId: snap.externalId, sourceVersion: snap.sourceVersion },
      });
    }

    return snaps.map(projectOneCSnapshot);
  }
}

import { ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  OneCCounterpartySnapshot,
  OneCInvoiceLineSource,
  OneCInvoiceSnapshot,
  OneCNomenclatureSnapshot,
  OneCOrganizationSnapshot,
  OneCPaymentSnapshot,
  OneCProductionMaterialLineSource,
  OneCProductionOutputLineSource,
  OneCProductionReportSnapshot,
  OneCShipmentLineSource,
  OneCShipmentSnapshot,
  OneCSnapshot,
  OneCStockSnapshot,
  OneCSyncCounters,
  OneCSyncMode,
  OneCSyncResult,
  OneCWarehouseSnapshot,
  Role,
} from '@plenka/contracts';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { RuntimeConfig } from '../../common/runtime-config';
import { RUNTIME_CONFIG } from '../../common/runtime-config.module';
import { normalizeCatalogName } from '../../modules/material-catalog/recipe-catalog.rules';
import { ONEC_ADAPTER, type OneCAdapter, type OneCListOptions } from './onec.adapter';

const APPLY_BATCH_SIZE = 100;
const ACTIVE_SCOPE_KEY = 'onec:full-sync';
const DEFAULT_PAGE_SIZE = 250;
const MATERIAL_NORMALIZED_NAME_MAX_LENGTH = 120;
const PRODUCTION_QUANTITY_INTEGER_DIGITS = 12;
const PRODUCTION_QUANTITY_SCALE = 6;
const PRODUCTION_TRANSACTION_TIMEOUT_MS = 120_000;

export interface OneCSyncActor {
  userId: string | null;
  role: Role;
}

type SyncCounters = {
  nomenclature: OneCSyncCounters;
  counterparty: OneCSyncCounters;
  organization: OneCSyncCounters;
  warehouse: OneCSyncCounters;
  invoice: OneCSyncCounters;
  payment: OneCSyncCounters;
  shipment: OneCSyncCounters;
  production_report: OneCSyncCounters;
  production_output_line: OneCSyncCounters;
  production_material_line: OneCSyncCounters;
  stock: OneCSyncCounters;
};
type ExistingNomenclature = {
  externalId: string;
  sourceVersion: string | null;
  rawMaterialDefinitionId?: string | null;
};
type ExistingCounterparty = {
  id: string;
  externalId: string | null;
  sourceVersion: string | null;
  inn: string | null;
  kpp: string | null;
};
type ExistingBalance = {
  accountExternalId: string;
  organizationExternalId: string;
  nomenclatureExternalId: string;
  quantity: unknown;
  amount: unknown;
};
type ProductionLineRecord = {
  reportExternalId: string;
  lineNumber: number;
  nomenclatureExternalId: string | null;
  productExternalId?: string | null;
  unitExternalId: string | null;
  unitName: string | null;
  quantity: unknown;
};
type ExistingProductionReport = {
  externalId: string;
  sourceVersion: string | null;
  number: string;
  date: Date | null;
  posted: boolean;
  deleted: boolean;
  organizationExternalId: string | null;
  warehouseExternalId: string | null;
  departmentExternalId: string | null;
  outputLines: ProductionLineRecord[];
  materialLines: ProductionLineRecord[];
};
type ProductionReportRecord = Omit<
  ExistingProductionReport,
  'date' | 'outputLines' | 'materialLines'
> & {
  date: string | Date | null;
};

function emptyCounters(fetched: number): OneCSyncCounters {
  return { fetched, created: 0, updated: 0, unchanged: 0, conflicts: 0 };
}

function balanceIdentity(
  value: Pick<
    ExistingBalance,
    'accountExternalId' | 'organizationExternalId' | 'nomenclatureExternalId'
  >,
): string {
  return [value.accountExternalId, value.organizationExternalId, value.nomenclatureExternalId].join(
    ':',
  );
}

function numericValue(value: unknown): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error('ONEC_INVALID_BALANCE_NUMBER');
  return result;
}

function balanceVersion(quantity: unknown, amount: unknown): string {
  return createHash('sha256')
    .update(`${numericValue(quantity)}:${numericValue(amount)}`)
    .digest('hex');
}

function canonicalProductionQuantity(value: unknown): string {
  let decimal: Prisma.Decimal;
  try {
    decimal = new Prisma.Decimal(value as Prisma.Decimal.Value);
  } catch {
    throw new Error('ONEC_INVALID_PRODUCTION_QUANTITY');
  }
  const integerDigits = decimal.abs().trunc().toFixed(0).replace(/^0+/, '').length;
  if (
    !decimal.isFinite() ||
    decimal.decimalPlaces() > PRODUCTION_QUANTITY_SCALE ||
    integerDigits > PRODUCTION_QUANTITY_INTEGER_DIGITS
  ) {
    throw new Error('ONEC_INVALID_PRODUCTION_QUANTITY');
  }
  if (decimal.isZero()) return '0';
  return decimal.toFixed(decimal.decimalPlaces());
}

function productionLineRecord(
  line: OneCProductionOutputLineSource | OneCProductionMaterialLineSource,
): ProductionLineRecord {
  return {
    reportExternalId: line.reportExternalId,
    lineNumber: line.parsed.lineNumber,
    nomenclatureExternalId: line.parsed.nomenclatureExternalId,
    productExternalId: 'productExternalId' in line.parsed ? line.parsed.productExternalId : null,
    unitExternalId: line.parsed.unitExternalId,
    unitName: line.parsed.unitName,
    quantity: line.parsed.quantity,
  };
}

function productionLineIdentity(line: ProductionLineRecord): string {
  return `${line.reportExternalId}:${line.lineNumber}`;
}

function productionLineFingerprint(line: ProductionLineRecord): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        reportExternalId: line.reportExternalId,
        lineNumber: line.lineNumber,
        nomenclatureExternalId: line.nomenclatureExternalId,
        productExternalId: line.productExternalId ?? null,
        unitExternalId: line.unitExternalId,
        unitName: line.unitName,
        quantity: canonicalProductionQuantity(line.quantity),
      }),
    )
    .digest('hex');
}

function fingerprintDate(value: string | Date | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('ONEC_INVALID_DATE');
  return date.toISOString();
}

function productionReportFingerprint(
  report: ProductionReportRecord,
  outputLines: ProductionLineRecord[],
  materialLines: ProductionLineRecord[],
): string {
  const lineFingerprints = (lines: ProductionLineRecord[]) =>
    lines
      .map((line) => productionLineFingerprint(line))
      .sort((left, right) => left.localeCompare(right));

  return createHash('sha256')
    .update(
      JSON.stringify({
        externalId: report.externalId,
        sourceVersion: report.sourceVersion,
        number: report.number,
        date: fingerprintDate(report.date),
        posted: report.posted,
        deleted: report.deleted,
        organizationExternalId: report.organizationExternalId,
        warehouseExternalId: report.warehouseExternalId,
        departmentExternalId: report.departmentExternalId,
        outputLines: lineFingerprints(outputLines),
        materialLines: lineFingerprints(materialLines),
      }),
    )
    .digest('hex');
}

function sourceDate(value: string | null): Date | null {
  if (!value) return null;
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw new Error('ONEC_INVALID_DATE');
  return result;
}

function duplicateOneCMaterialNormalizedName(normalizedName: string, externalId: string): string {
  const suffix = ` · 1c:${externalId.toLowerCase()}`;
  const prefixLength = Math.max(0, MATERIAL_NORMALIZED_NAME_MAX_LENGTH - [...suffix].length);
  return `${[...normalizedName].slice(0, prefixLength).join('')}${suffix}`;
}

function isUniqueConflict(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'P2002')
  );
}

function errorCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    typeof (error as { response?: unknown }).response === 'object'
  ) {
    const response = (error as { response: { code?: unknown } }).response;
    if (typeof response.code === 'string') return response.code;
  }
  if (error instanceof Error && /^ONEC_[A-Z0-9_]+/.test(error.message)) {
    return error.message.match(/^ONEC_[A-Z0-9_]+/)?.[0] ?? 'ONEC_SYNC_FAILED';
  }
  return 'ONEC_SYNC_FAILED';
}

@Injectable()
export class OneCSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(ONEC_ADAPTER) private readonly onec: OneCAdapter,
    @Inject(RUNTIME_CONFIG)
    private readonly config: Pick<RuntimeConfig, 'onecSyncPageSize'> = {
      onecSyncPageSize: DEFAULT_PAGE_SIZE,
    },
  ) {}

  async fetchAll<T>(
    readPage: (options: OneCListOptions) => Promise<T[]>,
    identity: (item: T) => string | null = (item) => {
      if (typeof item !== 'object' || item === null || !('externalId' in item)) return null;
      const value = (item as { externalId?: unknown }).externalId;
      return typeof value === 'string' && value.length > 0 ? value : null;
    },
  ): Promise<T[]> {
    const pageSize = this.config.onecSyncPageSize;
    const result: T[] = [];
    const identities = new Set<string>();
    for (let skip = 0; ; skip += pageSize) {
      const page = await readPage({ top: pageSize, skip });
      for (const item of page) {
        const itemIdentity = identity(item);
        if (itemIdentity) {
          if (identities.has(itemIdentity)) {
            throw new Error(`ONEC_DUPLICATE_EXTERNAL_ID: ${itemIdentity}`);
          }
          identities.add(itemIdentity);
        }
        result.push(item);
      }
      if (page.length < pageSize) return result;
    }
  }

  sourceFingerprint(snapshot: OneCSnapshot<unknown>, changeIdentity?: string): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          subjectType: snapshot.subjectType,
          externalId: snapshot.externalId,
          sourceVersion: snapshot.sourceVersion,
          parsed: snapshot.parsed,
          ...(changeIdentity ? { changeIdentity } : {}),
        }),
      )
      .digest('hex');
  }

  async run(actor: OneCSyncActor, mode: OneCSyncMode): Promise<OneCSyncResult> {
    const activeScopeKey = mode === 'preview' ? null : ACTIVE_SCOPE_KEY;
    let runId: string | null = null;
    let startedAt = new Date();

    try {
      const run = await this.prisma.oneCSyncRun.create({
        data: {
          mode,
          status: 'running',
          activeScopeKey,
          actorId: actor.userId,
          actorRole: actor.role,
        },
      });
      runId = run.id;
      startedAt = run.startedAt;
    } catch (error) {
      if (isUniqueConflict(error)) {
        throw new ConflictException({
          code: 'ONEC_SYNC_IN_PROGRESS',
          message: 'Another 1С full synchronization is already running.',
        });
      }
      throw error;
    }

    try {
      if (mode !== 'preview') {
        await this.audit.record({
          type: 'integration.onec_sync_started',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: runId,
          label: 'onec_full_sync',
          detail: { runId, mode },
        });
      }

      this.assertReadOnly();
      const health = await this.onec.checkHealth();
      if (health.status !== 'ready') {
        throw new ServiceUnavailableException({
          code: 'ONEC_UNAVAILABLE',
          message: '1С is not ready for synchronization.',
        });
      }

      const incomingNomenclature = await this.fetchAll((options) =>
        this.onec.pullNomenclature(options),
      );
      const incomingCounterparties = await this.fetchAll((options) =>
        this.onec.pullCounterparties(options),
      );
      const incomingOrganizations = await this.fetchAll((options) =>
        this.onec.pullOrganizations(options),
      );
      const incomingWarehouses = await this.fetchAll((options) =>
        this.onec.pullWarehouses(options),
      );
      const incomingInvoices = await this.fetchAll((options) => this.onec.pullInvoices(options));
      const incomingInvoiceLines = await this.fetchAll(
        (options) => this.onec.pullInvoiceLines(options),
        (line) => `${line.invoiceExternalId}:${line.parsed.lineNumber}`,
      );
      const incomingPayments = await this.fetchAll((options) => this.onec.pullPayments(options));
      const incomingShipments = await this.fetchAll((options) => this.onec.pullShipments(options));
      const incomingShipmentLines = await this.fetchAll(
        (options) => this.onec.pullShipmentLines(options),
        (line) => `${line.shipmentExternalId}:${line.parsed.lineNumber}`,
      );
      const incomingProductionReports = await this.fetchAll((options) =>
        this.onec.pullProductionReports(options),
      );
      const incomingProductionOutputLines = await this.fetchAll(
        (options) => this.onec.pullProductionOutputLines(options),
        (line) => `${line.reportExternalId}:${line.parsed.lineNumber}`,
      );
      const incomingProductionMaterialLines = await this.fetchAll(
        (options) => this.onec.pullProductionMaterialLines(options),
        (line) => `${line.reportExternalId}:${line.parsed.lineNumber}`,
      );
      for (const line of [...incomingProductionOutputLines, ...incomingProductionMaterialLines]) {
        canonicalProductionQuantity(line.parsed.quantity);
      }
      const incomingBalances = [
        ...(await this.fetchAll(
          (options) => this.onec.pullBalances('10.01', options),
          (snapshot) => this.balanceSnapshotIdentity(snapshot),
        )),
        ...(await this.fetchAll(
          (options) => this.onec.pullBalances('41.01', options),
          (snapshot) => this.balanceSnapshotIdentity(snapshot),
        )),
      ];
      const existingNomenclature = await this.prisma.oneCNomenclatureItem.findMany({
        select: { externalId: true, sourceVersion: true, rawMaterialDefinitionId: true },
      });
      const existingCounterparties = await this.prisma.counterparty.findMany({
        select: {
          id: true,
          externalId: true,
          sourceVersion: true,
          inn: true,
          kpp: true,
        },
      });
      const existingOrganizations = await this.prisma.oneCOrganization.findMany({
        select: { externalId: true, sourceVersion: true },
      });
      const existingWarehouses = await this.prisma.oneCWarehouse.findMany({
        select: { externalId: true, sourceVersion: true },
      });
      const existingInvoices = await this.prisma.oneCInvoice.findMany({
        select: { externalId: true, sourceVersion: true },
      });
      const existingPayments = await this.prisma.oneCPayment.findMany({
        select: { externalId: true, sourceVersion: true },
      });
      const existingShipments = await this.prisma.oneCShipment.findMany({
        select: { externalId: true, sourceVersion: true },
      });
      const existingProductionReports = await this.prisma.oneCProductionReport.findMany({
        select: {
          externalId: true,
          sourceVersion: true,
          number: true,
          date: true,
          posted: true,
          deleted: true,
          organizationExternalId: true,
          warehouseExternalId: true,
          departmentExternalId: true,
          outputLines: {
            select: {
              reportExternalId: true,
              lineNumber: true,
              nomenclatureExternalId: true,
              unitExternalId: true,
              unitName: true,
              quantity: true,
            },
          },
          materialLines: {
            select: {
              reportExternalId: true,
              lineNumber: true,
              nomenclatureExternalId: true,
              productExternalId: true,
              unitExternalId: true,
              unitName: true,
              quantity: true,
            },
          },
        },
      });
      const existingBalances = await this.prisma.oneCStockBalance.findMany({
        select: {
          accountExternalId: true,
          organizationExternalId: true,
          nomenclatureExternalId: true,
          quantity: true,
          amount: true,
        },
      });
      const incomingProductionReportIds = new Set(
        incomingProductionReports.flatMap((report) =>
          report.externalId ? [report.externalId] : [],
        ),
      );
      const productionReportDiff = this.diffProductionReports(
        incomingProductionReports,
        incomingProductionOutputLines,
        incomingProductionMaterialLines,
        existingProductionReports,
      );
      const counters: SyncCounters = {
        nomenclature: this.diffSnapshots(incomingNomenclature, existingNomenclature),
        counterparty: this.diffSnapshots(
          incomingCounterparties,
          existingCounterparties.filter(
            (item): item is ExistingCounterparty & { externalId: string } =>
              item.externalId !== null,
          ),
        ),
        organization: this.diffSnapshots(incomingOrganizations, existingOrganizations),
        warehouse: this.diffSnapshots(incomingWarehouses, existingWarehouses),
        invoice: this.diffSnapshots(incomingInvoices, existingInvoices),
        payment: this.diffSnapshots(incomingPayments, existingPayments),
        shipment: this.diffSnapshots(incomingShipments, existingShipments),
        production_report: productionReportDiff.counters,
        production_output_line: this.diffProductionLines(
          incomingProductionOutputLines,
          existingProductionReports.flatMap((report) => report.outputLines),
          incomingProductionReportIds,
        ),
        production_material_line: this.diffProductionLines(
          incomingProductionMaterialLines,
          existingProductionReports.flatMap((report) => report.materialLines),
          incomingProductionReportIds,
        ),
        stock: this.diffBalances(incomingBalances, existingBalances),
      };

      if (mode !== 'preview') {
        const accountRawMaterialExternalIds = new Set(
          incomingBalances.flatMap((snapshot) =>
            snapshot.parsed.accountCode === '10.01' && snapshot.parsed.nomenclatureExternalId
              ? [snapshot.parsed.nomenclatureExternalId]
              : [],
          ),
        );
        await this.applyNomenclature(
          actor,
          incomingNomenclature,
          new Map(existingNomenclature.map((item) => [item.externalId, item.sourceVersion])),
          counters.nomenclature,
          new Set(
            existingNomenclature
              .filter((item) => item.rawMaterialDefinitionId === null)
              .map((item) => item.externalId),
          ),
          accountRawMaterialExternalIds,
        );
        await this.applyCounterparties(
          actor,
          incomingCounterparties,
          existingCounterparties,
          counters.counterparty,
        );
        await this.applyOrganizations(
          actor,
          incomingOrganizations,
          new Map(existingOrganizations.map((item) => [item.externalId, item.sourceVersion])),
        );
        await this.applyWarehouses(
          actor,
          incomingWarehouses,
          new Map(existingWarehouses.map((item) => [item.externalId, item.sourceVersion])),
        );
        const knownNomenclature = new Set([
          ...existingNomenclature.map((item) => item.externalId),
          ...incomingNomenclature.flatMap((item) => (item.externalId ? [item.externalId] : [])),
        ]);
        const knownOrganizations = new Set([
          ...existingOrganizations.map((item) => item.externalId),
          ...incomingOrganizations.flatMap((item) => (item.externalId ? [item.externalId] : [])),
        ]);
        const knownInvoices = new Set([
          ...existingInvoices.map((item) => item.externalId),
          ...incomingInvoices.flatMap((item) => (item.externalId ? [item.externalId] : [])),
        ]);
        await this.applyInvoices(
          actor,
          incomingInvoices,
          incomingInvoiceLines,
          new Map(existingInvoices.map((item) => [item.externalId, item.sourceVersion])),
          knownNomenclature,
          counters.invoice,
        );
        await this.applyPayments(
          actor,
          incomingPayments,
          new Map(existingPayments.map((item) => [item.externalId, item.sourceVersion])),
          knownInvoices,
        );
        await this.applyShipments(
          actor,
          incomingShipments,
          incomingShipmentLines,
          new Map(existingShipments.map((item) => [item.externalId, item.sourceVersion])),
          knownInvoices,
          knownNomenclature,
          counters.shipment,
        );
        await this.applyProductionReports(
          actor,
          runId,
          incomingProductionReports,
          incomingProductionOutputLines,
          incomingProductionMaterialLines,
          productionReportDiff.changedExternalIds,
        );
        await this.applyBalances(
          actor,
          incomingBalances,
          existingBalances,
          knownOrganizations,
          knownNomenclature,
          counters.stock,
        );
        if (Object.values(counters).some((counter) => counter.conflicts > 0)) {
          await this.audit.record({
            type: 'problem:onec_mapping_conflict',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: runId,
            label: 'onec_mapping_conflict',
            detail: { runId, counters } as unknown as Prisma.InputJsonValue,
          });
        }
      }

      const completedAt = new Date();
      const allCounters = counters;
      await this.prisma.oneCSyncRun.update({
        where: { id: runId },
        data: {
          status: 'completed',
          activeScopeKey: null,
          counters: allCounters as unknown as Prisma.InputJsonValue,
          completedAt,
        },
      });
      await this.audit.record({
        type: mode === 'preview' ? 'audit:onec_sync_previewed' : 'integration.onec_sync_completed',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: runId,
        label: 'onec_full_sync',
        detail: { runId, mode, counters: allCounters } as unknown as Prisma.InputJsonValue,
      });

      return {
        id: runId,
        mode,
        status: 'completed',
        counters: allCounters,
        errorCode: null,
        recovery: null,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
      };
    } catch (error) {
      const code = errorCode(error);
      const completedAt = new Date();
      await this.prisma.oneCSyncRun.update({
        where: { id: runId },
        data: {
          status: 'failed',
          activeScopeKey: null,
          errorCode: code,
          recovery: 'Check 1С health, credentials and reconciliation before retrying.',
          completedAt,
        },
      });
      await this.audit.record({
        type: 'integration.onec_sync_failed',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: runId,
        label: 'onec_full_sync',
        detail: { runId, mode, errorCode: code },
      });
      throw error;
    }
  }

  private assertReadOnly(): void {
    const writeConfiguration = this.onec.stockPushConfiguration();
    if (writeConfiguration.enabled) {
      throw new ConflictException({
        code: 'ONEC_READ_ONLY_REQUIRED',
        message: 'Production synchronization requires ONEC_WRITE=false.',
      });
    }
  }

  private diffSnapshots(
    incoming: Array<{ externalId: string | null; sourceVersion: string | null }>,
    existing: ExistingNomenclature[],
  ): OneCSyncCounters {
    const counters = emptyCounters(incoming.length);
    const versions = new Map(existing.map((item) => [item.externalId, item.sourceVersion]));
    for (const snapshot of incoming) {
      if (!snapshot.externalId) {
        counters.conflicts += 1;
      } else if (!versions.has(snapshot.externalId)) {
        counters.created += 1;
      } else if (versions.get(snapshot.externalId) === snapshot.sourceVersion) {
        counters.unchanged += 1;
      } else {
        counters.updated += 1;
      }
    }
    return counters;
  }

  private balanceSnapshotIdentity(snapshot: OneCStockSnapshot): string | null {
    const parsed = snapshot.parsed;
    if (!parsed.account || !parsed.organizationExternalId || !parsed.nomenclatureExternalId) {
      return null;
    }
    return balanceIdentity({
      accountExternalId: parsed.account,
      organizationExternalId: parsed.organizationExternalId,
      nomenclatureExternalId: parsed.nomenclatureExternalId,
    });
  }

  private diffBalances(
    incoming: OneCStockSnapshot[],
    existing: ExistingBalance[],
  ): OneCSyncCounters {
    const counters = emptyCounters(incoming.length);
    const versions = new Map(
      existing.map((item) => [balanceIdentity(item), balanceVersion(item.quantity, item.amount)]),
    );
    for (const snapshot of incoming) {
      const identity = this.balanceSnapshotIdentity(snapshot);
      if (!identity) {
        counters.conflicts += 1;
        continue;
      }
      const version = balanceVersion(snapshot.parsed.qty, snapshot.parsed.amount);
      if (!versions.has(identity)) counters.created += 1;
      else if (versions.get(identity) === version) counters.unchanged += 1;
      else counters.updated += 1;
    }
    return counters;
  }

  private diffProductionLines(
    incoming: Array<OneCProductionOutputLineSource | OneCProductionMaterialLineSource>,
    existing: ProductionLineRecord[],
    incomingReportIds: ReadonlySet<string>,
  ): OneCSyncCounters {
    const counters = emptyCounters(incoming.length);
    const fingerprints = new Map(
      existing.map((line) => [productionLineIdentity(line), productionLineFingerprint(line)]),
    );
    for (const source of incoming) {
      if (!incomingReportIds.has(source.reportExternalId)) {
        counters.conflicts += 1;
        continue;
      }
      const line = productionLineRecord(source);
      const identity = productionLineIdentity(line);
      const fingerprint = productionLineFingerprint(line);
      if (!fingerprints.has(identity)) counters.created += 1;
      else if (fingerprints.get(identity) === fingerprint) counters.unchanged += 1;
      else counters.updated += 1;
    }
    return counters;
  }

  private diffProductionReports(
    incoming: OneCProductionReportSnapshot[],
    outputLineStream: OneCProductionOutputLineSource[],
    materialLineStream: OneCProductionMaterialLineSource[],
    existing: ExistingProductionReport[],
  ): { counters: OneCSyncCounters; changedExternalIds: Set<string> } {
    const counters = emptyCounters(incoming.length);
    const changedExternalIds = new Set<string>();
    const existingByExternalId = new Map(existing.map((report) => [report.externalId, report]));
    const outputLinesByReport = this.productionLinesByReport(outputLineStream);
    const materialLinesByReport = this.productionLinesByReport(materialLineStream);

    for (const snapshot of incoming) {
      if (!snapshot.externalId) {
        counters.conflicts += 1;
        continue;
      }
      const current = existingByExternalId.get(snapshot.externalId);
      if (!current) {
        counters.created += 1;
        changedExternalIds.add(snapshot.externalId);
        continue;
      }
      const parsed = snapshot.parsed;
      const incomingFingerprint = productionReportFingerprint(
        {
          externalId: snapshot.externalId,
          sourceVersion: snapshot.sourceVersion,
          number: parsed.number,
          date: parsed.date,
          posted: parsed.posted,
          deleted: parsed.deleted,
          organizationExternalId: parsed.organizationExternalId,
          warehouseExternalId: parsed.warehouseExternalId,
          departmentExternalId: parsed.departmentExternalId,
        },
        outputLinesByReport.get(snapshot.externalId) ?? [],
        materialLinesByReport.get(snapshot.externalId) ?? [],
      );
      const currentFingerprint = productionReportFingerprint(
        current,
        current.outputLines,
        current.materialLines,
      );
      if (incomingFingerprint === currentFingerprint) {
        counters.unchanged += 1;
      } else {
        counters.updated += 1;
        changedExternalIds.add(snapshot.externalId);
      }
    }
    return { counters, changedExternalIds };
  }

  private productionLinesByReport(
    lines: Array<OneCProductionOutputLineSource | OneCProductionMaterialLineSource>,
  ): Map<string, ProductionLineRecord[]> {
    const result = new Map<string, ProductionLineRecord[]>();
    for (const source of lines) {
      const reportLines = result.get(source.reportExternalId) ?? [];
      reportLines.push(productionLineRecord(source));
      result.set(source.reportExternalId, reportLines);
    }
    return result;
  }

  private async applyNomenclature(
    actor: OneCSyncActor,
    incoming: OneCNomenclatureSnapshot[],
    existingVersions: ReadonlyMap<string, string | null>,
    counters: OneCSyncCounters,
    unboundNomenclature: ReadonlySet<string>,
    accountRawMaterialExternalIds: ReadonlySet<string>,
  ): Promise<void> {
    const changed = incoming.filter(
      (snapshot) =>
        snapshot.externalId &&
        (!existingVersions.has(snapshot.externalId) ||
          existingVersions.get(snapshot.externalId) !== snapshot.sourceVersion ||
          (unboundNomenclature.has(snapshot.externalId) &&
            (snapshot.parsed.kindName === 'Сырье' ||
              accountRawMaterialExternalIds.has(snapshot.externalId)) &&
            !snapshot.parsed.deleted &&
            !snapshot.parsed.archived)),
    );
    for (let offset = 0; offset < changed.length; offset += APPLY_BATCH_SIZE) {
      const batch = changed.slice(offset, offset + APPLY_BATCH_SIZE);
      await this.prisma.$transaction(async (tx) => {
        for (const snapshot of batch) {
          await this.applyNomenclatureSnapshot(
            tx,
            actor,
            snapshot,
            counters,
            Boolean(
              snapshot.externalId &&
              (snapshot.parsed.kindName === 'Сырье' ||
                accountRawMaterialExternalIds.has(snapshot.externalId)),
            ),
          );
        }
      });
    }
  }

  private async applyNomenclatureSnapshot(
    tx: Prisma.TransactionClient,
    actor: OneCSyncActor,
    snapshot: OneCNomenclatureSnapshot,
    counters: OneCSyncCounters,
    projectAsRawMaterial: boolean,
  ): Promise<void> {
    if (!snapshot.externalId) {
      counters.conflicts += 1;
      return;
    }
    const parsed = snapshot.parsed;
    const mirrorData = {
      sourceVersion: snapshot.sourceVersion,
      code: parsed.code,
      article: parsed.article,
      name: parsed.name,
      fullName: parsed.fullName,
      kindExternalId: parsed.kindExternalId,
      kindName: parsed.kindName,
      unitExternalId: parsed.unitExternalId,
      unitName: parsed.unitName,
      deleted: parsed.deleted,
      archived: parsed.archived,
      capturedAt: new Date(snapshot.capturedAt),
      syncedAt: new Date(),
    };
    await tx.oneCNomenclatureItem.upsert({
      where: { externalId: snapshot.externalId },
      create: { externalId: snapshot.externalId, ...mirrorData },
      update: mirrorData,
    });
    await this.appendSnapshot(tx, actor, snapshot);

    if (!projectAsRawMaterial && !parsed.deleted && !parsed.archived) return;
    const bindingId = await this.projectRawMaterial(tx, actor, snapshot, projectAsRawMaterial);
    if (bindingId) {
      await tx.oneCNomenclatureItem.update({
        where: { externalId: snapshot.externalId },
        data: { rawMaterialDefinitionId: bindingId },
      });
    }
  }

  private async appendSnapshot<TParsed>(
    tx: Prisma.TransactionClient,
    actor: OneCSyncActor,
    snapshot: OneCSnapshot<TParsed>,
    changeIdentity?: string,
  ): Promise<void> {
    await tx.sourceSnapshot.createMany({
      data: {
        sourceFingerprint: this.sourceFingerprint(snapshot, changeIdentity),
        sourceKind: snapshot.sourceKind,
        subjectType: snapshot.subjectType,
        externalId: snapshot.externalId,
        sourceVersion: snapshot.sourceVersion,
        ownerRole: actor.role,
        capturedAt: new Date(snapshot.capturedAt),
        importedAt: new Date(),
        checkedAt: new Date(),
        staleness: snapshot.staleness,
        parsed: snapshot.parsed as unknown as Prisma.InputJsonValue,
        rawPayload: snapshot.rawPayload as Prisma.InputJsonValue,
      },
      skipDuplicates: true,
    });
  }

  private async projectRawMaterial(
    tx: Prisma.TransactionClient,
    actor: OneCSyncActor,
    snapshot: OneCNomenclatureSnapshot,
    allowCreate: boolean,
  ): Promise<string | null> {
    if (!snapshot.externalId) return null;
    const parsed = snapshot.parsed;
    const sourceData = {
      name: parsed.name,
      sourceVersion: snapshot.sourceVersion,
      sourceCode: parsed.code,
      sourceArticle: parsed.article,
      sourceUnit: parsed.unitName,
      sourceKind: '1C',
      status: parsed.deleted || parsed.archived ? 'archived' : 'active',
      isProductionSelectable: true,
    };
    const byExternalId = await tx.rawMaterialDefinition.findUnique({
      where: { externalId: snapshot.externalId },
      select: { id: true },
    });
    if (byExternalId) {
      await tx.rawMaterialDefinition.update({
        where: { id: byExternalId.id },
        data: sourceData,
      });
      return byExternalId.id;
    }

    if (parsed.deleted || parsed.archived || !allowCreate) return null;
    const normalizedName = normalizeCatalogName(parsed.name);
    const nameMatch = await tx.rawMaterialDefinition.findUnique({
      where: { normalizedName },
      select: { id: true, externalId: true },
    });
    if (nameMatch?.externalId === null) {
      await tx.rawMaterialDefinition.update({
        where: { id: nameMatch.id },
        data: { ...sourceData, externalId: snapshot.externalId },
      });
      return nameMatch.id;
    }
    const materialNormalizedName = nameMatch
      ? duplicateOneCMaterialNormalizedName(normalizedName, snapshot.externalId)
      : normalizedName;

    const created = await tx.rawMaterialDefinition.create({
      data: {
        ...sourceData,
        externalId: snapshot.externalId,
        normalizedName: materialNormalizedName,
        kind: 'custom',
        createdById: actor.userId,
        createdByRole: actor.role,
      },
      select: { id: true },
    });
    return created.id;
  }

  private async applyInvoices(
    actor: OneCSyncActor,
    incoming: OneCInvoiceSnapshot[],
    lineStream: OneCInvoiceLineSource[],
    existingVersions: ReadonlyMap<string, string | null>,
    knownNomenclature: ReadonlySet<string>,
    counters: OneCSyncCounters,
  ): Promise<void> {
    const linesByInvoice = new Map<string, OneCInvoiceLineSource[]>();
    for (const line of lineStream) {
      const lines = linesByInvoice.get(line.invoiceExternalId) ?? [];
      lines.push(line);
      linesByInvoice.set(line.invoiceExternalId, lines);
    }
    const changed = incoming.filter(
      (snapshot) =>
        snapshot.externalId &&
        (!existingVersions.has(snapshot.externalId) ||
          existingVersions.get(snapshot.externalId) !== snapshot.sourceVersion),
    );
    for (let offset = 0; offset < changed.length; offset += APPLY_BATCH_SIZE) {
      const batch = changed.slice(offset, offset + APPLY_BATCH_SIZE);
      await this.prisma.$transaction(async (tx) => {
        for (const snapshot of batch) {
          if (!snapshot.externalId) continue;
          const parsed = snapshot.parsed;
          const data = {
            sourceVersion: snapshot.sourceVersion,
            number: parsed.invoiceNo,
            date: sourceDate(parsed.date),
            posted: parsed.posted,
            deleted: parsed.deleted ?? false,
            counterpartyExternalId: parsed.counterpartyExternalId,
            organizationExternalId: parsed.organizationExternalId ?? null,
            currencyExternalId: parsed.currencyExternalId ?? null,
            currency: parsed.currency,
            orderReference: parsed.orderReference ?? null,
            subtotal: parsed.subtotal ?? null,
            taxTotal: parsed.taxTotal ?? null,
            total: parsed.total,
            capturedAt: new Date(snapshot.capturedAt),
            syncedAt: new Date(),
          };
          await tx.oneCInvoice.upsert({
            where: { externalId: snapshot.externalId },
            create: { externalId: snapshot.externalId, ...data },
            update: data,
          });
          const lines = linesByInvoice.get(snapshot.externalId) ?? [];
          for (const line of lines) {
            const lineData = {
              invoiceExternalId: snapshot.externalId,
              lineNumber: line.parsed.lineNumber,
              nomenclatureExternalId:
                line.parsed.nomenclatureExternalId &&
                knownNomenclature.has(line.parsed.nomenclatureExternalId)
                  ? line.parsed.nomenclatureExternalId
                  : null,
              name: line.parsed.name,
              quantity: line.parsed.quantity,
              price: line.parsed.price,
              amount: line.parsed.amount,
              unitExternalId: line.parsed.unitExternalId,
              taxRate: line.parsed.taxRate ?? null,
              taxAmount: line.parsed.taxAmount ?? null,
            };
            if (line.parsed.nomenclatureExternalId && lineData.nomenclatureExternalId === null) {
              counters.conflicts += 1;
            }
            await tx.oneCInvoiceLine.upsert({
              where: {
                invoiceExternalId_lineNumber: {
                  invoiceExternalId: snapshot.externalId,
                  lineNumber: line.parsed.lineNumber,
                },
              },
              create: lineData,
              update: lineData,
            });
          }
          await tx.oneCInvoiceLine.deleteMany({
            where: {
              invoiceExternalId: snapshot.externalId,
              ...(lines.length > 0
                ? { lineNumber: { notIn: lines.map((line) => line.parsed.lineNumber) } }
                : {}),
            },
          });
          await this.appendSnapshot(tx, actor, {
            ...snapshot,
            parsed: { ...parsed, lines: lines.map((line) => line.parsed) },
          });
        }
      });
    }
  }

  private async applyPayments(
    actor: OneCSyncActor,
    incoming: OneCPaymentSnapshot[],
    existingVersions: ReadonlyMap<string, string | null>,
    knownInvoices: ReadonlySet<string>,
  ): Promise<void> {
    const changed = incoming.filter(
      (snapshot) =>
        snapshot.externalId &&
        (!existingVersions.has(snapshot.externalId) ||
          existingVersions.get(snapshot.externalId) !== snapshot.sourceVersion),
    );
    for (let offset = 0; offset < changed.length; offset += APPLY_BATCH_SIZE) {
      const batch = changed.slice(offset, offset + APPLY_BATCH_SIZE);
      await this.prisma.$transaction(async (tx) => {
        for (const snapshot of batch) {
          if (!snapshot.externalId) continue;
          const parsed = snapshot.parsed;
          const invoiceExternalId =
            parsed.invoiceExternalId && knownInvoices.has(parsed.invoiceExternalId)
              ? parsed.invoiceExternalId
              : null;
          const data = {
            sourceVersion: snapshot.sourceVersion,
            number: parsed.number,
            date: sourceDate(parsed.date),
            posted: parsed.posted,
            deleted: parsed.deleted ?? false,
            counterpartyExternalId: parsed.counterpartyExternalId,
            organizationExternalId: parsed.organizationExternalId ?? null,
            amount: parsed.amount,
            currency: parsed.currency ?? null,
            orderReference: parsed.orderReference ?? null,
            invoiceNumberReference: null,
            documentBasisExternalId: parsed.documentBasisExternalId ?? null,
            documentBasisType: parsed.documentBasisType ?? null,
            invoiceExternalId,
            capturedAt: new Date(snapshot.capturedAt),
            syncedAt: new Date(),
          };
          await tx.oneCPayment.upsert({
            where: { externalId: snapshot.externalId },
            create: { externalId: snapshot.externalId, ...data },
            update: data,
          });
          await this.appendSnapshot(tx, actor, snapshot);
        }
      });
    }
  }

  private async applyShipments(
    actor: OneCSyncActor,
    incoming: OneCShipmentSnapshot[],
    lineStream: OneCShipmentLineSource[],
    existingVersions: ReadonlyMap<string, string | null>,
    knownInvoices: ReadonlySet<string>,
    knownNomenclature: ReadonlySet<string>,
    counters: OneCSyncCounters,
  ): Promise<void> {
    const linesByShipment = new Map<string, OneCShipmentLineSource[]>();
    for (const line of lineStream) {
      const lines = linesByShipment.get(line.shipmentExternalId) ?? [];
      lines.push(line);
      linesByShipment.set(line.shipmentExternalId, lines);
    }
    const changed = incoming.filter(
      (snapshot) =>
        snapshot.externalId &&
        (!existingVersions.has(snapshot.externalId) ||
          existingVersions.get(snapshot.externalId) !== snapshot.sourceVersion),
    );
    for (let offset = 0; offset < changed.length; offset += APPLY_BATCH_SIZE) {
      const batch = changed.slice(offset, offset + APPLY_BATCH_SIZE);
      await this.prisma.$transaction(async (tx) => {
        for (const snapshot of batch) {
          if (!snapshot.externalId) continue;
          const parsed = snapshot.parsed;
          const invoiceExternalId =
            parsed.invoiceExternalId && knownInvoices.has(parsed.invoiceExternalId)
              ? parsed.invoiceExternalId
              : null;
          const data = {
            sourceVersion: snapshot.sourceVersion,
            number: parsed.number,
            date: sourceDate(parsed.date),
            posted: parsed.posted,
            deleted: parsed.deleted ?? false,
            counterpartyExternalId: parsed.counterpartyExternalId,
            organizationExternalId: parsed.organizationExternalId ?? null,
            total: parsed.total,
            invoiceExternalId,
            capturedAt: new Date(snapshot.capturedAt),
            syncedAt: new Date(),
          };
          await tx.oneCShipment.upsert({
            where: { externalId: snapshot.externalId },
            create: { externalId: snapshot.externalId, ...data },
            update: data,
          });
          const lines = linesByShipment.get(snapshot.externalId) ?? [];
          for (const line of lines) {
            const lineData = {
              shipmentExternalId: snapshot.externalId,
              lineNumber: line.parsed.lineNumber,
              nomenclatureExternalId:
                line.parsed.nomenclatureExternalId &&
                knownNomenclature.has(line.parsed.nomenclatureExternalId)
                  ? line.parsed.nomenclatureExternalId
                  : null,
              name: line.parsed.name,
              quantity: line.parsed.quantity,
              price: line.parsed.price,
              amount: line.parsed.amount,
              unitExternalId: line.parsed.unitExternalId,
            };
            if (line.parsed.nomenclatureExternalId && lineData.nomenclatureExternalId === null) {
              counters.conflicts += 1;
            }
            await tx.oneCShipmentLine.upsert({
              where: {
                shipmentExternalId_lineNumber: {
                  shipmentExternalId: snapshot.externalId,
                  lineNumber: line.parsed.lineNumber,
                },
              },
              create: lineData,
              update: lineData,
            });
          }
          await tx.oneCShipmentLine.deleteMany({
            where: {
              shipmentExternalId: snapshot.externalId,
              ...(lines.length > 0
                ? { lineNumber: { notIn: lines.map((line) => line.parsed.lineNumber) } }
                : {}),
            },
          });
          await this.appendSnapshot(tx, actor, {
            ...snapshot,
            parsed: { ...parsed, lines: lines.map((line) => line.parsed) },
          });
        }
      });
    }
  }

  private async applyProductionReports(
    actor: OneCSyncActor,
    runId: string | null,
    incoming: OneCProductionReportSnapshot[],
    outputLineStream: OneCProductionOutputLineSource[],
    materialLineStream: OneCProductionMaterialLineSource[],
    changedExternalIds: ReadonlySet<string>,
  ): Promise<void> {
    const changed = incoming.filter(
      (snapshot): snapshot is OneCProductionReportSnapshot & { externalId: string } =>
        Boolean(snapshot.externalId && changedExternalIds.has(snapshot.externalId)),
    );
    if (changed.length === 0) return;
    if (!runId) throw new Error('ONEC_SYNC_RUN_ID_REQUIRED');
    const outputLinesByReport = new Map<string, OneCProductionOutputLineSource[]>();
    for (const line of outputLineStream) {
      const reportLines = outputLinesByReport.get(line.reportExternalId) ?? [];
      reportLines.push(line);
      outputLinesByReport.set(line.reportExternalId, reportLines);
    }
    const materialLinesByReport = new Map<string, OneCProductionMaterialLineSource[]>();
    for (const line of materialLineStream) {
      const reportLines = materialLinesByReport.get(line.reportExternalId) ?? [];
      reportLines.push(line);
      materialLinesByReport.set(line.reportExternalId, reportLines);
    }

    for (let offset = 0; offset < changed.length; offset += APPLY_BATCH_SIZE) {
      const batch = changed.slice(offset, offset + APPLY_BATCH_SIZE);
      const applyBatch = async (tx: Prisma.TransactionClient) => {
        for (const snapshot of batch) {
          const reportExternalId = snapshot.externalId;
          const parsed = snapshot.parsed;
          const data = {
            sourceVersion: snapshot.sourceVersion,
            number: parsed.number,
            date: sourceDate(parsed.date),
            posted: parsed.posted,
            deleted: parsed.deleted,
            organizationExternalId: parsed.organizationExternalId,
            warehouseExternalId: parsed.warehouseExternalId,
            departmentExternalId: parsed.departmentExternalId,
            capturedAt: new Date(snapshot.capturedAt),
            syncedAt: new Date(),
          };
          await tx.oneCProductionReport.upsert({
            where: { externalId: reportExternalId },
            create: { externalId: reportExternalId, ...data },
            update: data,
          });

          const outputLines = (outputLinesByReport.get(reportExternalId) ?? []).sort(
            (left, right) => left.parsed.lineNumber - right.parsed.lineNumber,
          );
          for (const line of outputLines) {
            const lineData = {
              reportExternalId,
              lineNumber: line.parsed.lineNumber,
              nomenclatureExternalId: line.parsed.nomenclatureExternalId,
              unitExternalId: line.parsed.unitExternalId,
              unitName: line.parsed.unitName,
              quantity: canonicalProductionQuantity(line.parsed.quantity),
            };
            await tx.oneCProductionOutputLine.upsert({
              where: {
                reportExternalId_lineNumber: {
                  reportExternalId,
                  lineNumber: line.parsed.lineNumber,
                },
              },
              create: lineData,
              update: lineData,
            });
          }
          await tx.oneCProductionOutputLine.deleteMany({
            where: {
              reportExternalId,
              ...(outputLines.length > 0
                ? { lineNumber: { notIn: outputLines.map((line) => line.parsed.lineNumber) } }
                : {}),
            },
          });

          const materialLines = (materialLinesByReport.get(reportExternalId) ?? []).sort(
            (left, right) => left.parsed.lineNumber - right.parsed.lineNumber,
          );
          for (const line of materialLines) {
            const lineData = {
              reportExternalId,
              lineNumber: line.parsed.lineNumber,
              nomenclatureExternalId: line.parsed.nomenclatureExternalId,
              productExternalId: line.parsed.productExternalId,
              unitExternalId: line.parsed.unitExternalId,
              unitName: line.parsed.unitName,
              quantity: canonicalProductionQuantity(line.parsed.quantity),
            };
            await tx.oneCProductionMaterialLine.upsert({
              where: {
                reportExternalId_lineNumber: {
                  reportExternalId,
                  lineNumber: line.parsed.lineNumber,
                },
              },
              create: lineData,
              update: lineData,
            });
          }
          await tx.oneCProductionMaterialLine.deleteMany({
            where: {
              reportExternalId,
              ...(materialLines.length > 0
                ? { lineNumber: { notIn: materialLines.map((line) => line.parsed.lineNumber) } }
                : {}),
            },
          });

          await this.appendSnapshot(
            tx,
            actor,
            {
              ...snapshot,
              parsed: {
                ...parsed,
                outputLines: outputLines.map((line) => line.parsed),
                materialLines: materialLines.map((line) => line.parsed),
              },
            },
            `onec-sync:${runId}:production-report:${reportExternalId}`,
          );
        }
      };
      await this.prisma.$transaction(applyBatch, {
        timeout: PRODUCTION_TRANSACTION_TIMEOUT_MS,
      });
    }
  }

  private async applyBalances(
    actor: OneCSyncActor,
    incoming: OneCStockSnapshot[],
    existing: ExistingBalance[],
    knownOrganizations: ReadonlySet<string>,
    knownNomenclature: ReadonlySet<string>,
    counters: OneCSyncCounters,
  ): Promise<void> {
    const existingVersions = new Map(
      existing.map((item) => [balanceIdentity(item), balanceVersion(item.quantity, item.amount)]),
    );
    const changed = incoming.filter((snapshot) => {
      const identity = this.balanceSnapshotIdentity(snapshot);
      if (!identity) return false;
      const version = balanceVersion(snapshot.parsed.qty, snapshot.parsed.amount);
      return !existingVersions.has(identity) || existingVersions.get(identity) !== version;
    });
    for (let offset = 0; offset < changed.length; offset += APPLY_BATCH_SIZE) {
      const batch = changed.slice(offset, offset + APPLY_BATCH_SIZE);
      await this.prisma.$transaction(async (tx) => {
        for (const snapshot of batch) {
          const parsed = snapshot.parsed;
          if (
            !parsed.account ||
            !parsed.accountCode ||
            !parsed.organizationExternalId ||
            !parsed.nomenclatureExternalId
          ) {
            continue;
          }
          if (
            !knownOrganizations.has(parsed.organizationExternalId) ||
            !knownNomenclature.has(parsed.nomenclatureExternalId)
          ) {
            counters.conflicts += 1;
            continue;
          }
          const identity = balanceIdentity({
            accountExternalId: parsed.account,
            organizationExternalId: parsed.organizationExternalId,
            nomenclatureExternalId: parsed.nomenclatureExternalId,
          });
          const data = {
            accountCode: parsed.accountCode,
            quantity: parsed.qty,
            amount: parsed.amount,
            capturedAt: new Date(snapshot.capturedAt),
            syncedAt: new Date(),
          };
          await tx.oneCStockBalance.upsert({
            where: {
              accountExternalId_organizationExternalId_nomenclatureExternalId: {
                accountExternalId: parsed.account,
                organizationExternalId: parsed.organizationExternalId,
                nomenclatureExternalId: parsed.nomenclatureExternalId,
              },
            },
            create: {
              accountExternalId: parsed.account,
              organizationExternalId: parsed.organizationExternalId,
              nomenclatureExternalId: parsed.nomenclatureExternalId,
              ...data,
            },
            update: data,
          });
          await this.appendSnapshot(tx, actor, {
            ...snapshot,
            externalId: `balance:${identity}`,
            sourceVersion: balanceVersion(parsed.qty, parsed.amount),
          });
        }
      });
    }
  }

  private async applyCounterparties(
    actor: OneCSyncActor,
    incoming: OneCCounterpartySnapshot[],
    existing: ExistingCounterparty[],
    counters: OneCSyncCounters,
  ): Promise<void> {
    const sourceVersions = new Map(
      existing
        .filter(
          (item): item is ExistingCounterparty & { externalId: string } => item.externalId !== null,
        )
        .map((item) => [item.externalId, item.sourceVersion]),
    );
    const changed = incoming.filter(
      (snapshot) =>
        snapshot.externalId &&
        (!sourceVersions.has(snapshot.externalId) ||
          sourceVersions.get(snapshot.externalId) !== snapshot.sourceVersion),
    );

    for (let offset = 0; offset < changed.length; offset += APPLY_BATCH_SIZE) {
      const batch = changed.slice(offset, offset + APPLY_BATCH_SIZE);
      await this.prisma.$transaction(async (tx) => {
        for (const snapshot of batch) {
          await this.applyCounterpartySnapshot(tx, actor, snapshot, existing, counters);
        }
      });
    }
  }

  private async applyCounterpartySnapshot(
    tx: Prisma.TransactionClient,
    actor: OneCSyncActor,
    snapshot: OneCCounterpartySnapshot,
    existing: ExistingCounterparty[],
    counters: OneCSyncCounters,
  ): Promise<void> {
    if (!snapshot.externalId) {
      counters.conflicts += 1;
      return;
    }
    await this.appendSnapshot(tx, actor, snapshot);
    const parsed = snapshot.parsed;
    const sourceData = {
      displayName: parsed.displayName,
      legalName: parsed.legalName,
      inn: parsed.inn,
      kpp: parsed.kpp,
      sourceCode: parsed.code,
      billingSource: '1C',
      syncStatus: parsed.deleted ? 'stale' : 'ready',
      externalId: snapshot.externalId,
      sourceVersion: snapshot.sourceVersion,
    };
    const byExternalId = existing.find((item) => item.externalId === snapshot.externalId);
    if (byExternalId) {
      await tx.counterparty.update({
        where: { id: byExternalId.id },
        data: sourceData,
      });
      return;
    }

    const identityMatches =
      parsed.inn && parsed.kpp
        ? existing.filter(
            (item) =>
              item.externalId === null && item.inn === parsed.inn && item.kpp === parsed.kpp,
          )
        : [];
    if (identityMatches.length > 1) {
      counters.created = Math.max(0, counters.created - 1);
      counters.conflicts += 1;
      return;
    }
    if (identityMatches.length === 1) {
      await tx.counterparty.update({
        where: { id: identityMatches[0].id },
        data: sourceData,
      });
      return;
    }
    await tx.counterparty.create({ data: sourceData });
  }

  private async applyOrganizations(
    actor: OneCSyncActor,
    incoming: OneCOrganizationSnapshot[],
    existingVersions: ReadonlyMap<string, string | null>,
  ): Promise<void> {
    const changed = incoming.filter(
      (snapshot) =>
        snapshot.externalId &&
        (!existingVersions.has(snapshot.externalId) ||
          existingVersions.get(snapshot.externalId) !== snapshot.sourceVersion),
    );
    for (let offset = 0; offset < changed.length; offset += APPLY_BATCH_SIZE) {
      const batch = changed.slice(offset, offset + APPLY_BATCH_SIZE);
      await this.prisma.$transaction(async (tx) => {
        for (const snapshot of batch) {
          if (!snapshot.externalId) continue;
          const parsed = snapshot.parsed;
          const data = {
            sourceVersion: snapshot.sourceVersion,
            code: parsed.code,
            name: parsed.name,
            fullName: parsed.fullName,
            inn: parsed.inn,
            kpp: parsed.kpp,
            deleted: parsed.deleted,
            capturedAt: new Date(snapshot.capturedAt),
            syncedAt: new Date(),
          };
          await tx.oneCOrganization.upsert({
            where: { externalId: snapshot.externalId },
            create: { externalId: snapshot.externalId, ...data },
            update: data,
          });
          await this.appendSnapshot(tx, actor, snapshot);
        }
      });
    }
  }

  private async applyWarehouses(
    actor: OneCSyncActor,
    incoming: OneCWarehouseSnapshot[],
    existingVersions: ReadonlyMap<string, string | null>,
  ): Promise<void> {
    const changed = incoming.filter(
      (snapshot) =>
        snapshot.externalId &&
        (!existingVersions.has(snapshot.externalId) ||
          existingVersions.get(snapshot.externalId) !== snapshot.sourceVersion),
    );
    for (let offset = 0; offset < changed.length; offset += APPLY_BATCH_SIZE) {
      const batch = changed.slice(offset, offset + APPLY_BATCH_SIZE);
      await this.prisma.$transaction(async (tx) => {
        for (const snapshot of batch) {
          if (!snapshot.externalId) continue;
          const parsed = snapshot.parsed;
          const data = {
            sourceVersion: snapshot.sourceVersion,
            code: parsed.code,
            name: parsed.name,
            warehouseType: parsed.warehouseType,
            deleted: parsed.deleted,
            capturedAt: new Date(snapshot.capturedAt),
            syncedAt: new Date(),
          };
          await tx.oneCWarehouse.upsert({
            where: { externalId: snapshot.externalId },
            create: { externalId: snapshot.externalId, ...data },
            update: data,
          });
          await this.appendSnapshot(tx, actor, snapshot);
        }
      });
    }
  }
}

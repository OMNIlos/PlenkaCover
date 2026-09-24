import type { WarehouseWorkbench, WorkObject } from './types';
import { resolveWarehouseSection } from './warehouseSections';

export const WAREHOUSE_SCAN_SECTIONS = ['Приемка', 'Выдача'] as const;

export type WarehouseScanSection = (typeof WAREHOUSE_SCAN_SECTIONS)[number];

export function normalizeWarehouseSection(section: string): string {
  return resolveWarehouseSection(section).section;
}

export function isWarehouseScanSection(section: string): boolean {
  const normalized = normalizeWarehouseSection(section);
  return WAREHOUSE_SCAN_SECTIONS.some((candidate) => candidate === normalized);
}

export function warehouseScanMode(section: string): WarehouseWorkbench['mode'] {
  return normalizeWarehouseSection(section) === 'Приемка' ? 'receiving' : 'delivery';
}

export function warehousePalletScanIntent(section: string): 'handoff' | 'delivery' {
  return normalizeWarehouseSection(section) === 'Выдача' ? 'delivery' : 'handoff';
}

export function warehouseObjectMatchesScanSection(object: WorkObject, section: string): boolean {
  const normalized = normalizeWarehouseSection(section);
  const tags = normalized === 'Выдача' ? ['Выдача', 'Отгрузка'] : ['Приемка'];

  return (
    isWarehouseScanSection(normalized) &&
    object.workbench?.type === 'warehouse' &&
    object.workbench.mode === warehouseScanMode(normalized) &&
    tags.some((tag) => object.filterTags?.includes(tag))
  );
}

export function decodeWarehouseScanAction(actionId: string): string | null {
  const match = actionId.match(/^warehouse\.scan:[^:]+:(.+)$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]).trim() || null;
  } catch {
    return null;
  }
}

export function replaceObjectSelectionInUrl(href: string, objectId: string | null): URL {
  const url = new URL(href);
  if (objectId) url.searchParams.set('object', objectId);
  else url.searchParams.delete('object');
  return url;
}

export class WarehouseScanSubmissionGate {
  private tail: Promise<void> | null = null;
  private readonly pendingByPayload = new Map<string, Promise<boolean>>();

  run(payload: string, submit: (payload: string) => Promise<boolean>): Promise<boolean> {
    const duplicate = this.pendingByPayload.get(payload);
    if (duplicate) return duplicate;
    let submission: Promise<boolean>;
    try {
      submission = this.tail ? this.tail.then(() => submit(payload)) : submit(payload);
    } catch (error) {
      submission = Promise.reject(error);
    }
    let sequence!: Promise<void>;
    const request = submission.finally(() => {
      if (this.pendingByPayload.get(payload) === request) this.pendingByPayload.delete(payload);
      if (this.tail === sequence) this.tail = null;
    });
    this.pendingByPayload.set(payload, request);
    sequence = request.then(
      () => undefined,
      () => undefined,
    );
    this.tail = sequence;
    return request;
  }
}

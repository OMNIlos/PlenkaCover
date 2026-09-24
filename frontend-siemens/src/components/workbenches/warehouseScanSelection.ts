import type { Role, WorkObject } from '../../domain/types';
import { warehouseScanMode } from '../../domain/warehouseScan';

export function requestedRoleSelectionId(
  role: Role,
  activeRole: Role,
  requestedObjectId: string | null,
  objects: WorkObject[],
): string | null {
  if (role !== activeRole || !requestedObjectId) return null;
  if (
    role === 'director' ||
    role === 'warehouse' ||
    objects.some((object) => object.id === requestedObjectId)
  ) {
    return requestedObjectId;
  }
  return null;
}

export function warehouseScanSelectionId(
  objects: WorkObject[],
  selectedObjectId: string | null | undefined,
  section: string,
): string | null {
  const expectedMode = warehouseScanMode(section);
  if (!selectedObjectId) {
    return (
      objects.find(
        (object) =>
          object.workbench?.type === 'warehouse' && object.workbench.mode === expectedMode,
      )?.id ?? null
    );
  }
  return objects.some(
    (object) =>
      object.id === selectedObjectId &&
      object.workbench?.type === 'warehouse' &&
      object.workbench.mode === expectedMode,
  )
    ? selectedObjectId
    : null;
}

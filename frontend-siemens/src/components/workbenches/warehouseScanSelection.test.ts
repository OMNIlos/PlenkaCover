import { describe, expect, it } from 'vitest';

import type { WorkObject } from '../../domain/types';
import {
  requestedRoleSelectionId,
  warehouseScanSelectionId,
} from './warehouseScanSelection';

function operation(id: string, mode: 'receiving' | 'delivery'): WorkObject {
  return {
    id,
    workbench: { type: 'warehouse', mode },
  } as WorkObject;
}

describe('warehouseScanSelectionId', () => {
  it('keeps a receiving operation selected even when the outer queue does not contain it', () => {
    expect(
      warehouseScanSelectionId(
        [operation('intake-a-58', 'receiving'), operation('intake-a-240', 'receiving')],
        'intake-a-240',
        'Приемка',
      ),
    ).toBe('intake-a-240');
  });

  it('rejects a delivery operation in the receiving station', () => {
    expect(
      warehouseScanSelectionId(
        [operation('intake-a-58', 'receiving'), operation('delivery-a-240', 'delivery')],
        'delivery-a-240',
        'Приемка',
      ),
    ).toBeNull();
  });

  it('selects the first receiving operation when no object is selected', () => {
    expect(
      warehouseScanSelectionId(
        [operation('intake-a-58', 'receiving')],
        null,
        'Приемка',
      ),
    ).toBe('intake-a-58');
  });
});

describe('requestedRoleSelectionId', () => {
  it('keeps a live warehouse operation from the URL until API hydration validates it', () => {
    expect(requestedRoleSelectionId('warehouse', 'warehouse', 'intake-live', [])).toBe(
      'intake-live',
    );
  });

  it('does not accept an unknown object for another role', () => {
    expect(requestedRoleSelectionId('finance', 'finance', 'finance-live', [])).toBeNull();
  });
});

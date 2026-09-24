import { describe, expect, it } from 'vitest';

import {
  createIntakeDraftPosition,
  intakePositionMissingFields,
} from './prototypeRuntime';

function validPosition() {
  return {
    ...createIntakeDraftPosition(1),
    widthMm: '1700',
    plannedLengthM: '275',
    plannedWeightKg: '41.2',
    baseRawMaterialDefinitionId: 'material-primary',
  };
}

describe('intake position validation', () => {
  it('rejects values outside the bounded position catalogs', () => {
    expect(
      intakePositionMissingFields({
        ...validPosition(),
        filmType: 'Пятый тип',
        birka: 'Произвольная',
        spoolType: 'Самодельная',
      }),
    ).toEqual(expect.arrayContaining(['тип пленки', 'бирка', 'шпуля']));
  });

  it('mirrors the API numeric limits before submit', () => {
    expect(
      intakePositionMissingFields({
        ...validPosition(),
        rollCount: '1.5',
        widthMm: '100000.001',
        plannedLengthM: '10000000.001',
        plannedWeightKg: '41.0001',
      }),
    ).toEqual(
      expect.arrayContaining(['количество рулонов', 'ширина', 'метраж', 'вес']),
    );
  });
});

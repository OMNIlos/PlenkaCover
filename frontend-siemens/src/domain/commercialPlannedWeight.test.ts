import { describe, expect, it } from 'vitest';

import {
  COMMERCIAL_PLANNED_WEIGHT_ERROR,
  parseCommercialPlannedWeightKg,
} from './commercialPlannedWeight';

describe('commercial planned weight', () => {
  it.each([
    ['38', 38],
    ['37.5', 37.5],
    ['37,001', 37.001],
    ['0.001', 0.001],
    ['100000', 100_000],
  ])('parses %s exactly', (value, expected) => {
    expect(parseCommercialPlannedWeightKg(value)).toBe(expected);
  });

  it.each(['', '0', '-1', '37.0001', '100000.001', '1e3', 'NaN'])('rejects %s', (value) => {
    expect(parseCommercialPlannedWeightKg(value)).toBeNull();
  });

  it('keeps the public validation copy stable', () => {
    expect(COMMERCIAL_PLANNED_WEIGHT_ERROR).toBe(
      'Введите вес от 0,001 до 100 000 кг, не более трёх знаков после запятой.',
    );
  });
});

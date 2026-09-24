import { describe, expect, it } from 'vitest';

import { missingRequiredTemplateFields } from './templates';

describe('client template dimension validation', () => {
  it('blocks non-positive and out-of-range roll dimensions', () => {
    const fields = [
      {
        label: 'Ширина, мм',
        value: '-1',
        kind: 'production' as const,
        required: true,
      },
      {
        label: 'Метраж, м',
        value: '10000001',
        kind: 'production' as const,
        required: true,
      },
    ];

    expect(missingRequiredTemplateFields(fields)).toEqual(fields);
  });

  it('accepts bounded decimal roll dimensions with a comma separator', () => {
    expect(
      missingRequiredTemplateFields([
        {
          label: 'Ширина, мм',
          value: '1650,5',
          kind: 'production',
          required: true,
        },
        {
          label: 'Метраж, м',
          value: '420,25',
          kind: 'production',
          required: true,
        },
      ]),
    ).toEqual([]);
  });
});

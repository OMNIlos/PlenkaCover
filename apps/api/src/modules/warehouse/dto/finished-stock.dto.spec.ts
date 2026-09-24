import { instanceToPlain, plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { FinishedStockItemResponseDto, FinishedStockQueryDto } from './finished-stock.dto';

async function validateDto(input: Record<string, unknown>) {
  return validate(plainToInstance(FinishedStockQueryDto, input));
}

describe('finished stock DTOs', () => {
  it.each(['available', 'processed'])('accepts the %s lifecycle bucket', async (bucket) => {
    expect(await validateDto({ bucket })).toEqual([]);
  });

  it('rejects an unknown lifecycle bucket', async () => {
    expect(await validateDto({ bucket: 'reserved' })).not.toEqual([]);
  });

  it('does not serialize technical source or reservation fields', () => {
    const item = Object.assign(new FinishedStockItemResponseDto(), {
      id: 'roll-1',
      rollCode: 'R-1',
      batchCode: 'B-1',
      weightKg: 12.5,
      recipe: 'recipe',
      specification: 'specification',
      ageDays: 1,
      processedAt: null,
      sourceOrderId: 'order-1',
      availability: 'reserved',
      reservedForOrderId: 'order-2',
    });

    expect(instanceToPlain(item)).not.toHaveProperty('sourceOrderId');
    expect(instanceToPlain(item)).not.toHaveProperty('availability');
    expect(instanceToPlain(item)).not.toHaveProperty('reservedForOrderId');
  });
});

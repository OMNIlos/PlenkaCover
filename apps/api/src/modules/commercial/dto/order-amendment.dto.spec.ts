import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CommercialOrderAmendmentDto, OrderCancellationCommandDto } from './order-amendment.dto';

const OPERATION_KEY = '8C5C69EF-6BD3-4E25-9829-D32DA8CD75DC';

const position = {
  rollCount: 2,
  filmType: 'Рукав',
  actualThickness: '80',
  accountingThickness: '78',
  widthMm: 1700,
  plannedLengthM: 275,
  baseRawMaterialDefinitionId: 'material-1',
  birka: 'ГОСТ',
};

async function errors(value: Record<string, unknown>) {
  return validate(plainToInstance(CommercialOrderAmendmentDto, value), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

describe('CommercialOrderAmendmentDto', () => {
  it('accepts an exact add-position command and canonicalizes its UUIDv4', async () => {
    const dto = plainToInstance(CommercialOrderAmendmentDto, {
      kind: 'add_position',
      operationKey: OPERATION_KEY,
      expectedOrderVersion: 3,
      reason: '  Клиент добавил два рулона  ',
      position,
    });

    await expect(
      validate(dto, { whitelist: true, forbidNonWhitelisted: true }),
    ).resolves.toHaveLength(0);
    expect(dto.operationKey).toBe(OPERATION_KEY.toLowerCase());
    expect(dto.reason).toBe('Клиент добавил два рулона');
  });

  it('accepts an exact update-position command', async () => {
    await expect(
      errors({
        kind: 'update_position',
        operationKey: OPERATION_KEY,
        expectedOrderVersion: 3,
        expectedPositionVersion: 2,
        reason: 'Уточнены размеры',
        positionId: 'position-1',
        changes: { widthMm: 1600, plannedLengthM: 300 },
      }),
    ).resolves.toHaveLength(0);
  });

  it('accepts an exact cancel-remaining command', async () => {
    await expect(
      errors({
        kind: 'cancel_remaining_position',
        operationKey: OPERATION_KEY,
        expectedOrderVersion: 3,
        expectedPositionVersion: 2,
        reason: 'Остаток больше не нужен',
        positionId: 'position-1',
      }),
    ).resolves.toHaveLength(0);
  });

  it.each([
    {
      name: 'blank reason',
      value: {
        kind: 'cancel_remaining_position',
        operationKey: OPERATION_KEY,
        expectedOrderVersion: 3,
        expectedPositionVersion: 2,
        reason: '   ',
        positionId: 'position-1',
      },
    },
    {
      name: 'non-v4 operation key',
      value: {
        kind: 'cancel_remaining_position',
        operationKey: '00000000-0000-1000-8000-000000000000',
        expectedOrderVersion: 3,
        expectedPositionVersion: 2,
        reason: 'Отмена',
        positionId: 'position-1',
      },
    },
    {
      name: 'fields from another discriminator branch',
      value: {
        kind: 'update_position',
        operationKey: OPERATION_KEY,
        expectedOrderVersion: 3,
        expectedPositionVersion: 2,
        reason: 'Правка',
        positionId: 'position-1',
        changes: { widthMm: 1600 },
        position,
      },
    },
    {
      name: 'empty changes',
      value: {
        kind: 'update_position',
        operationKey: OPERATION_KEY,
        expectedOrderVersion: 3,
        expectedPositionVersion: 2,
        reason: 'Правка',
        positionId: 'position-1',
        changes: {},
      },
    },
  ])('rejects $name', async ({ value }) => {
    expect(await errors(value)).not.toHaveLength(0);
  });

  it('validates and normalizes an order cancellation command', async () => {
    const dto = plainToInstance(OrderCancellationCommandDto, {
      operationKey: OPERATION_KEY,
      expectedVersion: 4,
      reason: '  Клиент отменил остаток  ',
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto).toMatchObject({
      operationKey: OPERATION_KEY.toLowerCase(),
      expectedVersion: 4,
      reason: 'Клиент отменил остаток',
    });
    await expect(
      validate(
        plainToInstance(OrderCancellationCommandDto, {
          operationKey: OPERATION_KEY,
          expectedVersion: 4,
          reason: '   ',
        }),
      ),
    ).resolves.not.toHaveLength(0);
  });
});

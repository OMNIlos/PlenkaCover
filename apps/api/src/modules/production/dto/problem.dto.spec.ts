import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MarkRollDefectDto, ResolveProblemDto } from './problem.dto';

async function errors(type: new () => object, value: object) {
  return validate(plainToInstance(type, value), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

describe('production defect DTOs', () => {
  it.each([
    [MarkRollDefectDto, { reason: 'Визуальный дефект', weightKg: 12.5 }],
    [ResolveProblemDto, { resolution: 'writeoff', note: 'Списать целиком', weightKg: 12.5 }],
  ] as const)('%s rejects browser-owned defect weight', async (type, body) => {
    const result = await errors(type, body);

    expect(result.some((error) => error.constraints?.whitelistValidation)).toBe(true);
  });

  it.each(['', ' ', '\n', 'x'.repeat(1001)])(
    'rejects unusable production defect reason %j',
    async (reason) => {
      expect(await errors(MarkRollDefectDto, { reason })).not.toHaveLength(0);
    },
  );

  it.each([
    ['rework', undefined],
    ['writeoff', undefined],
    ['rework', ' '],
    ['writeoff', 'x'.repeat(1001)],
    ['close', undefined],
    ['close', ' '],
    ['close', 'x'.repeat(1001)],
  ] as const)('requires a bounded nonblank note for %s', async (resolution, note) => {
    expect(await errors(ResolveProblemDto, { resolution, note })).not.toHaveLength(0);
  });

  it('accepts close with a bounded nonblank note', async () => {
    expect(
      await errors(ResolveProblemDto, {
        resolution: 'close',
        note: 'Сырьё доставлено, выпуск продолжен',
      }),
    ).toHaveLength(0);
  });

  it.each(['confirm', 'reject'] as const)(
    'keeps note optional for machine-breakdown %s',
    async (resolution) => {
      expect(await errors(ResolveProblemDto, { resolution })).toHaveLength(0);
    },
  );
});

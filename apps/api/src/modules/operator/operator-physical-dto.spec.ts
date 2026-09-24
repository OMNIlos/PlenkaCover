import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RecordDefectDto } from './dto/defect.dto';
import { DefectBagWeightDto } from './dto/defect-bag.dto';
import { DeferRollDto } from './dto/defer.dto';
import { OperatorOperationDto } from './dto/operation.dto';
import { QrPrintDto, QrVerifyDto } from './dto/qr.dto';
import { WeightCaptureDto } from './dto/weight.dto';
import { ReweighRollDto } from './dto/reweigh.dto';

const key = '9a88f1d4-c13a-4e85-88b1-a2f6cad67976';

async function errors(type: new () => object, value: object) {
  return validate(plainToInstance(type, value), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

describe('operator physical mutation DTOs', () => {
  it.each([
    [OperatorOperationDto, {}],
    [WeightCaptureDto, {}],
    [ReweighRollDto, {}],
    [QrPrintDto, {}],
    [QrVerifyDto, { payload: 'x' }],
    [RecordDefectDto, {}],
    [DeferRollDto, { reason: 'Ожидание' }],
    [DefectBagWeightDto, { weightKg: 12.5, defectType: 'secondary' }],
  ] as const)('%s requires a UUID-v4 operation key', async (type, body) => {
    expect(await errors(type, body)).not.toHaveLength(0);
    expect(await errors(type, { ...body, operationKey: 'not-a-uuid' })).not.toHaveLength(0);
    expect(await errors(type, { ...body, operationKey: key })).toHaveLength(0);
  });

  it.each([
    [WeightCaptureDto, { operationKey: key, deviceId: 'browser-selected-scale' }],
    [WeightCaptureDto, { operationKey: key, kg: 12.5 }],
    [ReweighRollDto, { operationKey: key, kg: 12.5 }],
    [QrPrintDto, { operationKey: key, printerId: 'browser-selected-printer' }],
    [RecordDefectDto, { operationKey: key, comment: 'Брак', weightKg: 12.5 }],
    [RecordDefectDto, { operationKey: key, comment: 'Брак', blocking: false }],
  ] as const)('%s rejects client-owned physical facts', async (type, body) => {
    const result = await errors(type, body);
    expect(result.some((error) => error.constraints?.whitelistValidation)).toBe(true);
  });

  it.each(['', ' ', '\n', 'x'.repeat(4097)])(
    'rejects unusable scanner payload %j',
    async (payload) => {
      expect(await errors(QrVerifyDto, { operationKey: key, payload })).not.toHaveLength(0);
    },
  );

  it('requires a bounded factual reason for a reprint request when one is supplied', async () => {
    expect(await errors(QrPrintDto, { operationKey: key, reason: ' ' })).not.toHaveLength(0);
    expect(await errors(QrPrintDto, { operationKey: key, reason: 'Из-за замятия' })).toHaveLength(
      0,
    );
  });

  it('accepts a physical defect without an operator-entered reason', async () => {
    expect(await errors(RecordDefectDto, { operationKey: key })).toHaveLength(0);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 10_001, '12.5'])(
    'rejects invalid manual defect-bag weight %s',
    async (weightKg) => {
      expect(
        await errors(DefectBagWeightDto, {
          operationKey: key,
          weightKg,
          defectType: 'secondary',
        }),
      ).not.toHaveLength(0);
    },
  );

  it.each(['secondary', 'aika', 'primary'])('accepts defect-bag type %s', async (defectType) => {
    expect(
      await errors(DefectBagWeightDto, { operationKey: key, weightKg: 12.5, defectType }),
    ).toHaveLength(0);
  });

  it.each(['', 'mixed', 'primary_tape'])(
    'rejects invalid defect-bag type %s',
    async (defectType) => {
      expect(
        await errors(DefectBagWeightDto, { operationKey: key, weightKg: 12.5, defectType }),
      ).not.toHaveLength(0);
    },
  );

  it('accepts zero defect weight without a type', async () => {
    expect(await errors(DefectBagWeightDto, { operationKey: key, weightKg: 0 })).toHaveLength(0);
  });

  it('rejects an operator-entered defect comment because the field is not part of the contract', async () => {
    const result = await errors(RecordDefectDto, {
      operationKey: key,
      comment: 'Брак на посту',
    });

    expect(result.some((error) => error.constraints?.whitelistValidation)).toBe(true);
  });

  it.each([
    [DeferRollDto, { operationKey: key, reason: ' ' }],
    [DeferRollDto, { operationKey: key, reason: 'x'.repeat(501) }],
  ] as const)('%s rejects blank or oversized audited text', async (type, body) => {
    expect(await errors(type, body)).not.toHaveLength(0);
  });
});

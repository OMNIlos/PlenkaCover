import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  DOMAIN_EVENTS,
  OPERATOR_REPORTABLE_PROBLEM_TYPE_LABELS,
  OPERATOR_REPORTABLE_PROBLEM_TYPES,
} from '@plenka/contracts';
import { OperatorProblemDto } from './dto/problem.dto';

const OPERATION_KEY = '9a88f1d4-c13a-4e85-88b1-a2f6cad67976';

describe('operator problem contract', () => {
  it('publishes one closed reportable vocabulary with exhaustive Russian labels', () => {
    expect(OPERATOR_REPORTABLE_PROBLEM_TYPES).toEqual(['general', 'raw_material_shortage']);
    expect(OPERATOR_REPORTABLE_PROBLEM_TYPE_LABELS).toEqual({
      general: 'Общая проблема',
      raw_material_shortage: 'Нехватка сырья',
    });
    expect(DOMAIN_EVENTS).toContain('problem:operator_reported');
  });

  it.each(['general', 'raw_material_shortage'] as const)(
    'accepts the reportable type %s with a UUID idempotency key',
    async (type) => {
      const errors = await validate(
        plainToInstance(OperatorProblemDto, {
          operationKey: OPERATION_KEY,
          type,
          rollId: 'ROLL-1',
          reason: 'Остановка работы',
        }),
      );

      expect(errors).toEqual([]);
    },
  );

  it.each(['defect', 'shift_balance_mismatch', 'machine_breakdown', 'device_failure'])(
    'rejects dedicated or system-owned type %s',
    async (type) => {
      const errors = await validate(
        plainToInstance(OperatorProblemDto, {
          operationKey: OPERATION_KEY,
          type,
          rollId: 'ROLL-1',
          reason: 'Попытка подмены',
        }),
      );

      expect(errors.map((error) => error.property)).toContain('type');
    },
  );

  it('requires a UUID-v4 operationKey', async () => {
    const missing = await validate(
      plainToInstance(OperatorProblemDto, {
        type: 'general',
        rollId: 'ROLL-1',
        reason: 'Остановка работы',
      }),
    );
    const malformed = await validate(
      plainToInstance(OperatorProblemDto, {
        operationKey: 'retry-me',
        type: 'general',
        rollId: 'ROLL-1',
        reason: 'Остановка работы',
      }),
    );

    expect(missing.map((error) => error.property)).toContain('operationKey');
    expect(malformed.map((error) => error.property)).toContain('operationKey');
  });
});

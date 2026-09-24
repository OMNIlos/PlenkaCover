import {
  CAPABILITIES,
  DOMAIN_EVENTS,
  PRODUCTION_PROBLEM_STATUSES,
  PRODUCTION_PROBLEM_TYPES,
  capabilitiesForRole,
  type OperatorRuntimeRoll,
} from '@plenka/contracts';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { MaterialShortageCorrectionDto } from '../commercial/dto/material-shortage-correction.dto';
import { CommercialController } from '../commercial/commercial.controller';
import { OperatorController } from './operator.controller';
import { OperatorProblemDto, OperatorProblemResponseDto } from './dto/problem.dto';

const OPERATION_KEY = '9a88f1d4-c13a-4e85-88b1-a2f6cad67976';

describe('material shortage contracts', () => {
  it('publishes a stable problem vocabulary', () => {
    expect(PRODUCTION_PROBLEM_TYPES).toEqual([
      'general',
      'raw_material_shortage',
      'defect',
      'shift_balance_mismatch',
      'machine_breakdown',
    ]);
    expect(PRODUCTION_PROBLEM_STATUSES).toEqual(['open', 'resolved']);
    expect(DOMAIN_EVENTS).toContain('audit:raw_material_shortage_resolved');
  });

  it('publishes an operator-only capability for the operator problem command', () => {
    expect(CAPABILITIES).toContain('operator_problem:create');
    expect(capabilitiesForRole('operator')).toContain('operator_problem:create');
    for (const role of ['commercial', 'production_lead', 'warehouse', 'finance'] as const) {
      expect(capabilitiesForRole(role)).not.toContain('operator_problem:create');
    }
  });

  it('publishes immutable per-roll material snapshots', () => {
    const roll = {
      positionSequence: 3,
      rawMaterialId: 'rm-recycled-pvd',
      rawMaterialLabel: 'ПВД вторичное',
      recipeVersion: 'v2',
    } as OperatorRuntimeRoll;
    expect(roll.positionSequence).toBe(3);
    expect(roll.recipeVersion).toBe('v2');
  });

  it.each([
    ['problemId', ''],
    ['fromRollId', '   '],
    ['newRawMaterialId', ''],
    ['reason', '   '],
  ] as const)('rejects a blank correction %s', async (field, value) => {
    const dto = plainToInstance(MaterialShortageCorrectionDto, {
      problemId: 'problem-1',
      fromRollId: 'A-1-roll-3',
      newRawMaterialId: 'rm-recycled-pvd',
      newParameters: [{ label: 'Сырьё', value: 'ПВД вторичное' }],
      reason: 'Замена согласована',
      [field]: value,
    });

    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toContain(field);
  });

  it.each(['defect', 'machine_breakdown', 'shift_balance_mismatch'])(
    'rejects system or dedicated type %s through the generic operator-problem contract',
    async (type) => {
    const dto = plainToInstance(OperatorProblemDto, {
      operationKey: OPERATION_KEY,
      type,
      rollId: 'A-1-roll-3',
      reason: 'Повреждение полотна',
    });

    const errors = await validate(dto);

    expect(errors.map((error) => error.property)).toContain('type');
    },
  );

  it('rejects an empty correction recipe parameter list', async () => {
    const dto = plainToInstance(MaterialShortageCorrectionDto, {
      problemId: 'problem-1',
      fromRollId: 'A-1-roll-3',
      newRawMaterialId: 'rm-recycled-pvd',
      newParameters: [],
      reason: 'Замена согласована',
    });

    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toContain('newParameters');
  });

  it.each([
    ['rollId', undefined],
    ['rollId', ''],
    ['rollId', '   '],
    ['reason', ''],
    ['reason', '   '],
  ] as const)('rejects a missing or blank operator problem %s', async (field, value) => {
    const dto = plainToInstance(OperatorProblemDto, {
      operationKey: OPERATION_KEY,
      type: 'raw_material_shortage',
      rollId: 'A-1-roll-3',
      reason: 'ПВД закончился',
      [field]: value,
    });

    const errors = await validate(dto);

    expect(errors.map((error) => error.property)).toContain(field);
  });

  it('documents rollId as required while keeping type defaulted and recovery optional', () => {
    const rollId = Reflect.getMetadata(
      'swagger/apiModelProperties',
      OperatorProblemDto.prototype,
      'rollId',
    );
    const type = Reflect.getMetadata(
      'swagger/apiModelProperties',
      OperatorProblemDto.prototype,
      'type',
    );
    const recovery = Reflect.getMetadata(
      'swagger/apiModelProperties',
      OperatorProblemDto.prototype,
      'recovery',
    );

    expect(rollId).toEqual(expect.objectContaining({ required: true }));
    expect(type).toEqual(expect.objectContaining({ required: false, default: 'general' }));
    expect(recovery).toEqual(expect.objectContaining({ required: false }));
  });

  it.each([
    [OperatorController.prototype.problem, 'OperatorProblemResponseDto'],
    [
      CommercialController.prototype.materialShortageCorrection,
      'MaterialShortageCorrectionResponseDto',
    ],
  ])('documents typed 201 and all command errors', (handler, responseTypeName) => {
    const responses = Reflect.getMetadata('swagger/apiResponse', handler);
    expect(Object.keys(responses).sort()).toEqual(['201', '400', '403', '404', '409']);
    expect(responses['201'].type.name).toBe(responseTypeName);
  });

  it.each(['positionId', 'rollId', 'recovery'] as const)(
    'documents nullable response field %s as string|null',
    (field) => {
      const metadata = Reflect.getMetadata(
        'swagger/apiModelProperties',
        OperatorProblemResponseDto.prototype,
        field,
      );

      expect(metadata).toEqual(expect.objectContaining({ nullable: true, type: String }));
    },
  );
});

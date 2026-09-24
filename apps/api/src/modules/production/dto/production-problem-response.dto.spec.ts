import {
  PRODUCTION_PROBLEM_STATUSES,
  PRODUCTION_PROBLEM_TYPES,
} from '@plenka/contracts';
import { DECORATORS } from '@nestjs/swagger';
import { ProductionProblemResponseDto } from './production-problem-response.dto';

function fieldMetadata(field: string) {
  return Reflect.getMetadata(
    DECORATORS.API_MODEL_PROPERTIES,
    ProductionProblemResponseDto.prototype,
    field,
  );
}

describe('ProductionProblemResponseDto OpenAPI contract', () => {
  it.each(['orderId', 'positionId', 'rollId', 'recovery', 'postId'])(
    'documents nullable field %s as string|null',
    (field) => {
      expect(fieldMetadata(field)).toEqual(
        expect.objectContaining({ nullable: true, type: String }),
      );
    },
  );

  it.each(['resolvedAt', 'defectWeightCapturedAt'])(
    'documents nullable timestamp %s as an ISO date-time string',
    (field) => {
      expect(fieldMetadata(field)).toEqual(
        expect.objectContaining({ nullable: true, type: String, format: 'date-time' }),
      );
    },
  );

  it('uses the shared production problem enums', () => {
    expect(fieldMetadata('type')?.enum).toEqual(PRODUCTION_PROBLEM_TYPES);
    expect(fieldMetadata('status')?.enum).toEqual(PRODUCTION_PROBLEM_STATUSES);
  });
});

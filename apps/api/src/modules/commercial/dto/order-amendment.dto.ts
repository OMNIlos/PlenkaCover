import { ApiProperty, OmitType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { CreatePositionDto } from './create-order.dto';
import { UpdatePositionDto } from './update-position.dto';

export const COMMERCIAL_AMENDMENT_KINDS = [
  'add_position',
  'update_position',
  'cancel_remaining_position',
] as const;

export type CommercialAmendmentKind = (typeof COMMERCIAL_AMENDMENT_KINDS)[number];

export class CommercialPositionChangesDto extends OmitType(UpdatePositionDto, [
  'expectedVersion',
] as const) {}

type AmendmentShape = {
  kind?: unknown;
  position?: unknown;
  positionId?: unknown;
  expectedPositionVersion?: unknown;
  changes?: unknown;
};

function isNonEmptyRecord(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length > 0,
  );
}

@ValidatorConstraint({ name: 'exactCommercialAmendmentShape', async: false })
class ExactCommercialAmendmentShapeConstraint implements ValidatorConstraintInterface {
  validate(_kind: unknown, args: ValidationArguments): boolean {
    const command = args.object as AmendmentShape;
    switch (command.kind) {
      case 'add_position':
        return (
          isNonEmptyRecord(command.position) &&
          command.positionId === undefined &&
          command.expectedPositionVersion === undefined &&
          command.changes === undefined
        );
      case 'update_position':
        return (
          typeof command.positionId === 'string' &&
          Number.isInteger(command.expectedPositionVersion) &&
          isNonEmptyRecord(command.changes) &&
          command.position === undefined
        );
      case 'cancel_remaining_position':
        return (
          typeof command.positionId === 'string' &&
          Number.isInteger(command.expectedPositionVersion) &&
          command.changes === undefined &&
          command.position === undefined
        );
      default:
        return false;
    }
  }

  defaultMessage(): string {
    return 'amendment payload does not match its kind';
  }
}

export class CommercialOrderAmendmentDto {
  @ApiProperty({ enum: COMMERCIAL_AMENDMENT_KINDS })
  @IsIn(COMMERCIAL_AMENDMENT_KINDS)
  @Validate(ExactCommercialAmendmentShapeConstraint)
  kind!: CommercialAmendmentKind;

  @ApiProperty({ format: 'uuid' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsUUID(4)
  operationKey!: string;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  expectedOrderVersion!: number;

  @ApiProperty({ maxLength: 500 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;

  @ApiProperty({ required: false, type: CreatePositionDto })
  @ValidateIf((command: CommercialOrderAmendmentDto) => command.kind === 'add_position')
  @ValidateNested()
  @Type(() => CreatePositionDto)
  position?: CreatePositionDto;

  @ApiProperty({ required: false })
  @ValidateIf((command: CommercialOrderAmendmentDto) => command.kind !== 'add_position')
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  positionId?: string;

  @ApiProperty({ required: false, minimum: 1 })
  @ValidateIf((command: CommercialOrderAmendmentDto) => command.kind !== 'add_position')
  @IsInt()
  @Min(1)
  expectedPositionVersion?: number;

  @ApiProperty({ required: false, type: CommercialPositionChangesDto })
  @ValidateIf((command: CommercialOrderAmendmentDto) => command.kind === 'update_position')
  @ValidateNested()
  @Type(() => CommercialPositionChangesDto)
  changes?: CommercialPositionChangesDto;
}

export class CommercialOrderAmendmentResponseDto {
  @ApiProperty()
  commandId!: string;

  @ApiProperty()
  orderId!: string;

  @ApiProperty({ minimum: 1 })
  orderVersion!: number;

  @ApiProperty({ enum: ['applied', 'needs_production_review'] })
  reconciliation!: 'applied' | 'needs_production_review';

  @ApiProperty({ type: [String] })
  affectedPositionIds!: string[];

  @ApiProperty({ type: [String] })
  changedFutureRollIds!: string[];

  @ApiProperty({ type: [String] })
  preservedPhysicalRollIds!: string[];
}

export class OrderCancellationCommandDto {
  @ApiProperty({ format: 'uuid' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsUUID(4)
  operationKey!: string;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class OrderCancellationResponseDto extends CommercialOrderAmendmentResponseDto {
  @ApiProperty({ enum: ['active', 'cancelled'] })
  cancellationStatus!: 'active' | 'cancelled';

  @ApiProperty({ minimum: 1 })
  cancellationVersion!: number;

  @ApiProperty({ minimum: 0 })
  completedRollCount!: number;

  @ApiProperty({ minimum: 0 })
  remainingCancelledRollCount!: number;
}

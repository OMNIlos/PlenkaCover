import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsString, IsUUID, Length, Min, ValidateIf } from 'class-validator';
import type { RefreshWarehouseCoverageDto as RefreshWarehouseCoverageInput } from '../../warehouse-coverage/warehouse-coverage-calculation.service';
import type { DecideWarehouseCoverageDto as DecideWarehouseCoverageInput } from '../../warehouse-coverage/warehouse-coverage-decision.service';
import type { RequestWarehouseCoverageRecheckDto as RequestWarehouseCoverageRecheckInput } from '../../warehouse-coverage/warehouse-coverage-recheck.service';

export class RefreshWarehouseCoverageDto implements RefreshWarehouseCoverageInput {
  @ApiProperty({ format: 'uuid', description: 'Client-generated idempotency key.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsUUID('4')
  clientRequestId!: string;

  @ApiProperty({ nullable: true, minimum: 1 })
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(1)
  expectedGeneration!: number | null;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  expectedStateVersion!: number;
}

export class DecideWarehouseCoverageDto implements DecideWarehouseCoverageInput {
  @ApiProperty({ format: 'uuid', description: 'Client-generated idempotency key.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsUUID('4')
  clientRequestId!: string;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  expectedGeneration!: number;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  expectedStateVersion!: number;

  @ApiProperty({ enum: ['use_warehouse', 'produce_all'] })
  @IsIn(['use_warehouse', 'produce_all'])
  decision!: 'use_warehouse' | 'produce_all';
}

export class RequestWarehouseCoverageRecheckDto implements RequestWarehouseCoverageRecheckInput {
  @ApiProperty({ format: 'uuid', description: 'Client-generated idempotency key.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsUUID('4')
  clientRequestId!: string;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  expectedGeneration!: number;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  expectedStateVersion!: number;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ') : value,
  )
  @IsString()
  @Length(3, 500)
  reason!: string;
}

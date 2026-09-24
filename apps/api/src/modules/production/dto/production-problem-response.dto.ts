import {
  PRODUCTION_PROBLEM_STATUSES,
  PRODUCTION_PROBLEM_TYPES,
  type ProductionProblemStatus,
  type ProductionProblemType,
} from '@plenka/contracts';
import { ApiProperty } from '@nestjs/swagger';

export class ProductionProblemPostResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  status!: string;
}

export class ProductionProblemOrderResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  orderNumber!: string;
}

export class ProductionProblemResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: PRODUCTION_PROBLEM_TYPES })
  type!: ProductionProblemType;

  @ApiProperty({ enum: PRODUCTION_PROBLEM_STATUSES })
  status!: ProductionProblemStatus;

  @ApiProperty({ nullable: true, type: String })
  orderId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  positionId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  rollId!: string | null;

  @ApiProperty()
  actorRole!: string;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ nullable: true, type: String })
  recovery!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  resolvedAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  postId!: string | null;

  @ApiProperty({ type: ProductionProblemPostResponseDto, nullable: true })
  post!: ProductionProblemPostResponseDto | null;

  @ApiProperty({ type: ProductionProblemOrderResponseDto, nullable: true })
  order!: ProductionProblemOrderResponseDto | null;

  @ApiProperty({ type: Number, nullable: true })
  defectWeightKg!: number | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  defectWeightCapturedAt!: string | null;

  @ApiProperty({
    enum: [
      'operator_scale',
      'warehouse_control_scale',
      'production_existing_scale',
      'legacy_unverified',
    ],
    nullable: true,
  })
  defectWeightSource!: string | null;
}

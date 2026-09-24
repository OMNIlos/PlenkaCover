import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  PENALTY_SNAPSHOT_STATUSES,
  PENALTY_SNAPSHOT_TARGET_ROLES,
  type PenaltySnapshot,
  type PenaltySnapshotItem,
  type PenaltySnapshotQuery,
  type PenaltySnapshotSummary,
  type PenaltySnapshotStatus,
  type PenaltySnapshotTargetRole,
} from '@plenka/contracts';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class PenaltySnapshotQueryDto implements PenaltySnapshotQuery {
  @ApiPropertyOptional({ enum: PENALTY_SNAPSHOT_TARGET_ROLES })
  @IsOptional()
  @IsIn(PENALTY_SNAPSHOT_TARGET_ROLES)
  targetRole?: PenaltySnapshotTargetRole;

  @ApiPropertyOptional({ enum: PENALTY_SNAPSHOT_STATUSES })
  @IsOptional()
  @IsIn(PENALTY_SNAPSHOT_STATUSES)
  status?: PenaltySnapshotStatus;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  employeeId?: string;
}

export class PenaltySnapshotItemResponseDto implements PenaltySnapshotItem {
  @ApiProperty()
  id!: string;

  @ApiProperty({ nullable: true, type: String })
  employeeId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  displayName!: string | null;

  @ApiProperty({ enum: PENALTY_SNAPSHOT_TARGET_ROLES })
  targetRole!: PenaltySnapshotTargetRole;

  @ApiProperty({ type: 'integer', format: 'int64' })
  amountKopecks!: number;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ nullable: true, type: String })
  sourceObjectId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  sourceProductionOrderId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  sourceOrderNumber!: string | null;

  @ApiProperty({ nullable: true, type: String })
  sourceRollCode!: string | null;

  @ApiProperty()
  authorRole!: PenaltySnapshotItem['authorRole'];

  @ApiProperty({ enum: PENALTY_SNAPSHOT_STATUSES })
  status!: PenaltySnapshotStatus;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class PenaltySnapshotSummaryResponseDto implements PenaltySnapshotSummary {
  @ApiProperty({ type: 'integer' })
  totalCount!: number;

  @ApiProperty({ type: 'integer', format: 'int64' })
  totalAmountKopecks!: number;

  @ApiProperty({ nullable: true, type: String })
  topReason!: string | null;
}

export class PenaltySnapshotResponseDto implements PenaltySnapshot {
  @ApiProperty({ type: [PenaltySnapshotItemResponseDto] })
  items!: PenaltySnapshotItem[];

  @ApiProperty({ type: PenaltySnapshotSummaryResponseDto })
  summary!: PenaltySnapshot['summary'];
}

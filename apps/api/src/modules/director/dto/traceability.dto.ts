import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  TRACEABILITY_MATCH_KINDS,
  TRACEABILITY_OBJECT_TYPES,
  type TraceabilityContext,
  type TraceabilityDefect,
  type TraceabilityLink,
  type TraceabilityMatchKind,
  type TraceabilityObjectType,
  type TraceabilityProblem,
  type TraceabilityProductionFact,
  type TraceabilitySearchItem,
  type TraceabilitySearchPage,
  type TraceabilityStatus,
  type TraceabilityTimelineItem,
  type TraceabilityWarehouseFact,
} from '@plenka/contracts';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class TraceabilitySearchQueryDto {
  @ApiProperty({ minLength: 1, maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  q!: string;

  @ApiPropertyOptional({ description: 'Opaque deterministic cursor', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  cursor?: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20;
}

export class TraceabilityContextParamsDto {
  @ApiProperty({ enum: TRACEABILITY_OBJECT_TYPES })
  @IsIn([...TRACEABILITY_OBJECT_TYPES])
  objectType!: TraceabilityObjectType;

  @ApiProperty({ minLength: 1, maxLength: 256 })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  objectId!: string;
}

export class TraceabilitySearchItemResponseDto implements TraceabilitySearchItem {
  @ApiProperty({ enum: TRACEABILITY_OBJECT_TYPES })
  objectType!: TraceabilityObjectType;

  @ApiProperty()
  objectId!: string;

  @ApiProperty()
  displayName!: string;

  @ApiProperty({ nullable: true, type: String })
  secondaryLabel!: string | null;

  @ApiProperty({ enum: TRACEABILITY_MATCH_KINDS })
  matchKind!: TraceabilityMatchKind;
}

export class TraceabilitySearchPageResponseDto implements TraceabilitySearchPage {
  @ApiProperty({ type: [TraceabilitySearchItemResponseDto] })
  items!: TraceabilitySearchItemResponseDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}

export class TraceabilityStatusResponseDto implements TraceabilityStatus {
  @ApiProperty()
  title!: string;

  @ApiProperty()
  valueLabel!: string;
}

export class TraceabilityLinkResponseDto implements TraceabilityLink {
  @ApiProperty({ enum: TRACEABILITY_OBJECT_TYPES })
  objectType!: TraceabilityObjectType;

  @ApiProperty()
  objectId!: string;

  @ApiProperty()
  displayName!: string;

  @ApiProperty()
  relationLabel!: string;
}

class TraceabilityActorResponseDto {
  @ApiProperty()
  displayName!: string;

  @ApiProperty()
  roleLabel!: string;
}

export class TraceabilityTimelineItemResponseDto implements TraceabilityTimelineItem {
  @ApiProperty()
  eventId!: string;

  @ApiProperty()
  actionLabel!: string;

  @ApiProperty({ nullable: true, type: String })
  reason!: string | null;

  @ApiProperty({ type: TraceabilityActorResponseDto })
  actor!: TraceabilityActorResponseDto;

  @ApiProperty({ format: 'date-time' })
  occurredAt!: string;
}

export class TraceabilityProblemResponseDto implements TraceabilityProblem {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  statusLabel!: string;

  @ApiProperty({ nullable: true, type: String })
  reason!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  resolvedAt!: string | null;
}

export class TraceabilityDefectResponseDto implements TraceabilityDefect {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  statusLabel!: string;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ nullable: true, type: Number })
  weightKg!: number | null;

  @ApiProperty({ format: 'date-time' })
  recordedAt!: string;
}

abstract class TraceabilityFactResponseDto {
  @ApiProperty()
  title!: string;

  @ApiProperty()
  valueLabel!: string;

  @ApiProperty({ format: 'date-time' })
  recordedAt!: string;

  @ApiProperty({ nullable: true, type: Boolean })
  isCurrent!: boolean | null;
}

export class TraceabilityProductionFactResponseDto
  extends TraceabilityFactResponseDto
  implements TraceabilityProductionFact {}

export class TraceabilityWarehouseFactResponseDto
  extends TraceabilityFactResponseDto
  implements TraceabilityWarehouseFact {}

export class TraceabilityContextResponseDto implements TraceabilityContext {
  @ApiProperty({ enum: TRACEABILITY_OBJECT_TYPES })
  objectType!: TraceabilityObjectType;

  @ApiProperty()
  objectId!: string;

  @ApiProperty()
  displayName!: string;

  @ApiProperty({ type: [TraceabilityStatusResponseDto] })
  statuses!: TraceabilityStatusResponseDto[];

  @ApiProperty({ type: [TraceabilityLinkResponseDto] })
  links!: TraceabilityLinkResponseDto[];

  @ApiProperty({ type: [TraceabilityTimelineItemResponseDto] })
  timeline!: TraceabilityTimelineItemResponseDto[];

  @ApiProperty({ type: [TraceabilityProblemResponseDto] })
  problems!: TraceabilityProblemResponseDto[];

  @ApiProperty({ type: [TraceabilityDefectResponseDto] })
  defects!: TraceabilityDefectResponseDto[];

  @ApiProperty({ type: [TraceabilityProductionFactResponseDto] })
  productionFacts!: TraceabilityProductionFactResponseDto[];

  @ApiProperty({ type: [TraceabilityWarehouseFactResponseDto] })
  warehouseFacts!: TraceabilityWarehouseFactResponseDto[];
}

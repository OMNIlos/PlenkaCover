import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import {
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  OPERATIONAL_SCOPES,
  type IncidentSeverity,
  type IncidentStatus,
  type OperationalScope,
} from '@plenka/contracts';
import type { WarehouseCoverageMetricsSnapshot } from '../../warehouse-coverage/warehouse-coverage-metrics.service';
import { Trim } from './trimmed-string';

type WarehouseCoverageProcessConflicts = WarehouseCoverageMetricsSnapshot['processConflicts'];

export class WarehouseCoverageProcessConflictsDto implements WarehouseCoverageProcessConflicts {
  @ApiProperty({ minimum: 0 })
  total!: number;

  @ApiProperty({
    type: Object,
    example: { P2034: 0, '40001': 0, '40P01': 0, coverage_conflict: 0 },
  })
  byCode!: WarehouseCoverageProcessConflicts['byCode'];

  @ApiProperty({ format: 'date-time' })
  resetAt!: string;
}

export class WarehouseCoverageMetricsDto implements WarehouseCoverageMetricsSnapshot {
  @ApiProperty({ type: Object })
  currentStates!: WarehouseCoverageMetricsSnapshot['currentStates'];

  @ApiProperty({ type: Object })
  currentAvailability!: WarehouseCoverageMetricsSnapshot['currentAvailability'];

  @ApiProperty({ type: Object })
  openRechecks!: WarehouseCoverageMetricsSnapshot['openRechecks'];

  @ApiProperty({ type: WarehouseCoverageProcessConflictsDto })
  processConflicts!: WarehouseCoverageProcessConflictsDto;
}

export class OperationalIncidentQueryDto {
  @ApiPropertyOptional({ enum: INCIDENT_STATUSES })
  @IsOptional()
  @IsIn([...INCIDENT_STATUSES])
  status?: IncidentStatus;

  @ApiPropertyOptional({ enum: INCIDENT_SEVERITIES })
  @IsOptional()
  @IsIn([...INCIDENT_SEVERITIES])
  severity?: IncidentSeverity;

  @ApiPropertyOptional({ enum: OPERATIONAL_SCOPES })
  @IsOptional()
  @IsIn([...OPERATIONAL_SCOPES])
  scope?: OperationalScope;
}

export class OperationalIncidentReasonDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Trim()
  @IsString()
  @Length(3, 500)
  reason!: string;
}

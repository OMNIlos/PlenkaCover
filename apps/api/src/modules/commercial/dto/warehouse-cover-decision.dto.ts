import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength } from 'class-validator';
import type { WarehouseCoverRoute } from '@plenka/contracts';
import { VersionedCommandDto } from './versioned-command.dto';

export class WarehouseCoverDecisionDto extends VersionedCommandDto {
  @ApiProperty({ enum: ['production_only', 'partial_cover', 'full_cover'] })
  @IsIn(['production_only', 'partial_cover', 'full_cover'])
  route!: WarehouseCoverRoute;
}

export class WarehouseCoverTechnicalApprovalDto extends VersionedCommandDto {}

export class WarehouseCoverRecheckDto extends VersionedCommandDto {
  @ApiPropertyOptional({ maxLength: 1000 })
  @IsString()
  @MaxLength(1000)
  reason!: string;
}

import { ApiProperty } from '@nestjs/swagger';
import {
  IsDefined,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class ReportProblemDto {
  @ApiProperty({ required: false, description: 'Affected commercial position id' })
  @IsOptional()
  @IsString()
  positionId?: string;

  @ApiProperty({ required: false, description: 'Affected roll id' })
  @IsOptional()
  @IsString()
  rollId?: string;

  @ApiProperty({ description: 'What went wrong (reported to commercial, audited)' })
  @IsString()
  reason!: string;

  @ApiProperty({ required: false, description: 'Proposed recovery' })
  @IsOptional()
  @IsString()
  recovery?: string;
}

export class ResolveProblemDto {
  @ApiProperty({
    enum: ['rework', 'writeoff', 'confirm', 'reject', 'close'],
    description:
      'rework/writeoff — решение по браку; confirm/reject — по поломке; close — по общей проблеме',
  })
  @IsIn(['rework', 'writeoff', 'confirm', 'reject', 'close'])
  resolution!: 'rework' | 'writeoff' | 'confirm' | 'reject' | 'close';

  @ApiProperty({
    required: false,
    minLength: 1,
    maxLength: 1000,
    description: 'Комментарий или итог решения проблемы',
  })
  @ValidateIf(
    (dto: ResolveProblemDto) =>
      dto.resolution === 'rework' ||
      dto.resolution === 'writeoff' ||
      dto.resolution === 'close' ||
      dto.note !== undefined,
  )
  @IsDefined()
  @IsString()
  @Matches(/\S/u)
  @MaxLength(1000)
  note?: string;
}

export class ReportMachineBreakdownDto {
  @ApiProperty({ description: 'Причина поломки станка (обязательна, идет в аудит)' })
  @IsString()
  reason!: string;
}

export class CompleteMachineRepairDto {
  @ApiProperty({ required: false, description: 'Комментарий о выполненном ремонте' })
  @IsOptional()
  @IsString()
  note?: string;
}

export class MarkRollDefectDto {
  @ApiProperty({ description: 'Причина брака (визуальный контроль завпроизводства)' })
  @IsString()
  @Matches(/\S/u)
  @MaxLength(1000)
  reason!: string;
}

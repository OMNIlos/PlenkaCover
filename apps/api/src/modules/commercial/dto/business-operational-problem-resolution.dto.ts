import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsString, Matches, MaxLength } from 'class-validator';

export class BusinessOperationalProblemResolutionDto {
  @ApiProperty({
    enum: ['rework', 'writeoff', 'confirm', 'reject'],
    description:
      'Для брака: переделать или списать; для поломки станка: подтвердить или отклонить.',
  })
  @IsIn(['rework', 'writeoff', 'confirm', 'reject'])
  resolution!: 'rework' | 'writeoff' | 'confirm' | 'reject';

  @ApiProperty({
    minLength: 1,
    maxLength: 1000,
    description: 'Основание решения директора; сохраняется в аудите.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Matches(/\S/u)
  @MaxLength(1000)
  note!: string;
}

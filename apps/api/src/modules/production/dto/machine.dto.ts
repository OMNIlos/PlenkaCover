import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

export class AssignMachineDto {
  @ApiProperty()
  @IsString()
  machineId!: string;

  @ApiProperty({
    enum: ['roll', 'order', 'shift'],
    description: 'Assignment scope (ТЗ §12.14 discovery)',
  })
  @IsIn(['roll', 'order', 'shift'])
  scope!: 'roll' | 'order' | 'shift';

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  reason?: string;
}

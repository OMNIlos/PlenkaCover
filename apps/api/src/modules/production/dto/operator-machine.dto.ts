import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class AssignOperatorMachineDto {
  @ApiProperty({ example: 'cm-post-1' })
  @IsString()
  @IsNotEmpty()
  postId!: string;
}

export class BreakdownReassignDto extends AssignOperatorMachineDto {
  @ApiProperty({ example: 'Остановлен редуктор экструдера' })
  @IsString()
  @IsNotEmpty()
  reason!: string;
}

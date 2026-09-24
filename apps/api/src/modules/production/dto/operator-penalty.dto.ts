import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateOperatorPenaltyDto {
  @ApiProperty({ description: 'Real user id of the operator receiving the penalty' })
  @IsString()
  @IsNotEmpty()
  operatorId!: string;

  @ApiProperty({ minimum: 0.01 })
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @ApiProperty({ description: 'Why the penalty is issued; persisted in the audit trail' })
  @IsString()
  @IsNotEmpty()
  reason!: string;

  @ApiProperty({ description: 'Published production order linked to the penalty' })
  @IsString()
  @IsNotEmpty()
  productionOrderId!: string;

  @ApiProperty({ required: false, description: 'Concrete roll from the selected order' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  rollCode?: string;
}

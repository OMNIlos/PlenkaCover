import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { OperatorOperationDto } from './operation.dto';

export class QrPrintDto extends OperatorOperationDto {
  @ApiProperty({
    required: false,
    description: 'Required when reprinting an already-printed label (ТЗ §9)',
  })
  @IsOptional()
  @IsString()
  @Matches(/\S/u)
  @MaxLength(500)
  reason?: string;
}

export class QrVerifyDto extends OperatorOperationDto {
  @ApiProperty({
    description: 'Exact bytes entered by the physical HID scanner; never prefilled by the UI',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/u)
  @MaxLength(4096)
  payload!: string;
}

export class QrVerifyAndHandoverDto extends QrVerifyDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Independent UUID-v4 idempotency key for the warehouse handover phase',
  })
  @IsUUID('4')
  handoverOperationKey!: string;
}

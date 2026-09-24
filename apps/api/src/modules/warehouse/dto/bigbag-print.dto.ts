import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { BigBagLabelPrintView, BigBagPrintStatus } from '@plenka/contracts';
import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class PrintBigBagLabelDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  requestId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  printerId!: string;

  @ApiPropertyOptional({ minLength: 3, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string;
}

export class BigBagLabelPrintResponseDto implements BigBagLabelPrintView {
  @ApiProperty()
  id!: string;

  @ApiProperty({ format: 'uuid' })
  requestId!: string;

  @ApiProperty()
  bigBagId!: string;

  @ApiProperty({ nullable: true, type: String })
  printerId!: string | null;

  @ApiProperty({ enum: ['gateway', 'browser_system_print'] })
  channel!: 'gateway' | 'browser_system_print';

  @ApiProperty({ enum: ['queued', 'submitted', 'uncertain', 'failed', 'intent_recorded'] })
  status!: BigBagPrintStatus;

  @ApiProperty({ nullable: true, type: String })
  reason!: string | null;

  @ApiProperty({ nullable: true, type: String })
  replacesPrintJobId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  gatewayCommandId!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class InvoiceLinkDto {
  @ApiProperty({ format: 'uuid', description: 'Client-generated idempotency key.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value), {
    toClassOnly: true,
  })
  @IsUUID('4')
  operationKey!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Exact 1С Ref_Key.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value), {
    toClassOnly: true,
  })
  @IsOptional()
  @IsUUID()
  externalId?: string;

  @ApiPropertyOptional({ maxLength: 100, description: 'Exact invoice number in 1С.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value), {
    toClassOnly: true,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  invoiceNumber?: string;

  @ApiProperty({ minLength: 4, maxLength: 500, description: 'Manual reconciliation reason.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value), {
    toClassOnly: true,
  })
  @IsString()
  @MinLength(4)
  @MaxLength(500)
  reason!: string;
}

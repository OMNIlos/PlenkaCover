import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class ScanDto {
  @ApiProperty({ format: 'uuid', description: 'Stable key generated once for this scan action' })
  @IsUUID('4')
  operationKey!: string;

  @ApiProperty({ description: 'Exact opaque bytes typed by the HID scanner' })
  @IsString()
  @Matches(/^prt_[0-9a-f]{64}$/u)
  payload!: string;
}

export class ControlWeightDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  operationKey!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/u)
  @MaxLength(200)
  rollCode!: string;
}

export class RollDamagedDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  operationKey!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/u)
  @MaxLength(200)
  rollCode!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/u)
  @MaxLength(500)
  reason!: string;
}

import { ApiProperty } from '@nestjs/swagger';
import {
  Allow,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class HeartbeatDto {
  @ApiProperty({ required: false, description: 'Versioned gateway protocol number.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  protocolVersion?: number;

  @ApiProperty({ required: false, description: 'Bounded safe agent release metadata.' })
  @IsOptional()
  @IsObject()
  agent?: Record<string, unknown>;

  @ApiProperty({ required: false, description: 'Devices seen by the agent, with their status.' })
  @IsOptional()
  @IsArray()
  devices?: Array<Record<string, unknown>>;
}

export class CommandResultDto {
  @ApiProperty({ description: 'Opaque claim token returned with the polled command.' })
  @IsUUID()
  leaseToken!: string;

  @ApiProperty({ description: 'The command result payload from the agent.' })
  @IsObject()
  result!: Record<string, unknown>;
}

export class IngestDto {
  @ApiProperty({ description: 'Client-generated idempotency key (also the offline-buffer key).' })
  @IsString()
  @IsNotEmpty()
  eventId!: string;

  @ApiProperty({ enum: ['weight', 'scan', 'status', 'heartbeat'] })
  @IsIn(['weight', 'scan', 'status', 'heartbeat'])
  kind!: 'weight' | 'scan' | 'status' | 'heartbeat';

  @ApiProperty({ required: false })
  @IsOptional()
  @Allow()
  payload?: Record<string, unknown>;

  @ApiProperty({ required: false, description: 'Raw device frame — admin diagnostics only.' })
  @IsOptional()
  @Allow()
  rawPayload?: unknown;
}

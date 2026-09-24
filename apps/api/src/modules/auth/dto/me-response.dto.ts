import { ApiProperty } from '@nestjs/swagger';

export class AuthSessionProjectionDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  purpose!: string;

  @ApiProperty({ enum: ['active', 'expired', 'revoked'] })
  state!: string;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  expiresAt!: Date;

  @ApiProperty({ type: Date, nullable: true })
  lastSeenAt!: Date | null;
}

export class AuthWorkContextDto {
  @ApiProperty({ enum: ['office', 'operator_post'] })
  kind!: string;

  @ApiProperty({ type: Object, nullable: true, example: null })
  assignment!: Record<string, unknown> | null;
}

export class MeResponseDto {
  @ApiProperty()
  userId!: string;

  @ApiProperty()
  role!: string;

  @ApiProperty({ type: [String] })
  capabilities!: string[];

  @ApiProperty({ type: String, nullable: true })
  displayName!: string | null;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty({ type: String, nullable: true })
  sessionPurpose!: string | null;

  @ApiProperty({ type: AuthSessionProjectionDto, nullable: true })
  session!: AuthSessionProjectionDto | null;

  @ApiProperty({ type: AuthWorkContextDto })
  workContext!: AuthWorkContextDto;

  @ApiProperty()
  passwordChangeRequired!: boolean;
}

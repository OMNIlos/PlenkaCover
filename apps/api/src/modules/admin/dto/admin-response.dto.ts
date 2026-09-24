import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';
import {
  ACCOUNT_STATUSES,
  CAPABILITIES,
  ROLES,
  SESSION_PURPOSES,
  type AccountStatus,
  type Capability,
  type Role,
  type SessionPurpose,
} from '@plenka/contracts';

export class AdminUserResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true }) externalId!: string | null;
  @ApiProperty() login!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ enum: ROLES }) role!: Role;
  @ApiProperty({ enum: ACCOUNT_STATUSES }) status!: AccountStatus;
  @ApiProperty() mustChangePassword!: boolean;
  @ApiProperty({ nullable: true }) passwordChangedAt!: Date | null;
  @ApiProperty({ nullable: true }) lastLoginAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiProperty({ enum: CAPABILITIES, isArray: true }) capabilities!: Capability[];
  @ApiProperty({ enum: CAPABILITIES, isArray: true }) grants!: Capability[];
  @ApiProperty({ enum: CAPABILITIES, isArray: true }) denials!: Capability[];
  @ApiProperty() activeSessionCount!: number;
}

export class TemporaryCredentialResponseDto {
  @ApiProperty({ type: AdminUserResponseDto }) user!: AdminUserResponseDto;
  @ApiProperty({ description: 'Returned once. The platform stores only its hash.' })
  temporaryPassword!: string;
}

export class AdminUserListResponseDto {
  @ApiProperty({ type: [AdminUserResponseDto] }) items!: AdminUserResponseDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}

export class AdminSessionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: SESSION_PURPOSES }) purpose!: SessionPurpose;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() expiresAt!: Date;
  @ApiProperty({ nullable: true }) revokedAt!: Date | null;
  @ApiProperty({ nullable: true }) lastSeenAt!: Date | null;
  @ApiProperty({ nullable: true }) userAgent!: string | null;
  @ApiProperty({ nullable: true }) ip!: string | null;
}

export class AccessTemplateResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ROLES }) role!: Role;
  @ApiProperty({ enum: ['draft', 'active'] }) setupStatus!: 'draft' | 'active';
  @ApiProperty({ enum: CAPABILITIES, isArray: true }) capabilityGrants!: Capability[];
  @ApiProperty({ enum: CAPABILITIES, isArray: true }) capabilityDenials!: Capability[];
  @ApiProperty() version!: number;
  @ApiProperty() isSystem!: boolean;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class AdminCapabilityCatalogItemResponseDto {
  @ApiProperty({ enum: CAPABILITIES }) key!: Capability;
  @ApiProperty() label!: string;
  @ApiProperty() description!: string;
  @ApiProperty() group!: string;
  @ApiProperty({ enum: ROLES, isArray: true }) baseRoles!: Role[];
  @ApiProperty() grantable!: boolean;
}

export class AdminAuditUserActorResponseDto {
  @ApiProperty({ enum: ['user'] }) kind!: 'user';
  @ApiProperty({ enum: ROLES }) role!: Role;
  @ApiProperty({ nullable: true }) userId!: string | null;
}

export class AdminAuditSystemActorResponseDto {
  @ApiProperty({ enum: ['system'] }) kind!: 'system';
  @ApiProperty({ enum: ['warehouse_coverage_engine'] })
  key!: 'warehouse_coverage_engine';
  @ApiProperty({ enum: ['Система'] }) label!: 'Система';
}

@ApiExtraModels(AdminAuditUserActorResponseDto, AdminAuditSystemActorResponseDto)
export class AdminAccessEventResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() type!: string;
  @ApiProperty({ nullable: true }) objectId!: string | null;
  @ApiProperty({ nullable: true }) actorId!: string | null;
  @ApiProperty({ enum: ROLES, nullable: true }) actorRole!: Role | null;
  @ApiProperty({
    oneOf: [
      { $ref: getSchemaPath(AdminAuditUserActorResponseDto) },
      { $ref: getSchemaPath(AdminAuditSystemActorResponseDto) },
    ],
    discriminator: { propertyName: 'kind' },
  })
  actor!: AdminAuditUserActorResponseDto | AdminAuditSystemActorResponseDto;
  @ApiProperty({ nullable: true }) label!: string | null;
  @ApiProperty({ nullable: true, type: Object }) oldValue!: object | null;
  @ApiProperty({ nullable: true, type: Object }) newValue!: object | null;
  @ApiProperty({ nullable: true }) reason!: string | null;
  @ApiProperty() createdAt!: Date;
}

export class AdminAccessEventListResponseDto {
  @ApiProperty({ type: [AdminAccessEventResponseDto] }) items!: AdminAccessEventResponseDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}

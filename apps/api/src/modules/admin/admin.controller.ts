import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import { AdminAccessService } from './admin-access.service';
import { AdminAccountsService } from './admin-accounts.service';
import { AdminAuditProjectionService } from './admin-audit-projection.service';
import { AdminService } from './admin.service';
import {
  ApplyAccessTemplateDto,
  CreateAccessTemplateDto,
  ReplaceUserAccessDto,
  UpdateAccessTemplateDto,
} from './dto/admin-access.dto';
import { AdminReasonDto, CreateAdminUserDto, UpdateAdminUserDto } from './dto/admin-account.dto';
import { AdminAccessEventsQueryDto, AdminUserQueryDto } from './dto/admin-query.dto';
import {
  AccessTemplateResponseDto,
  AdminCapabilityCatalogItemResponseDto,
  AdminAccessEventListResponseDto,
  AdminSessionResponseDto,
  AdminUserListResponseDto,
  AdminUserResponseDto,
  TemporaryCredentialResponseDto,
} from './dto/admin-response.dto';
import { RevokeAdminSessionsDto } from './dto/admin-session.dto';

@ApiTags('admin')
@ApiBearerAuth('session')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly service: AdminService,
    private readonly accounts: AdminAccountsService,
    private readonly access: AdminAccessService,
    private readonly accessAudit: AdminAuditProjectionService,
  ) {}

  @Get('users')
  @RequireCapabilities('admin:users')
  @ApiOkResponse({ type: AdminUserListResponseDto })
  users(@Query() query: AdminUserQueryDto) {
    return this.accounts.list(query);
  }

  @Post('users')
  @RequireCapabilities('admin:users', 'admin:role_templates')
  @ApiCreatedResponse({ type: TemporaryCredentialResponseDto })
  async createUser(
    @CurrentActor() actor: Actor | undefined,
    @Body() dto: CreateAdminUserDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.accounts.create(this.requireActor(actor), dto);
  }

  @Get('users/:userId')
  @RequireCapabilities('admin:users')
  @ApiOkResponse({ type: AdminUserResponseDto })
  user(@Param('userId') userId: string) {
    return this.accounts.get(userId);
  }

  @Patch('users/:userId')
  @RequireCapabilities('admin:users', 'admin:role_templates')
  @ApiOkResponse({ type: AdminUserResponseDto })
  updateUser(
    @CurrentActor() actor: Actor | undefined,
    @Param('userId') userId: string,
    @Body() dto: UpdateAdminUserDto,
  ) {
    return this.accounts.updateProfile(this.requireActor(actor), userId, dto);
  }

  @Post('users/:userId/block')
  @HttpCode(200)
  @RequireCapabilities('admin:users', 'admin:role_templates')
  @ApiOkResponse({ type: AdminUserResponseDto })
  blockUser(
    @CurrentActor() actor: Actor | undefined,
    @Param('userId') userId: string,
    @Body() dto: AdminReasonDto,
  ) {
    return this.accounts.block(this.requireActor(actor), userId, dto.reason);
  }

  @Post('users/:userId/reactivate')
  @HttpCode(200)
  @RequireCapabilities('admin:users', 'admin:role_templates')
  @ApiOkResponse({ type: AdminUserResponseDto })
  reactivateUser(
    @CurrentActor() actor: Actor | undefined,
    @Param('userId') userId: string,
    @Body() dto: AdminReasonDto,
  ) {
    return this.accounts.reactivate(this.requireActor(actor), userId, dto.reason);
  }

  @Post('users/:userId/reset-password')
  @RequireCapabilities('admin:users', 'admin:role_templates')
  @ApiCreatedResponse({ type: TemporaryCredentialResponseDto })
  async resetUserPassword(
    @CurrentActor() actor: Actor | undefined,
    @Param('userId') userId: string,
    @Body() dto: AdminReasonDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.accounts.resetPassword(this.requireActor(actor), userId, dto.reason);
  }

  @Get('users/:userId/sessions')
  @RequireCapabilities('admin:users')
  @ApiOkResponse({ type: [AdminSessionResponseDto] })
  userSessions(@Param('userId') userId: string) {
    return this.accounts.listSessions(userId);
  }

  @Post('users/:userId/sessions/revoke')
  @HttpCode(200)
  @RequireCapabilities('admin:users', 'admin:role_templates')
  @ApiOkResponse()
  revokeUserSessions(
    @CurrentActor() actor: Actor | undefined,
    @Param('userId') userId: string,
    @Body() dto: RevokeAdminSessionsDto,
  ) {
    return this.accounts.revokeSessions(this.requireActor(actor), userId, dto);
  }

  @Put('users/:userId/access')
  @RequireCapabilities('admin:users', 'admin:role_templates')
  @ApiOkResponse({ type: AdminUserResponseDto })
  replaceUserAccess(
    @CurrentActor() actor: Actor | undefined,
    @Param('userId') userId: string,
    @Body() dto: ReplaceUserAccessDto,
  ) {
    return this.access.replaceUserAccess(this.requireActor(actor), userId, dto);
  }

  @Get('role-templates')
  @RequireCapabilities('admin:role_templates')
  @ApiOkResponse({ type: [AccessTemplateResponseDto] })
  roleTemplates() {
    return this.access.listTemplates();
  }

  @Get('capabilities')
  @RequireCapabilities('admin:users', 'admin:role_templates')
  @ApiBearerAuth('session')
  @ApiOkResponse({ type: AdminCapabilityCatalogItemResponseDto, isArray: true })
  @ApiUnauthorizedResponse({ description: 'Authentication is required' })
  @ApiForbiddenResponse({ description: 'Full access administration authority is required' })
  capabilities(@CurrentActor() actor: Actor | undefined) {
    return this.access.listCapabilities(this.requireActor(actor));
  }

  @Post('role-templates')
  @RequireCapabilities('admin:users', 'admin:role_templates')
  @ApiCreatedResponse({ type: AccessTemplateResponseDto })
  createTemplate(@CurrentActor() actor: Actor | undefined, @Body() dto: CreateAccessTemplateDto) {
    return this.access.createTemplate(this.requireActor(actor), dto);
  }

  @Patch('role-templates/:templateId')
  @RequireCapabilities('admin:users', 'admin:role_templates')
  @ApiOkResponse({ type: AccessTemplateResponseDto })
  updateTemplate(
    @CurrentActor() actor: Actor | undefined,
    @Param('templateId') templateId: string,
    @Body() dto: UpdateAccessTemplateDto,
  ) {
    return this.access.updateTemplate(this.requireActor(actor), templateId, dto);
  }

  @Post('users/:userId/role-template')
  @HttpCode(200)
  @RequireCapabilities('admin:users', 'admin:role_templates')
  @ApiOkResponse({ type: AdminUserResponseDto })
  setRoleTemplate(
    @CurrentActor() actor: Actor | undefined,
    @Param('userId') userId: string,
    @Body() dto: ApplyAccessTemplateDto,
  ) {
    return this.access.applyTemplate(this.requireActor(actor), userId, dto);
  }

  @Get('access-events')
  @RequireCapabilities('admin:users')
  @ApiOkResponse({ type: AdminAccessEventListResponseDto })
  accessEvents(@Query() query: AdminAccessEventsQueryDto) {
    return this.accessAudit.list(query);
  }

  @Get('diagnostics/:diagnosticId')
  @RequireCapabilities('admin:diagnostics')
  diagnostic(@Param('diagnosticId') diagnosticId: string) {
    return this.service.getDiagnostic(diagnosticId);
  }

  private requireActor(actor: Actor | undefined): Actor {
    if (!actor) throw new UnauthorizedException('Authentication required.');
    return actor;
  }
}

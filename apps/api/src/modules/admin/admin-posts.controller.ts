import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import { AdminPostsService } from './admin-posts.service';
import { AdminReasonDto } from './dto/admin-account.dto';
import { CreateAdminPostDto, UpdateAdminPostDto } from './dto/admin-post.dto';

@ApiTags('admin')
@ApiBearerAuth('session')
@Controller('admin/posts')
export class AdminPostsController {
  constructor(private readonly posts: AdminPostsService) {}

  @Get()
  @RequireCapabilities('admin:posts')
  @ApiOkResponse({ description: 'Safe machine-post catalog without gateway credentials.' })
  list() {
    return this.posts.list();
  }

  @Post()
  @RequireCapabilities('admin:posts')
  @ApiCreatedResponse({ description: 'Created machine-post.' })
  create(@CurrentActor() actor: Actor | undefined, @Body() dto: CreateAdminPostDto) {
    return this.posts.create(this.requireActor(actor), dto);
  }

  @Get(':postId')
  @RequireCapabilities('admin:posts')
  @ApiOkResponse({ description: 'Safe machine-post and bound devices.' })
  get(@Param('postId') postId: string) {
    return this.posts.get(postId);
  }

  @Patch(':postId')
  @RequireCapabilities('admin:posts')
  @ApiOkResponse({ description: 'Updated post lifecycle configuration.' })
  update(
    @CurrentActor() actor: Actor | undefined,
    @Param('postId') postId: string,
    @Body() dto: UpdateAdminPostDto,
  ) {
    return this.posts.update(this.requireActor(actor), postId, dto);
  }

  @Post(':postId/rotate-token')
  @RequireCapabilities('admin:posts')
  @ApiCreatedResponse({ description: 'One-time gateway agent token.' })
  async rotateToken(
    @CurrentActor() actor: Actor | undefined,
    @Param('postId') postId: string,
    @Body() dto: AdminReasonDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.posts.rotateToken(this.requireActor(actor), postId, dto.reason);
  }

  @Post(':postId/commission')
  @RequireCapabilities('admin:posts')
  @ApiCreatedResponse({ description: 'Commissioned post after compatible physical evidence.' })
  commission(
    @CurrentActor() actor: Actor | undefined,
    @Param('postId') postId: string,
    @Body() dto: AdminReasonDto,
  ) {
    return this.posts.commission(this.requireActor(actor), postId, dto.reason);
  }

  @Get(':postId/quality')
  @RequireCapabilities('admin:posts')
  @ApiOkResponse({ description: 'Heartbeat, command quality and post incidents.' })
  quality(@Param('postId') postId: string) {
    return this.posts.quality(postId);
  }

  private requireActor(actor: Actor | undefined): Actor {
    if (!actor) throw new UnauthorizedException('Authentication required.');
    return actor;
  }
}

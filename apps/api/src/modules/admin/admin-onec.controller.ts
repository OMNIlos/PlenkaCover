import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import { RequireOneCRuntime } from '../../common/auth/require-onec-runtime.decorator';
import { AdminOneCService } from './admin-onec.service';
import { AdminOneCImportDto, AdminOneCSnapshotQueryDto } from './dto/admin-onec.dto';
import { AdminOneCSyncRunsQueryDto } from './dto/admin-onec-sync.dto';

@ApiTags('admin')
@ApiBearerAuth('session')
@RequireOneCRuntime()
@Controller('admin')
export class AdminOneCController {
  constructor(private readonly onec: AdminOneCService) {}

  @Get('onec')
  @RequireCapabilities('admin:onec')
  @ApiOkResponse({ description: 'Safe 1С connection, freshness and journal overview.' })
  overview() {
    return this.onec.overview();
  }

  @Post('onec/check')
  @RequireCapabilities('admin:onec')
  @ApiCreatedResponse({ description: 'Bounded 1С connection check.' })
  check(@CurrentActor() actor: Actor | undefined) {
    return this.onec.check(this.requireActor(actor));
  }

  @Post('onec/imports')
  @RequireCapabilities('admin:onec')
  @ApiCreatedResponse({ description: 'Safe projection of imported 1С snapshots.' })
  import(@CurrentActor() actor: Actor | undefined, @Body() dto: AdminOneCImportDto) {
    return this.onec.import(this.requireActor(actor), dto);
  }

  @Post('onec/retries/:journalId')
  @RequireCapabilities('admin:onec')
  @ApiCreatedResponse({ description: 'Result of an actual mapped 1С retry.' })
  retry(@CurrentActor() actor: Actor | undefined, @Param('journalId') journalId: string) {
    return this.onec.retry(this.requireActor(actor), journalId);
  }

  @Post('onec/sync/preview')
  @RequireCapabilities('admin:onec')
  @ApiCreatedResponse({ description: 'Read-only 1С synchronization preview.' })
  syncPreview(@CurrentActor() actor: Actor | undefined) {
    return this.onec.previewSync(this.requireActor(actor));
  }

  @Post('onec/sync/run')
  @RequireCapabilities('admin:onec')
  @ApiCreatedResponse({ description: 'Apply the full read-only 1С source synchronization.' })
  syncRun(@CurrentActor() actor: Actor | undefined) {
    return this.onec.runSync(this.requireActor(actor));
  }

  @Get('onec/sync/runs')
  @RequireCapabilities('admin:onec')
  @ApiOkResponse({ description: 'Paginated safe 1С synchronization history.' })
  syncRuns(@CurrentActor() actor: Actor | undefined, @Query() query: AdminOneCSyncRunsQueryDto) {
    this.requireActor(actor);
    return this.onec.listSyncRuns(query);
  }

  @Get('onec/sync/runs/:runId')
  @RequireCapabilities('admin:onec')
  @ApiOkResponse({ description: 'Safe state and counters for one 1С synchronization.' })
  syncRunById(@CurrentActor() actor: Actor | undefined, @Param('runId') runId: string) {
    this.requireActor(actor);
    return this.onec.getSyncRun(runId);
  }

  @Get('onec/reconciliation')
  @RequireCapabilities('admin:onec')
  @ApiOkResponse({ description: 'Safe latest 1С reconciliation state.' })
  reconciliation(@CurrentActor() actor: Actor | undefined) {
    this.requireActor(actor);
    return this.onec.reconciliation();
  }

  @Get('onec/snapshots')
  @RequireCapabilities('admin:onec')
  @ApiOkResponse({ description: 'Paginated source snapshots without raw payload.' })
  snapshots(@Query() query: AdminOneCSnapshotQueryDto) {
    return this.onec.listSnapshots(query);
  }

  @Get('onec/snapshots/:snapshotId/raw')
  @RequireCapabilities('admin:diagnostics')
  @ApiOkResponse({ description: 'Explicit admin-only raw source snapshot.' })
  async rawSnapshot(
    @Param('snapshotId') snapshotId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.onec.rawSnapshot(snapshotId);
  }

  @Get('source-health')
  @RequireCapabilities('admin:onec')
  @ApiOkResponse({ description: 'Compatibility source-health projection.' })
  sourceHealth() {
    return this.onec.sourceHealth();
  }

  @Post('source-health/:sourceId/retry')
  @RequireCapabilities('admin:onec')
  @ApiCreatedResponse({ description: 'Compatibility route for an actual mapped retry.' })
  retrySource(@CurrentActor() actor: Actor | undefined, @Param('sourceId') sourceId: string) {
    return this.onec.retry(this.requireActor(actor), sourceId);
  }

  private requireActor(actor: Actor | undefined): Actor {
    if (!actor) throw new UnauthorizedException('Authentication required.');
    return actor;
  }
}

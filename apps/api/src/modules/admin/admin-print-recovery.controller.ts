import { Body, Controller, Get, Param, Post, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import { AdminPrintRecoveryService } from './admin-print-recovery.service';
import { AdminLabelPrintReconciliationDto } from './dto/admin-label-print-reconciliation.dto';
import {
  AdminUnresolvedPrintJobDto,
  AdminBagPrintReconciliationResponseDto,
} from './dto/admin-print-recovery.dto';

@ApiTags('admin')
@ApiBearerAuth('session')
@Controller('admin/print-recovery')
export class AdminPrintRecoveryController {
  constructor(private readonly recovery: AdminPrintRecoveryService) {}

  @Get('unresolved')
  @RequireCapabilities('admin:devices')
  @ApiOkResponse({
    type: AdminUnresolvedPrintJobDto,
    isArray: true,
    description:
      'Up to 50 unresolved deliveries per kind, oldest first. Refresh after reconciliation.',
  })
  listUnresolved() {
    return this.recovery.listUnresolved();
  }

  @Post('defect-bags/:printJobId/reconcile')
  @RequireCapabilities('admin:devices')
  @ApiCreatedResponse({
    description: 'Audited physical fact; does not send a print command.',
    type: AdminBagPrintReconciliationResponseDto,
  })
  reconcileDefectBag(
    @CurrentActor() actor: Actor | undefined,
    @Param('printJobId') printJobId: string,
    @Body() dto: AdminLabelPrintReconciliationDto,
  ) {
    if (!actor) throw new UnauthorizedException('Authentication required.');
    return this.recovery.reconcileBag(actor, 'defect_bag', printJobId, dto);
  }

  @Post('big-bags/:printJobId/reconcile')
  @RequireCapabilities('admin:devices')
  @ApiCreatedResponse({
    description: 'Audited physical fact; preserves registration and stock.',
    type: AdminBagPrintReconciliationResponseDto,
  })
  reconcileBigBag(
    @CurrentActor() actor: Actor | undefined,
    @Param('printJobId') printJobId: string,
    @Body() dto: AdminLabelPrintReconciliationDto,
  ) {
    if (!actor) throw new UnauthorizedException('Authentication required.');
    return this.recovery.reconcileBag(actor, 'big_bag', printJobId, dto);
  }
}

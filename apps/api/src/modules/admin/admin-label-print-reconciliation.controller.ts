import { Body, Controller, Param, Post, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import { AdminLabelPrintReconciliationService } from './admin-label-print-reconciliation.service';
import { AdminLabelPrintReconciliationDto } from './dto/admin-label-print-reconciliation.dto';

@ApiTags('admin')
@ApiBearerAuth('session')
@Controller('admin/label-print-jobs')
export class AdminLabelPrintReconciliationController {
  constructor(private readonly reconciliations: AdminLabelPrintReconciliationService) {}

  @Post(':printJobId/reconcile')
  @RequireCapabilities('admin:devices')
  @ApiCreatedResponse({
    description: 'Immutable resolution of a physically ambiguous label delivery.',
  })
  reconcile(
    @CurrentActor() actor: Actor | undefined,
    @Param('printJobId') printJobId: string,
    @Body() dto: AdminLabelPrintReconciliationDto,
  ) {
    if (!actor) throw new UnauthorizedException('Authentication required.');
    return this.reconciliations.reconcile(actor, printJobId, dto);
  }
}

import { Body, Controller, Get, Param, Post, Query, UnauthorizedException } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentActor, type Actor } from '../../common/auth/actor';
import { RequireCapabilities } from '../../common/auth/require-capabilities.decorator';
import { AdminPalletPrintReconciliationService } from './admin-pallet-print-reconciliation.service';
import {
  AdminPalletPrintReconciliationDto,
  AdminPalletPrintReconciliationQueryDto,
  AdminPalletPrintReconciliationResponseDto,
  AdminUnresolvedPalletPrintJobResponseDto,
} from './dto/admin-pallet-print-reconciliation.dto';

@ApiTags('admin')
@ApiBearerAuth('session')
@Controller('admin/pallet-print-jobs')
export class AdminPalletPrintReconciliationController {
  constructor(private readonly reconciliations: AdminPalletPrintReconciliationService) {}

  @Get('unresolved')
  @RequireCapabilities('admin:devices')
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 50 })
  @ApiOkResponse({
    description: 'Bounded newest-first list of unresolved pallet-label deliveries.',
    type: AdminUnresolvedPalletPrintJobResponseDto,
    isArray: true,
  })
  listUnresolved(
    @Query() query: AdminPalletPrintReconciliationQueryDto,
  ): Promise<AdminUnresolvedPalletPrintJobResponseDto[]> {
    return this.reconciliations.listUnresolved(query.limit);
  }

  @Post(':printJobId/reconcile')
  @RequireCapabilities('admin:devices')
  @ApiCreatedResponse({
    description: 'Immutable resolution of a physically ambiguous pallet-label delivery.',
    type: AdminPalletPrintReconciliationResponseDto,
  })
  reconcile(
    @CurrentActor() actor: Actor | undefined,
    @Param('printJobId') printJobId: string,
    @Body() dto: AdminPalletPrintReconciliationDto,
  ): Promise<AdminPalletPrintReconciliationResponseDto> {
    if (!actor) throw new UnauthorizedException('Authentication required.');
    return this.reconciliations.reconcile(actor, printJobId, dto);
  }
}

import { AdminPrintRecoveryController } from './admin-print-recovery.controller';
import { AdminPrintRecoveryService } from './admin-print-recovery.service';
import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AuthModule } from '../auth/auth.module';
import { AdminAccountsService } from './admin-accounts.service';
import { AdminAccessService } from './admin-access.service';
import { AdminAuditProjectionService } from './admin-audit-projection.service';
import { AdminSafetyService } from './admin-safety.service';
import { AdminPrivilegeCeilingService } from './admin-privilege-ceiling.service';
import { IntegrationsModule } from '../../integrations/integrations.module';
import { AdminOneCController } from './admin-onec.controller';
import { AdminOneCService } from './admin-onec.service';
import { OperationalChecksService } from './operational-checks.service';
import { AdminDevicesController } from './admin-devices.controller';
import { AdminPostsController } from './admin-posts.controller';
import { AdminDevicesService } from './admin-devices.service';
import { AdminPostsService } from './admin-posts.service';
import { PlatformHealthController } from './platform-health.controller';
import { PlatformHealthService } from './platform-health.service';
import { GatewayModule } from '../gateway/gateway.module';
import { AdminLabelPrintReconciliationController } from './admin-label-print-reconciliation.controller';
import { AdminLabelPrintReconciliationService } from './admin-label-print-reconciliation.service';
import { OperationalIncidentsModule } from '../../common/operational-incidents/operational-incidents.module';
import { RoleInboxModule } from '../../common/role-inbox/role-inbox.module';
import { AdminNotificationsController } from './admin-notifications.controller';
import { WarehouseCoverageModule } from '../warehouse-coverage/warehouse-coverage.module';
import { AdminPalletPrintReconciliationController } from './admin-pallet-print-reconciliation.controller';
import { AdminPalletPrintReconciliationService } from './admin-pallet-print-reconciliation.service';
import { PalletLabelLayoutEditorController } from './pallet-label-layout-editor.controller';
import { PalletLabelLayoutEditorRenderer } from './pallet-label-layout-editor.renderer';
import { PalletLabelLayoutEditorService } from './pallet-label-layout-editor.service';
import { PalletLabelLayoutModule } from '../../common/pallet-label-layout/pallet-label-layout.module';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    AuthModule,
    IntegrationsModule,
    GatewayModule,
    OperationalIncidentsModule,
    RoleInboxModule,
    WarehouseCoverageModule,
    PalletLabelLayoutModule,
  ],
  controllers: [
    AdminPrintRecoveryController,
    AdminController,
    AdminOneCController,
    AdminDevicesController,
    AdminPostsController,
    PlatformHealthController,
    AdminLabelPrintReconciliationController,
    AdminPalletPrintReconciliationController,
    AdminNotificationsController,
    PalletLabelLayoutEditorController,
  ],
  providers: [
    AdminPrintRecoveryService,
    AdminService,
    AdminAccountsService,
    AdminAccessService,
    AdminAuditProjectionService,
    AdminSafetyService,
    AdminPrivilegeCeilingService,
    AdminOneCService,
    OperationalChecksService,
    AdminDevicesService,
    AdminPostsService,
    PlatformHealthService,
    AdminLabelPrintReconciliationService,
    AdminPalletPrintReconciliationService,
    PalletLabelLayoutEditorRenderer,
    PalletLabelLayoutEditorService,
  ],
})
export class AdminModule {}

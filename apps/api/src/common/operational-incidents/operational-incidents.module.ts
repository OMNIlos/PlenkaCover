import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RuntimeConfigModule, RUNTIME_CONFIG } from '../runtime-config.module';
import type { RuntimeConfig } from '../runtime-config';
import {
  GATEWAY_INCIDENT_RECONCILER_ENABLED,
  GatewayIncidentReconciler,
} from './gateway-incident-reconciler.service';
import { OperationalIncidentReporter } from './operational-incident-reporter.service';
import { OperationalIncidentsService } from './operational-incidents.service';

@Module({
  imports: [PrismaModule, AuditModule, RuntimeConfigModule],
  providers: [
    OperationalIncidentsService,
    OperationalIncidentReporter,
    {
      provide: GATEWAY_INCIDENT_RECONCILER_ENABLED,
      inject: [RUNTIME_CONFIG],
      useFactory: (config: RuntimeConfig) => config.appEnv !== 'test',
    },
    GatewayIncidentReconciler,
  ],
  exports: [OperationalIncidentsService, OperationalIncidentReporter, GatewayIncidentReconciler],
})
export class OperationalIncidentsModule {}

import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditModule } from './common/audit/audit.module';
import { MockActorMiddleware } from './common/auth/mock-actor.middleware';
import { SessionAuthMiddleware } from './common/auth/session-auth.middleware';
import { CapabilityGuard } from './common/auth/capability.guard';
import { PrismaModule } from './common/prisma/prisma.module';
import { RuntimeConfigModule } from './common/runtime-config.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { CommercialModule } from './modules/commercial/commercial.module';
import { ProductionModule } from './modules/production/production.module';
import { OperatorModule } from './modules/operator/operator.module';
import { WarehouseModule } from './modules/warehouse/warehouse.module';
import { FinanceModule } from './modules/finance/finance.module';
import { DirectorModule } from './modules/director/director.module';
import { AdminModule } from './modules/admin/admin.module';
import { GatewayModule } from './modules/gateway/gateway.module';
import { MaterialCatalogModule } from './modules/material-catalog/material-catalog.module';

@Module({
  imports: [
    RuntimeConfigModule,
    PrismaModule,
    AuditModule,
    AuthModule,
    HealthModule,
    CommercialModule,
    ProductionModule,
    OperatorModule,
    WarehouseModule,
    FinanceModule,
    DirectorModule,
    AdminModule,
    GatewayModule,
    MaterialCatalogModule,
  ],
  providers: [
    // Capability-based authorization enforced server-side for every route
    // (ТЗ §4, §11.1). Endpoints opt into requirements via @RequireCapabilities.
    { provide: APP_GUARD, useClass: CapabilityGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Identity resolution order (V2 S1): the real session sets the actor first; the
    // dev-only x-role mock then fills in ONLY if no session resolved one and the dev
    // validated exact development flag is on. The CapabilityGuard enforces server-side.
    consumer.apply(SessionAuthMiddleware, MockActorMiddleware).forRoutes('*');
  }
}

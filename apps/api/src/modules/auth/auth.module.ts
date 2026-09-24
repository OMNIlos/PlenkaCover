import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { SessionService } from '../../common/auth/session.service';
import { AccessPolicyService } from '../../common/auth/access-policy.service';
import { LoginRateLimiter } from '../../common/auth/login-rate-limiter';
import { LoginThrottleGuard } from '../../common/auth/login-throttle.guard';
import { RUNTIME_CONFIG } from '../../common/runtime-config.module';
import type { RuntimeConfig } from '../../common/runtime-config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

/**
 * V2 S1 identity module. Exports SessionService so the SessionAuthMiddleware (applied
 * in AppModule) can resolve the acting user from the Bearer token.
 */
@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    AccessPolicyService,
    LoginThrottleGuard,
    {
      provide: LoginRateLimiter,
      inject: [RUNTIME_CONFIG],
      useFactory: (config: RuntimeConfig) =>
        new LoginRateLimiter({
          max: config.loginRateMax,
          maxKeys: config.loginRateMaxKeys,
          windowMs: config.loginRateWindowMs,
        }),
    },
  ],
  exports: [SessionService, AccessPolicyService],
})
export class AuthModule {}

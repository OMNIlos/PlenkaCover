import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Capability } from '@plenka/contracts';
import type { RequestWithActor } from './actor';
import { RUNTIME_CONFIG } from '../runtime-config.module';
import type { RuntimeConfig } from '../runtime-config';
import { REQUIRE_CAPABILITIES } from './require-capabilities.decorator';
import { REQUIRE_ONEC_RUNTIME } from './require-onec-runtime.decorator';

/**
 * Global guard enforcing capability-based authorization server-side (ТЗ §4, §11.1).
 *
 * - Routes with no @RequireCapabilities are public (e.g. health).
 * - Routes with requirements need an actor holding ALL listed capabilities.
 *   Missing actor -> 401; insufficient capabilities -> 403.
 *
 * This is the single chokepoint that keeps role boundaries from leaking; do not
 * bypass it with ad-hoc role checks scattered in controllers.
 */
@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional()
    @Inject(RUNTIME_CONFIG)
    private readonly config: Pick<RuntimeConfig, 'onecLiveEnabled'> = { onecLiveEnabled: false },
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const requiresOneCRuntime = this.reflector.getAllAndOverride<boolean | undefined>(
      REQUIRE_ONEC_RUNTIME,
      [context.getHandler(), context.getClass()],
    );
    if (requiresOneCRuntime && !this.config.onecLiveEnabled) {
      throw new NotFoundException();
    }

    const required = this.reflector.getAllAndOverride<Capability[] | undefined>(
      REQUIRE_CAPABILITIES,
      [context.getHandler(), context.getClass()],
    );

    if (!required || required.length === 0) {
      return true;
    }

    const req = context.switchToHttp().getRequest<RequestWithActor>();
    const actor = req.actor;

    if (!actor) {
      throw new UnauthorizedException('Требуется аутентификация.');
    }

    const held = new Set(actor.capabilities);
    const missing = required.filter((cap) => !held.has(cap));
    if (missing.length > 0) {
      throw new ForbiddenException(
        `Role "${actor.role}" is missing capability: ${missing.join(', ')}`,
      );
    }

    return true;
  }
}

import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { capabilitiesForRole, ROLES, type Role } from '@plenka/contracts';
import type { NextFunction, Request, Response } from 'express';
import { RUNTIME_CONFIG } from '../runtime-config.module';
import type { RuntimeConfig } from '../runtime-config';
import type { Actor } from './actor';

/**
 * DEV-ONLY mock authentication (V2 S1: superseded by SessionAuthMiddleware).
 *
 * Resolves the acting role from the `x-role` header and attaches a derived Actor.
 * There is NO real identity here, so it is gated by the validated exact pair
 * `APP_ENV=development` + `AUTH_DEV_XROLE=on`, and never overrides an actor already
 * resolved from a real session. Every other profile is inert.
 *
 * ТЗ §11.1: the final RBAC matrix is still a security/discovery item and must NOT be
 * copied blindly from frontend visibility.
 */
@Injectable()
export class MockActorMiddleware implements NestMiddleware {
  constructor(@Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig) {}

  use(req: Request & { actor?: Actor }, _res: Response, next: NextFunction): void {
    if (!this.config.devXRoleEnabled || req.actor) {
      return next();
    }

    const header = (req.headers['x-role'] as string | undefined)?.trim();
    const role = (ROLES as readonly string[]).includes(header ?? '') ? (header as Role) : undefined;

    if (role) {
      req.actor = {
        userId: null,
        role,
        capabilities: capabilitiesForRole(role),
      };
    }

    next();
  }
}

import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AccessPolicyService } from './access-policy.service';
import type { Actor } from './actor';
import { extractBearerToken } from './bearer';
import { SessionService } from './session.service';

/**
 * Real authentication (V2 S1): resolves the acting user from the `Authorization:
 * Bearer <token>` session and attaches a derived Actor (role + server-side
 * capabilities). This is the production identity source that replaces the x-role mock.
 * Invalid/expired tokens leave the request actor-less; the CapabilityGuard then 401s
 * any protected route.
 */
@Injectable()
export class SessionAuthMiddleware implements NestMiddleware {
  constructor(
    private readonly sessions: SessionService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  async use(req: Request & { actor?: Actor }, _res: Response, next: NextFunction): Promise<void> {
    const token = extractBearerToken(req.headers['authorization']);
    if (token) {
      const principal = await this.sessions.validate(token);
      if (principal) {
        req.actor = {
          userId: principal.userId,
          role: principal.role,
          capabilities:
            principal.purpose === 'full'
              ? this.accessPolicy.resolve(principal.role, principal.overrides)
              : [],
          sessionId: principal.sessionId,
          sessionPurpose: principal.purpose,
        };
      }
    }
    next();
  }
}

import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Capability, Role, SessionPurpose } from '@plenka/contracts';

/**
 * The authenticated actor performing a request. Attached to the request by
 * MockActorMiddleware today; by real auth after security discovery (ТЗ §11.1).
 */
export interface Actor {
  userId: string | null;
  role: Role;
  capabilities: readonly Capability[];
  sessionId?: string;
  sessionPurpose?: SessionPurpose;
}

export interface RequestWithActor {
  actor?: Actor;
}

/** Inject the current Actor into a controller handler: `@CurrentActor() actor`. */
export const CurrentActor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Actor | undefined => {
    const req = ctx.switchToHttp().getRequest<RequestWithActor>();
    return req.actor;
  },
);

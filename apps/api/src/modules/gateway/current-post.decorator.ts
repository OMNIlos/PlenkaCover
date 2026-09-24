import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** The machine-post resolved from the agent token by GatewayAuthGuard. */
export interface GatewayPost {
  id: string;
  code: string;
}

/** Inject the current gateway Post: `@CurrentPost() post`. */
export const CurrentPost = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<{ post?: GatewayPost }>().post;
});

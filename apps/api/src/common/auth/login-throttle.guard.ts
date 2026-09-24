import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { LoginRateLimiter } from './login-rate-limiter';

/** Per-IP rate limit for the login route (V2 S7): 429 when exceeded. */
@Injectable()
export class LoginThrottleGuard implements CanActivate {
  constructor(private readonly limiter: LoginRateLimiter) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const key = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    if (!this.limiter.check(key)) {
      throw new HttpException(
        'Слишком много попыток входа. Повторите позже.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}

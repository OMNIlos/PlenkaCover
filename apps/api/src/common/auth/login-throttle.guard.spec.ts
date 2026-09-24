import { HttpException } from '@nestjs/common';
import { LoginThrottleGuard } from './login-throttle.guard';

function contextFor(request: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  };
}

describe('LoginThrottleGuard', () => {
  it('keys attempts by the proxy-validated Express client address', () => {
    const limiter = { check: jest.fn().mockReturnValue(true) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guard = new LoginThrottleGuard(limiter as any);
    expect(
      guard.canActivate(
        contextFor({
          headers: { 'x-forwarded-for': '203.0.113.99' },
          ip: '198.51.100.7',
          socket: { remoteAddress: '172.18.0.4' },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
      ),
    ).toBe(true);
    expect(limiter.check).toHaveBeenCalledWith('198.51.100.7');
  });

  it('returns 429 after the configured limiter rejects the address', () => {
    const limiter = { check: jest.fn().mockReturnValue(false) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guard = new LoginThrottleGuard(limiter as any);
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      guard.canActivate(contextFor({ ip: '198.51.100.7' }) as any),
    ).toThrow(HttpException);
  });
});

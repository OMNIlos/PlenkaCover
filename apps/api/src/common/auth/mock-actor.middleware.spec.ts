import { capabilitiesForRole } from '@plenka/contracts';
import { loadRuntimeConfig, type RuntimeConfig } from '../runtime-config';
import { MockActorMiddleware } from './mock-actor.middleware';

function run(
  config: RuntimeConfig,
  headers: Record<string, string>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  preset?: any,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req: any = { headers, actor: preset };
  const next = jest.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new MockActorMiddleware(config).use(req, {} as any, next);
  expect(next).toHaveBeenCalled();
  return req;
}

describe('MockActorMiddleware (dev x-role gate)', () => {
  it('sets an actor only for the exact validated development/on pair', () => {
    const config = loadRuntimeConfig({ APP_ENV: 'development', AUTH_DEV_XROLE: 'on' });
    const req = run(config, { 'x-role': 'operator' });
    expect(req.actor).toEqual({
      userId: null,
      role: 'operator',
      capabilities: capabilitiesForRole('operator'),
    });
  });

  it('ignores x-role in the test profile even when the raw flag is on', () => {
    const config = loadRuntimeConfig({ APP_ENV: 'test', AUTH_DEV_XROLE: 'on' });
    expect(run(config, { 'x-role': 'admin' }).actor).toBeUndefined();
  });

  it('does nothing in development when the flag is off', () => {
    const config = loadRuntimeConfig({ APP_ENV: 'development' });
    expect(run(config, { 'x-role': 'operator' }).actor).toBeUndefined();
  });

  it('never overwrites an actor already resolved from a session', () => {
    const session = {
      userId: 'u-1',
      role: 'finance',
      capabilities: capabilitiesForRole('finance'),
    };
    const config = loadRuntimeConfig({ APP_ENV: 'development', AUTH_DEV_XROLE: 'on' });
    expect(run(config, { 'x-role': 'admin' }, session).actor).toBe(session);
  });
});

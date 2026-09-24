import { HealthController } from './health.controller';

describe('HealthController', () => {
  const health = {
    readiness: jest.fn().mockResolvedValue({
      status: 'ready',
      service: 'plenka-api',
      time: '2026-07-13T12:00:00.000Z',
    }),
  };
  const controller = new HealthController(health as never);

  it('reports ok', () => {
    const result = controller.check();
    expect(result.status).toBe('ok');
    expect(result.service).toBe('plenka-api');
    expect(() => new Date(result.time).toISOString()).not.toThrow();
  });

  it('delegates readiness to the database-backed health service', async () => {
    await expect(controller.ready()).resolves.toMatchObject({ status: 'ready' });
    expect(health.readiness).toHaveBeenCalled();
  });
});

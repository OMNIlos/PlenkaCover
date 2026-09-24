import express from 'express';
import request from 'supertest';
import { loadRuntimeConfig } from './runtime-config';
import { configureHttpSecurity, trustOneHopPrivateProxy } from './http-security';

describe('HTTP edge security', () => {
  it('trusts only an immediate private-network proxy', () => {
    expect(trustOneHopPrivateProxy('172.18.0.4', 0)).toBe(true);
    expect(trustOneHopPrivateProxy('::ffff:127.0.0.1', 0)).toBe(true);
    expect(trustOneHopPrivateProxy('172.18.0.4', 1)).toBe(false);
    expect(trustOneHopPrivateProxy('203.0.113.10', 0)).toBe(false);
  });

  it('keeps proxied clients distinct and ignores a farther spoofed address', async () => {
    const app = express();
    app.set('trust proxy', trustOneHopPrivateProxy);
    app.get('/', (req, res) => res.json({ ip: req.ip }));

    await request(app)
      .get('/')
      .set('x-forwarded-for', '203.0.113.99, 198.51.100.7')
      .expect(200, { ip: '198.51.100.7' });
    await request(app)
      .get('/')
      .set('x-forwarded-for', '198.51.100.8')
      .expect(200, { ip: '198.51.100.8' });
  });

  it('does not identify the Express runtime in direct API responses', async () => {
    const app = express();
    configureHttpSecurity(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      app as any,
      loadRuntimeConfig({ APP_ENV: 'test' }),
    );
    app.get('/', (_req, res) => res.json({ status: 'ok' }));

    const response = await request(app).get('/').expect(200);

    expect(response.headers).not.toHaveProperty('x-powered-by');
  });

  it('leaves CORS absent by default and enables only an exact configured allowlist', () => {
    const sameOriginApp = { disable: jest.fn(), enableCors: jest.fn(), set: jest.fn() };
    configureHttpSecurity(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sameOriginApp as any,
      loadRuntimeConfig({ APP_ENV: 'test' }),
    );
    expect(sameOriginApp.set).toHaveBeenCalledWith('trust proxy', trustOneHopPrivateProxy);
    expect(sameOriginApp.enableCors).not.toHaveBeenCalled();

    const crossOriginApp = { disable: jest.fn(), enableCors: jest.fn(), set: jest.fn() };
    configureHttpSecurity(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      crossOriginApp as any,
      loadRuntimeConfig({
        APP_ENV: 'test',
        CORS_ORIGINS: 'https://review.example.com,http://localhost:5173',
      }),
    );
    expect(crossOriginApp.enableCors).toHaveBeenCalledWith({
      credentials: true,
      origin: ['https://review.example.com', 'http://localhost:5173'],
    });
  });
});

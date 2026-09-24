import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';

describe('Auth runtime profile (e2e)', () => {
  let app: INestApplication;
  const previous = {
    APP_ENV: process.env.APP_ENV,
    AUTH_DEV_XROLE: process.env.AUTH_DEV_XROLE,
    GATEWAY_SIMULATOR: process.env.GATEWAY_SIMULATOR,
    ONEC_LIVE: process.env.ONEC_LIVE,
    ONEC_WRITE: process.env.ONEC_WRITE,
  };

  beforeAll(async () => {
    process.env.APP_ENV = 'test';
    process.env.AUTH_DEV_XROLE = 'on';
    process.env.GATEWAY_SIMULATOR = 'off';
    process.env.ONEC_LIVE = 'false';
    process.env.ONEC_WRITE = 'false';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);
  });

  afterAll(async () => {
    await app?.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('rejects x-role and authorizes a real Bearer session', async () => {
    await request(app.getHttpServer())
      .get('/api/commercial/orders')
      .set('x-role', 'commercial')
      .expect(401);

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ login: e2eSeedLogin('commercial'), password: e2eSeedPassword() })
      .expect(201);
    const token = login.body.token as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('authorization', `Bearer ${token}`)
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ role: 'commercial' }));
    await request(app.getHttpServer())
      .get('/api/commercial/orders')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
  });
});

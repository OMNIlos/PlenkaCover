import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { isCanonicalPilotAgentToken } from '@plenka/contracts';
import request from 'supertest';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';

describe('Admin control plane A2-A5 (e2e, real DB)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let simulator: any;
  let createdDeviceId: string | undefined;
  let rotatedPostId: string | undefined;
  let originalAgentTokenHash: string | null | undefined;
  let originalScaleOne: { postId: string | null; isEnabled: boolean; status: string } | undefined;

  const startedAt = new Date();
  const unique = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  const savedEnv: Record<string, string | undefined> = {};
  const flags = {
    AUTH_DEV_XROLE: 'off',
    GATEWAY_SIMULATOR: 'on',
    ONEC_LIVE: 'false',
    ONEC_WRITE: 'false',
  } as const;

  beforeAll(async () => {
    for (const [key, value] of Object.entries(flags)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { AppModule } = require('../src/app.module');
    const { PrismaService: PrismaServiceClass } = require('../src/common/prisma/prisma.service');
    const { SimulatedGatewayAgent } = require('../src/modules/gateway/simulated-gateway-agent');
    /* eslint-enable @typescript-eslint/no-require-imports */

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = moduleRef.get(PrismaServiceClass);
    simulator = moduleRef.get(SimulatedGatewayAgent);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);
  });

  afterAll(async () => {
    if (prisma) {
      if (rotatedPostId && originalAgentTokenHash !== undefined) {
        await prisma.post.update({
          where: { id: rotatedPostId },
          data: { agentTokenHash: originalAgentTokenHash },
        });
      }
      if (createdDeviceId) {
        await prisma.operationalCheck.deleteMany({ where: { targetId: createdDeviceId } });
        await prisma.operationalIncident.deleteMany({ where: { targetId: createdDeviceId } });
        await prisma.deviceRuntime.deleteMany({ where: { id: createdDeviceId } });
      }
      if (originalScaleOne) {
        await prisma.deviceRuntime.update({
          where: { id: 'dev-scale-1' },
          data: originalScaleOne,
        });
      }
      await prisma.operationalCheck.deleteMany({ where: { createdAt: { gte: startedAt } } });
      await prisma.sourceSnapshot.deleteMany({
        where: { subjectType: 'payment', createdAt: { gte: startedAt } },
      });
    }
    await app?.close();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('keeps 1C hidden and controls devices, posts, health and incidents through admin auth', async () => {
    const http = () => request(app.getHttpServer());
    const adminLogin = await http()
      .post('/api/auth/login')
      .send({ login: e2eSeedLogin('admin'), password: e2eSeedPassword() })
      .expect(201);
    const asAdmin = { Authorization: `Bearer ${adminLogin.body.token as string}` };

    const operatorLogin = await http()
      .post('/api/auth/login')
      .send({ login: e2eSeedLogin('operator'), password: e2eSeedPassword() })
      .expect(201);
    const asOperator = { Authorization: `Bearer ${operatorLogin.body.token as string}` };
    await http().get('/api/admin/onec').set(asOperator).expect(404);
    await http().get('/api/admin/platform-health').set(asOperator).expect(403);

    const oneCSnapshotsBefore = await prisma.sourceSnapshot.count();
    await http().get('/api/admin/onec').set(asAdmin).expect(404);
    await http().post('/api/admin/onec/check').set(asAdmin).expect(404);
    await http()
      .post('/api/admin/onec/imports')
      .set(asAdmin)
      .send({ subjectType: 'payment' })
      .expect(404);
    await expect(prisma.sourceSnapshot.count()).resolves.toBe(oneCSnapshotsBefore);

    const posts = await http().get('/api/admin/posts').set(asAdmin).expect(200);
    const post1 = posts.body.find((post: { code: string }) => post.code === 'POST-1');
    const post2 = posts.body.find((post: { code: string }) => post.code === 'POST-2');
    expect(post1).toBeTruthy();
    expect(post2).toBeTruthy();

    const createdDevice = await http()
      .post('/api/admin/devices')
      .set(asAdmin)
      .send({
        code: `E2E-SCALE-${unique}`,
        label: `E2E весы ${unique}`,
        kind: 'scale',
        connectionKind: 'usb-rs232',
      })
      .expect(201);
    createdDeviceId = createdDevice.body.id as string;
    expect(createdDevice.body.postId).toBeNull();
    expect(JSON.stringify(createdDevice.body)).not.toContain('rawPayload');

    originalScaleOne = await prisma.deviceRuntime.findUniqueOrThrow({
      where: { id: 'dev-scale-1' },
      select: { postId: true, isEnabled: true, status: true },
    });

    await http()
      .patch('/api/admin/devices/dev-scale-1')
      .set(asAdmin)
      .send({ isEnabled: false, reason: 'E2E replacement binding verification' })
      .expect(200);

    await http()
      .post(`/api/admin/devices/${createdDeviceId}/bind`)
      .set(asAdmin)
      .send({ postId: post1.id, reason: 'E2E binding verification' })
      .expect(201);

    await simulator.setOffline(createdDeviceId);
    const failedTest = await http()
      .post(`/api/admin/devices/${createdDeviceId}/test`)
      .set(asAdmin)
      .expect(201);
    expect(failedTest.body).toMatchObject({ id: createdDeviceId, status: 'offline' });

    const incidents = await http()
      .get('/api/admin/incidents')
      .query({ scope: 'device', status: 'open' })
      .set(asAdmin)
      .expect(200);
    const incident = incidents.body.find(
      (item: { targetId: string }) => item.targetId === createdDeviceId,
    );
    expect(incident).toBeTruthy();
    await http()
      .post(`/api/admin/incidents/${incident.id as string}/acknowledge`)
      .set(asAdmin)
      .send({ reason: 'E2E incident acknowledged' })
      .expect(201);
    await http()
      .post(`/api/admin/incidents/${incident.id as string}/resolve`)
      .set(asAdmin)
      .send({ reason: 'E2E cable restored' })
      .expect(201);

    const recovered = await http()
      .post(`/api/admin/devices/${createdDeviceId}/recover`)
      .set(asAdmin)
      .send({ reason: 'E2E simulated recovery' })
      .expect(201);
    expect(recovered.body).toMatchObject({ id: createdDeviceId, status: 'ready' });
    const quality = await http()
      .get(`/api/admin/devices/${createdDeviceId}/quality`)
      .set(asAdmin)
      .expect(200);
    expect(quality.body.quality.totalChecks).toBeGreaterThanOrEqual(2);

    rotatedPostId = post2.id as string;
    const originalPost = await prisma.post.findUniqueOrThrow({ where: { id: rotatedPostId } });
    originalAgentTokenHash = originalPost.agentTokenHash;
    const rotated = await http()
      .post(`/api/admin/posts/${rotatedPostId}/rotate-token`)
      .set(asAdmin)
      .send({ reason: 'E2E credential rotation' })
      .expect(201);
    expect(rotated.headers['cache-control']).toContain('no-store');
    expect(isCanonicalPilotAgentToken(rotated.body.token as string)).toBe(true);
    await http()
      .post('/api/gateway/heartbeat')
      .set('x-agent-token', 'agent-post-2')
      .send({ devices: [] })
      .expect(401);
    await http()
      .post('/api/gateway/heartbeat')
      .set('x-agent-token', rotated.body.token as string)
      .send({ devices: [] })
      .expect(201);

    const platform = await http().post('/api/admin/platform-health/check').set(asAdmin).expect(201);
    expect(platform.body.status).toMatch(/ready|degraded/);
    expect(platform.body.components).toMatchObject({
      database: { status: 'ready' },
      onec: { status: 'ready' },
    });
    expect(JSON.stringify(platform.body)).not.toMatch(/agentTokenHash|rawPayload|password/i);
    await http().get('/api/health/ready').expect(200);
  });
});

import { INestApplication, RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { capabilitiesForRole, type Capability, type Role } from '@plenka/contracts';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { CapabilityGuard } from '../../common/auth/capability.guard';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';
import { ProductionService } from '../production/production.service';
import { BusinessOperationalProblemOverrideController } from './business-operational-problem-override.controller';

describe('business operational problem director override boundary', () => {
  let app: INestApplication;
  const production = {
    resolveProblem: jest.fn().mockResolvedValue({
      id: 'problem-defect-1',
      type: 'defect',
      status: 'resolved',
    }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BusinessOperationalProblemOverrideController],
      providers: [{ provide: ProductionService, useValue: production }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const role = req.header('x-test-role') as Role;
      Object.assign(req, {
        actor: { userId: `${role}-1`, role, capabilities: capabilitiesForRole(role) },
      });
      next();
    });
    app.useGlobalGuards(new CapabilityGuard(moduleRef.get(Reflector)));
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    production.resolveProblem.mockClear();
  });

  it('exposes a director-only audited production override route', () => {
    const reflector = new Reflector();
    const handler = BusinessOperationalProblemOverrideController.prototype.resolveProblem;

    expect(
      reflector.get<Capability[]>(REQUIRE_CAPABILITIES, handler),
    ).toEqual(['override:production']);
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(
      Reflect.getMetadata(PATH_METADATA, BusinessOperationalProblemOverrideController),
    ).toBe('commercial/performance/problems');
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':problemId/resolve');
  });

  it('reuses the production defect resolution with the director actor and required note', async () => {
    await request(app.getHttpServer())
      .post('/api/commercial/performance/problems/problem-defect-1/resolve')
      .set({ 'x-test-role': 'director' })
      .send({ resolution: 'rework', note: 'Переделка согласована после проверки веса' })
      .expect(201)
      .expect({
        id: 'problem-defect-1',
        type: 'defect',
        status: 'resolved',
      });

    expect(production.resolveProblem).toHaveBeenCalledWith(
      { userId: 'director-1', role: 'director' },
      'problem-defect-1',
      {
        resolution: 'rework',
        note: 'Переделка согласована после проверки веса',
      },
    );
  });

  it('reuses the existing machine-breakdown confirmation without bypassing its domain checks', async () => {
    await request(app.getHttpServer())
      .post('/api/commercial/performance/problems/problem-breakdown-1/resolve')
      .set({ 'x-test-role': 'director' })
      .send({ resolution: 'confirm', note: 'Поломка подтверждена после осмотра станка' })
      .expect(201);

    expect(production.resolveProblem).toHaveBeenCalledWith(
      { userId: 'director-1', role: 'director' },
      'problem-breakdown-1',
      {
        resolution: 'confirm',
        note: 'Поломка подтверждена после осмотра станка',
      },
    );
  });

  it.each(['commercial', 'production_lead', 'operator', 'warehouse', 'finance', 'admin'] as const)(
    'denies %s access to the production override',
    async (role) => {
      await request(app.getHttpServer())
        .post('/api/commercial/performance/problems/problem-defect-1/resolve')
        .set({ 'x-test-role': role })
        .send({ resolution: 'writeoff', note: 'Списание согласовано после проверки веса' })
        .expect(403);
    },
  );

  it.each([
    { resolution: 'close', note: 'Закрыть' },
    { resolution: 'writeoff', note: '   ' },
    { resolution: 'rework' },
    { resolution: 'writeoff', note: 'x'.repeat(1001) },
  ])('rejects an unsafe or incomplete defect resolution payload: %j', async (payload) => {
    await request(app.getHttpServer())
      .post('/api/commercial/performance/problems/problem-defect-1/resolve')
      .set({ 'x-test-role': 'director' })
      .send(payload)
      .expect(400);

    expect(production.resolveProblem).not.toHaveBeenCalled();
  });
});

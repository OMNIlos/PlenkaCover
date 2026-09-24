import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { capabilitiesForRole, type Role } from '@plenka/contracts';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { CapabilityGuard } from '../../common/auth/capability.guard';
import { CommercialProblemController } from './commercial-problem.controller';
import { CommercialProblemService } from './commercial-problem.service';

function authHeaders(role: Role) {
  return { 'x-test-role': role };
}

describe('commercial problems access', () => {
  let app: INestApplication;
  const problems = {
    list: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CommercialProblemController],
      providers: [{ provide: CommercialProblemService, useValue: problems }],
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
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    problems.list.mockClear();
  });

  it.each(['commercial', 'production_lead'] as const)('allows %s with order:read', async (role) => {
    await request(app.getHttpServer())
      .get('/api/commercial/problems?filter=open')
      .set(authHeaders(role))
      .expect(200)
      .expect({ items: [], nextCursor: null });
  });

  it.each(['operator', 'warehouse', 'finance', 'director', 'admin'] as const)(
    'denies %s without order:read',
    async (role) => {
      await request(app.getHttpServer())
        .get('/api/commercial/problems')
        .set(authHeaders(role))
        .expect(403);
    },
  );
});

import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { initializeE2eApp } from './e2e-app';

describe('Commercial raw materials (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.AUTH_DEV_XROLE = 'on';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('commercial reads safe raw material projection and cannot adjust stock', async () => {
    const materials = await request(app.getHttpServer())
      .get('/api/commercial/raw-materials')
      .set({ 'x-role': 'commercial' })
      .expect(200);

    expect(Array.isArray(materials.body.items)).toBe(true);
    expect(materials.body).toHaveProperty('nextCursor');
    expect(
      materials.body.nextCursor === null || typeof materials.body.nextCursor === 'string',
    ).toBe(true);
    if (materials.body.items.length > 0) {
      const stockBacked = materials.body.items.find(
        (item: { materialId?: unknown }) => typeof item.materialId === 'string',
      );
      expect(stockBacked).toEqual(
        expect.objectContaining({
          materialId: expect.any(String),
          label: expect.any(String),
          actualQty: expect.any(Number),
          unit: expect.any(String),
        }),
      );
      for (const item of materials.body.items) {
        expect(item.rawPayload).toBeUndefined();
      }
    }

    await request(app.getHttpServer())
      .get('/api/warehouse/raw-materials')
      .set({ 'x-role': 'commercial' })
      .expect(403);

    await request(app.getHttpServer())
      .post('/api/warehouse/raw-materials/rm-pvd-15803/adjustments')
      .set({ 'x-role': 'commercial' })
      .send({ operationKey: randomUUID(), actualQty: 1, reason: 'forbidden' })
      .expect(403);
  });

  it('searches the safe projection by material name and bounds the query', async () => {
    const searched = await request(app.getHttpServer())
      .get('/api/commercial/raw-materials')
      .query({ q: '  ПВД  ', limit: 100 })
      .set({ 'x-role': 'commercial' })
      .expect(200);

    expect(searched.body.items).toEqual(expect.any(Array));
    for (const item of searched.body.items as Array<{ label: string }>) {
      expect(item.label.toLocaleLowerCase('ru-RU')).toContain('пвд');
    }

    await request(app.getHttpServer())
      .get('/api/commercial/raw-materials')
      .query({ q: 'x'.repeat(121) })
      .set({ 'x-role': 'commercial' })
      .expect(400);
  });
});

import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

describe('raw-material stock revision (e2e, real PostgreSQL)', () => {
  const prisma = new PrismaClient();
  const materialId = `e2e-revision-${randomUUID()}`;

  afterAll(async () => {
    await prisma.rawMaterialStock.deleteMany({ where: { materialId } });
    await prisma.$disconnect();
  });

  it('increments for A → B → A but stays stable for a no-op update', async () => {
    const created = await prisma.rawMaterialStock.create({
      data: {
        materialId,
        label: 'E2E revision material',
        actualQty: 1,
        unit: 'кг',
        factStatus: 'warehouse_fact',
      },
    });
    expect(created.revision).toBe(1);

    const changed = await prisma.rawMaterialStock.update({
      where: { materialId },
      data: { actualQty: 2 },
    });
    expect(changed.revision).toBe(2);

    const noOp = await prisma.rawMaterialStock.update({
      where: { materialId },
      data: { actualQty: 2 },
    });
    expect(noOp.revision).toBe(2);

    const metadataOnly = await prisma.rawMaterialStock.update({
      where: { materialId },
      data: { label: 'E2E renamed material' },
    });
    expect(metadataOnly.revision).toBe(2);

    const returned = await prisma.rawMaterialStock.update({
      where: { materialId },
      data: { actualQty: 1 },
    });
    expect(returned.revision).toBe(3);
  });
});

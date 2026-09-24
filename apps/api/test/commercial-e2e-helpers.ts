import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaService } from '../src/common/prisma/prisma.service';

type CommercialOrderForCover = {
  id: string;
  positions: Array<{ id: string; rollCount: number }>;
};

export const PRIMARY_BASE_MATERIAL_SELECTION = {
  baseRawMaterialDefinitionId: 'rmd-base-primary',
} as const;

export const STANDARD_ROLL_DIMENSIONS = {
  widthMm: 1700,
  plannedLengthM: 275,
} as const;

/**
 * Legacy cross-contour e2e flows predate explicit two-step warehouse cover approval.
 * Give each position a real proposal, then select the production-only route through the API.
 */
export async function approveProductionOnlyCover(
  app: INestApplication,
  prisma: PrismaService,
  commercialHeaders: Record<string, string>,
  order: CommercialOrderForCover,
) {
  for (const position of order.positions) {
    const proposal = await prisma.warehouseCoverProposal.create({
      data: {
        orderId: order.id,
        positionId: position.id,
        coverType: 'partial',
        route: 'production_only',
        coverQty: 0,
        reserveQty: 0,
        productionQty: position.rollCount,
        status: 'partial_proposed',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await request(app.getHttpServer())
      .post(
        `/api/commercial/orders/${order.id}/positions/${position.id}/warehouse-cover/${proposal.id}/commercial-approval`,
      )
      .set(commercialHeaders)
      .send({ expectedVersion: proposal.version, route: 'production_only' })
      .expect(201);
  }
}

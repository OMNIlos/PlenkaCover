import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function createOpenApiDocument(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('Плёнки Контур — backend v1')
    .setDescription('Candidate API skeleton. See backend-preliminary-tz-2026-06-26.md.')
    .setVersion('0.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'session')
    .addApiKey({ type: 'apiKey', name: 'x-role', in: 'header' }, 'mock-role')
    .addApiKey({ type: 'apiKey', name: 'x-agent-token', in: 'header' }, 'agent-token')
    .build();

  return SwaggerModule.createDocument(app, config);
}

export function setupOpenApi(app: INestApplication) {
  SwaggerModule.setup('api/docs', app, createOpenApiDocument(app));
}

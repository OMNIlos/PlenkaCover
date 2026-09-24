import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureHttpSecurity } from './common/http-security';
import { RUNTIME_CONFIG } from './common/runtime-config.module';
import type { RuntimeConfig } from './common/runtime-config';
import { OneCFinanceSyncScheduler } from './modules/finance/onec-finance-sync.scheduler';
import { setupOpenApi } from './openapi';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get<RuntimeConfig>(RUNTIME_CONFIG);

  app.enableShutdownHooks();
  app.setGlobalPrefix('api');
  configureHttpSecurity(app, config);
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );

  // OpenAPI skeleton (ТЗ §10 asks for a draft API surface). Served at /api/docs.
  setupOpenApi(app);

  await app.listen(config.port);
  app.get(OneCFinanceSyncScheduler).start();

  console.log(`API listening on port ${config.port} (docs: /api/docs)`);
}

void bootstrap();

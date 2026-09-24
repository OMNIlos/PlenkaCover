import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { loadRuntimeConfig, type RuntimeConfig } from './runtime-config';
import { loadOneCRuntimeOptions, type OneCRuntimeOptions } from './onec-runtime-options';

export const RUNTIME_CONFIG = Symbol('RUNTIME_CONFIG');
export const ONEC_RUNTIME_OPTIONS = Symbol('ONEC_RUNTIME_OPTIONS');
const RUNTIME_SNAPSHOT = Symbol('RUNTIME_SNAPSHOT');

interface RuntimeSnapshot {
  config: Readonly<RuntimeConfig>;
  onec: Readonly<OneCRuntimeOptions>;
}

function createRuntimeSnapshot(): Readonly<RuntimeSnapshot> {
  const env = { ...process.env };
  const config = loadRuntimeConfig(env);
  Object.freeze(config.corsOrigins);
  Object.freeze(config);
  return Object.freeze({ config, onec: loadOneCRuntimeOptions(env, config) });
}

@Global()
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  providers: [
    { provide: RUNTIME_SNAPSHOT, useFactory: createRuntimeSnapshot },
    {
      provide: RUNTIME_CONFIG,
      inject: [RUNTIME_SNAPSHOT],
      useFactory: (snapshot: RuntimeSnapshot) => snapshot.config,
    },
    {
      provide: ONEC_RUNTIME_OPTIONS,
      inject: [RUNTIME_SNAPSHOT],
      useFactory: (snapshot: RuntimeSnapshot) => snapshot.onec,
    },
  ],
  exports: [RUNTIME_CONFIG, ONEC_RUNTIME_OPTIONS],
})
export class RuntimeConfigModule {}

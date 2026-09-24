import { basename } from 'node:path';
import { loadConfig, type AgentConfig } from './config';

type ConfigProjection = Pick<AgentConfig, 'deploymentMode'>;
type ConfigLoader = () => ConfigProjection;
type Writer = (message: string) => unknown;

/** Validates the complete runtime profile while keeping secrets and device identities out of output. */
export function runConfigCheck(
  loader: ConfigLoader = () => loadConfig(),
  output: Writer = (message) => process.stdout.write(message),
  error: Writer = (message) => process.stderr.write(message),
): number {
  try {
    const config = loader();
    output(`gateway configuration valid: ${config.deploymentMode}\n`);
    return 0;
  } catch {
    error('gateway configuration invalid\n');
    return 1;
  }
}

if (require.main === module && basename(process.argv[1] ?? '') === 'check-config.js') {
  process.exitCode = runConfigCheck();
}

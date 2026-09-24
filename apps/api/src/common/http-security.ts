import { isIP } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { RuntimeConfig } from './runtime-config';

function isPrivateIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [first, second] = address.split('.').map(Number);
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isPrivateIpv6(address: string): boolean {
  const withoutZone = address.split('%', 1)[0].toLowerCase();
  if (withoutZone === '::1') return true;
  if (isIP(withoutZone) !== 6) return false;
  const first = Number.parseInt(withoutZone.split(':', 1)[0], 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/**
 * The API has exactly one trusted reverse-proxy hop (Caddy) on a private Compose network.
 * A public direct peer and every farther X-Forwarded-For hop are untrusted, so an attacker
 * cannot prepend an arbitrary address to rotate login-throttle keys.
 */
export function trustOneHopPrivateProxy(address: string, hop: number): boolean {
  if (hop !== 0) return false;
  const mappedIpv4 = address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : address;
  return isPrivateIpv4(mappedIpv4) || isPrivateIpv6(address);
}

export function configureHttpSecurity(
  app: Pick<NestExpressApplication, 'disable' | 'enableCors' | 'set'>,
  config: RuntimeConfig,
): void {
  app.disable('x-powered-by');
  app.set('trust proxy', trustOneHopPrivateProxy);
  if (config.corsOrigins.length > 0) {
    app.enableCors({ credentials: true, origin: config.corsOrigins });
  }
}

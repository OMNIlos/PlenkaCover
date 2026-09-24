import { SetMetadata } from '@nestjs/common';
import type { Capability } from '@plenka/contracts';

export const REQUIRE_CAPABILITIES = 'require_capabilities';

/**
 * Declare the capabilities a route requires. The CapabilityGuard enforces that
 * the current actor holds ALL of them (ТЗ §4 capability-based access).
 *
 *   @RequireCapabilities('order:create')
 *   @Post()
 *   create() { ... }
 */
export const RequireCapabilities = (...capabilities: Capability[]) =>
  SetMetadata(REQUIRE_CAPABILITIES, capabilities);

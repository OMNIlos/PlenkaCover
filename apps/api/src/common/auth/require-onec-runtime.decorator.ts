import { SetMetadata } from '@nestjs/common';

export const REQUIRE_ONEC_RUNTIME = 'require_onec_runtime';

/** Marks routes that must not exist while the external 1C integration is disabled. */
export const RequireOneCRuntime = () => SetMetadata(REQUIRE_ONEC_RUNTIME, true);

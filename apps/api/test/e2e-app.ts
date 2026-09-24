import type { INestApplication } from '@nestjs/common';

/**
 * Keep one loopback listener for the lifetime of an e2e app.
 *
 * Passing an unbound Server to Supertest makes each request own a temporary `listen(0)` and close
 * it afterwards. Parallel Jest processes can then race through recycled ephemeral ports and send a
 * request to the wrong test server. A suite-owned listener removes that cross-process boundary;
 * `app.close()` in afterAll remains the single shutdown owner.
 */
export async function initializeE2eApp(app: INestApplication): Promise<void> {
  await app.init();
  await app.listen(0, '127.0.0.1');
}

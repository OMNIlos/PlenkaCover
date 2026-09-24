import { GatewayApiClient, GatewayApiError } from './api-client';
import {
  GATEWAY_CAPABILITIES,
  GATEWAY_PROTOCOL_VERSION,
  type GatewayHeartbeatV2,
} from '@plenka/contracts';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GatewayApiClient — leased result protocol', () => {
  it('sends the V2 heartbeat body and returns the typed compatibility acknowledgement', async () => {
    const heartbeat: GatewayHeartbeatV2 = {
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      agent: {
        packageVersion: '1:0.0.1+git788.1785844317.1b5005b4660f',
        releaseCommit: '1b5005b4660f5997c956b718958e5ee3a3516d94',
        bootId: '7f620c8e-2bbf-4ef8-9e91-b094611229c7',
        startedAt: '2026-08-04T12:45:00.000Z',
        capabilities: GATEWAY_CAPABILITIES,
      },
      devices: [],
    };
    const acknowledgement = {
      accepted: true,
      compatibility: 'compatible',
      serverProtocolVersion: GATEWAY_PROTOCOL_VERSION,
      minimumProtocolVersion: GATEWAY_PROTOCOL_VERSION,
      pollAllowed: true,
      missingCapabilities: [],
      serverTime: '2026-08-04T12:46:00.000Z',
    } as const;
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => acknowledgement,
    } as Response);
    const client = new GatewayApiClient('https://platform.example/api', 'post-secret');

    await expect(client.heartbeat(heartbeat)).resolves.toEqual(acknowledgement);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://platform.example/api/gateway/heartbeat',
      expect.objectContaining({
        body: JSON.stringify(heartbeat),
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).not.toHaveProperty('agentToken');
  });

  it.each([401, 403])('keeps a durable result retryable across HTTP %i auth failures', (status) => {
    expect(new GatewayApiError(status, 'POST', '/result').terminalResultRejection).toBe(false);
  });

  it.each([404, 409, 422])('classifies stable HTTP %i result decisions as terminal', (status) => {
    expect(new GatewayApiError(status, 'POST', '/result').terminalResultRejection).toBe(true);
  });

  it('posts the original lease token with the durable result', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as Response);
    const client = new GatewayApiClient('https://platform.example/api', 'post-secret');

    await client.postResult('cmd-1', 'lease-1', { ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://platform.example/api/gateway/commands/cmd-1/result',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-agent-token': 'post-secret' }),
        body: JSON.stringify({ leaseToken: 'lease-1', result: { ok: true } }),
      }),
    );
  });

  it('exposes only HTTP metadata for a terminal stale-lease rejection', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      text: async () => 'sensitive server body',
    } as Response);
    const client = new GatewayApiClient('https://platform.example/api', 'post-secret');

    const error = await client
      .postResult('cmd-1', 'lease-stale', { ok: true })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayApiError);
    expect(error).toMatchObject({ status: 409, terminalResultRejection: true });
    expect(String(error)).not.toContain('sensitive server body');
    expect(String(error)).not.toContain('post-secret');
  });
});

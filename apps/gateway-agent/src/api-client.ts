import type { GatewayHeartbeatAckV2, GatewayHeartbeatV2 } from '@plenka/contracts';

/** A command polled from the platform (server-side model: GatewayCommand). */
export interface GatewayCommandMsg {
  id: string;
  leaseToken: string;
  deadlineAt: string;
  serverTime: string;
  executionBudgetMs: number;
  protocolVersion?: number;
  kind: string;
  payload?: unknown;
}

export class GatewayApiError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string,
  ) {
    super(`gateway API ${method} ${path} -> HTTP ${status}`);
    this.name = 'GatewayApiError';
  }

  get terminalResultRejection(): boolean {
    return [400, 404, 409, 410, 422].includes(this.status);
  }
}

export interface IngestEventBody {
  eventId: string;
  kind: 'weight' | 'scan' | 'status' | 'heartbeat';
  payload?: Record<string, unknown>;
  rawPayload?: unknown;
}

/**
 * HTTP client for the agent-facing gateway routes. All calls are OUTBOUND from the post
 * to the platform (no inbound port on the post), authenticated with the per-post
 * `x-agent-token`. Any network/HTTP failure throws — callers decide between retry
 * (ingest via offline buffer) and drop (a stale command result is useless anyway).
 */
export class GatewayApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 5000,
  ) {}

  heartbeat(heartbeat: GatewayHeartbeatV2): Promise<GatewayHeartbeatAckV2> {
    return this.request('POST', '/gateway/heartbeat', heartbeat) as Promise<GatewayHeartbeatAckV2>;
  }

  pollCommands(): Promise<GatewayCommandMsg[]> {
    return this.request('GET', '/gateway/commands') as Promise<GatewayCommandMsg[]>;
  }

  postResult(
    commandId: string,
    leaseToken: string,
    result: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request('POST', `/gateway/commands/${encodeURIComponent(commandId)}/result`, {
      leaseToken,
      result,
    });
  }

  ingest(event: IngestEventBody): Promise<unknown> {
    return this.request('POST', '/gateway/ingest', event);
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'x-agent-token': this.token,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new GatewayApiError(res.status, method, path);
    }
    return res.status === 204 ? undefined : res.json();
  }
}

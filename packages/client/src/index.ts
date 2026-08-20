/**
 * Typed client for the toren intake API. Zero dependencies — global fetch.
 * Response shapes mirror packages/cli/src/api.ts (the server is the source
 * of truth; the api tests exercise both sides against each other).
 */

export interface RunSummary { runId: string; agent: string; status: string; createdAt: string }
export interface WaveSummary { name: string; tasks: number; settled: number; done: boolean }
export interface PendingApproval { runId: string; taskId: string; stepId: string; tool: string; args: unknown }
export interface RunDetail {
  run: { runId: string; agent: string; status: string; input: unknown; output: unknown; error: unknown };
  /** Run status with parking surfaced: "waiting_approval" when a human is needed. */
  status: string;
  waves: WaveSummary[];
  approvals: PendingApproval[];
}
export interface RunEvents {
  run: { seq: number; type: string; payload: Record<string, unknown> }[];
  tasks: Record<string, { seq: number; type: string; payload: Record<string, unknown> }[]>;
}

export class TorenApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "TorenApiError";
  }
}

export interface TorenClientConfig {
  url: string;
  token: string;
  fetch?: typeof fetch;
}

export class TorenClient {
  private base: string;
  private fetchImpl: typeof fetch;

  constructor(private cfg: TorenClientConfig) {
    this.base = cfg.url.replace(/\/+$/, "");
    this.fetchImpl = cfg.fetch ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.cfg.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new TorenApiError(res.status, String(json.error ?? `HTTP ${res.status}`));
    return json as T;
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.base}/healthz`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async startRun(req: { input: string }): Promise<{ runId: string }> {
    return this.request("POST", "/runs", req);
  }

  async listRuns(): Promise<RunSummary[]> {
    const r = await this.request<{ runs: RunSummary[] }>("GET", "/runs");
    return r.runs;
  }

  async getRun(runId: string): Promise<RunDetail> {
    return this.request("GET", `/runs/${encodeURIComponent(runId)}`);
  }

  async getEvents(runId: string): Promise<RunEvents> {
    return this.request("GET", `/runs/${encodeURIComponent(runId)}/events`);
  }

  async approve(runId: string, req: { taskId: string; stepId: string; granted: boolean; comment?: string }): Promise<void> {
    await this.request("POST", `/runs/${encodeURIComponent(runId)}/approvals`, req);
  }

  /**
   * Poll until the run is terminal (completed/failed) or parked waiting for
   * an approval — the remote equivalent of the CLI's drive loop.
   */
  async waitForRun(runId: string, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<RunDetail> {
    const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
    const poll = opts.pollMs ?? 300;
    for (;;) {
      const detail = await this.getRun(runId);
      if (detail.status === "completed" || detail.status === "failed" || detail.status === "waiting_approval") {
        return detail;
      }
      if (Date.now() > deadline) throw new TorenApiError(408, `run ${runId} did not settle within ${opts.timeoutMs ?? 120_000}ms`);
      await new Promise((r) => setTimeout(r, poll));
    }
  }
}

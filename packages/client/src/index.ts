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
export interface SessionTurn { role: "user" | "assistant"; text: string; channel?: string; seq: number }
export interface SessionDetail { runId: string; agent: string; state: string; transcript: SessionTurn[] }

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export class TorenApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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

  async startRun(req: { input: string; agent?: string; process?: string; files?: string[] }): Promise<{ runId: string }> {
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

  /** Retire a run: retries stop and queued work for it becomes a no-op. */
  async cancelRun(runId: string): Promise<void> {
    await this.request("POST", `/runs/${encodeURIComponent(runId)}/cancel`);
  }

  async approve(runId: string, req: { taskId: string; stepId: string; granted: boolean; comment?: string }): Promise<void> {
    await this.request("POST", `/runs/${encodeURIComponent(runId)}/approvals`, req);
  }

  /** Upload a file for attachment; data is raw bytes or an already-base64 string. */
  async uploadFile(req: { name: string; data: Uint8Array | string }): Promise<{ fileId: string; name: string; mediaType: string; bytes: number; pages: number }> {
    const content_base64 = typeof req.data === "string" ? req.data : bytesToBase64(req.data);
    return this.request("POST", "/files", { name: req.name, content_base64 });
  }

  async startSession(req: { message: string; agent?: string; channel?: string; files?: string[] }): Promise<{ runId: string; agent: string }> {
    return this.request("POST", "/sessions", req);
  }

  async listSessions(): Promise<RunSummary[]> {
    const r = await this.request<{ sessions: RunSummary[] }>("GET", "/sessions");
    return r.sessions;
  }

  async getSession(runId: string): Promise<SessionDetail> {
    return this.request("GET", `/sessions/${encodeURIComponent(runId)}`);
  }

  /** Send the next turn. Throws TorenApiError(409) while the agent is mid-turn. */
  async sendSessionMessage(runId: string, req: { message: string; channel?: string; close?: boolean; files?: string[] }): Promise<void> {
    await this.request("POST", `/sessions/${encodeURIComponent(runId)}/messages`, req);
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

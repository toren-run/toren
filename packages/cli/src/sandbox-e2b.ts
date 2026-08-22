import type pg from "pg";
import type { SandboxExec, SandboxProvider } from "@toren-run/core";

/**
 * E2B sandbox backend: the cloud tier. Each run gets an E2B Firecracker
 * microVM; its id is recorded in toren_control.sandboxes, so a worker that
 * dies mid-run is replaced by one that reconnects to the SAME sandbox by id
 * (Sandbox.connect) rather than spawning a second, divergent one. Pause
 * preserves the workspace at rest; the disk is E2B's guarantee, referenced
 * durably by us. This retires the hand-rolled Fargate snapshot machinery.
 */

const WORKDIR = "/home/user";

export interface E2BConfig {
  apiKey: string;
  template?: string;
  network?: boolean;
  env?: Record<string, string>;
  /** Sandbox lifetime before E2B reaps an untouched sandbox. */
  timeoutMs?: number;
}

/** Confine a user path under the workspace, rejecting escapes (intent guard). */
function workspacePath(path: string): string {
  if (path.startsWith("/")) throw new Error(`path must be workspace-relative: ${path}`);
  const parts: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (parts.length === 0) throw new Error(`path escapes the workspace: ${path}`); parts.pop(); continue; }
    parts.push(seg);
  }
  return `${WORKDIR}/${parts.join("/")}`;
}

export class E2BSandboxProvider implements SandboxProvider {
  constructor(private pool: pg.Pool, private cfg: E2BConfig) {}
  forRun(runId: string): SandboxExec {
    return new E2BSandbox(this.pool, runId, this.cfg);
  }
}

// The e2b SDK's Sandbox surface we use; imported dynamically to keep the dep lazy.
type E2BSandboxHandle = {
  sandboxId: string;
  isRunning(): Promise<boolean>;
  commands: { run(cmd: string, opts?: { timeoutMs?: number; cwd?: string }): Promise<{ stdout: string; stderr: string; exitCode: number }> };
  files: { read(path: string): Promise<string>; write(path: string, data: string): Promise<unknown> };
  pause(): Promise<unknown>;
  kill(): Promise<unknown>;
};

class E2BSandbox implements SandboxExec {
  private handle: E2BSandboxHandle | null = null;
  constructor(private pool: pg.Pool, private runId: string, private cfg: E2BConfig) {}

  private async sdk(): Promise<{ Sandbox: {
    create(opts: Record<string, unknown>): Promise<E2BSandboxHandle>;
    connect(id: string, opts: Record<string, unknown>): Promise<E2BSandboxHandle>;
  } }> {
    return (await import("e2b")) as unknown as Awaited<ReturnType<E2BSandbox["sdk"]>>;
  }

  /** Reconnect to this run's recorded sandbox, or create and record a fresh one. */
  private async ensure(): Promise<E2BSandboxHandle> {
    if (this.handle && (await this.handle.isRunning().catch(() => false))) return this.handle;
    const { Sandbox } = await this.sdk();
    const opts = { apiKey: this.cfg.apiKey };

    const { rows } = await this.pool.query<{ sandbox_id: string }>(
      "SELECT sandbox_id FROM toren_control.sandboxes WHERE run_id = $1",
      [this.runId],
    );
    if (rows[0]) {
      try {
        this.handle = await Sandbox.connect(rows[0].sandbox_id, opts);
        await this.pool.query("UPDATE toren_control.sandboxes SET last_used_at = now() WHERE run_id = $1", [this.runId]);
        return this.handle;
      } catch {
        // The recorded sandbox is gone (expired/killed). Fall through and make a new one.
      }
    }

    this.handle = await Sandbox.create({
      apiKey: this.cfg.apiKey,
      ...(this.cfg.template ? { template: this.cfg.template } : {}),
      ...(this.cfg.env ? { envs: this.cfg.env } : {}),
      timeoutMs: this.cfg.timeoutMs ?? 300_000,
    });
    await this.pool.query(
      `INSERT INTO toren_control.sandboxes (run_id, provider, sandbox_id) VALUES ($1, 'e2b', $2)
       ON CONFLICT (run_id) DO UPDATE SET sandbox_id = $2, last_used_at = now()`,
      [this.runId, this.handle.sandboxId],
    );
    return this.handle;
  }

  async exec(command: string, opts?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const s = await this.ensure();
    try {
      const r = await s.commands.run(command, { cwd: WORKDIR, timeoutMs: opts?.timeoutMs ?? 120_000 });
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    } catch (e) {
      // A non-zero exit throws in the SDK; surface it as a normal result.
      const err = e as { exitCode?: number; stdout?: string; stderr?: string; message?: string };
      if (typeof err.exitCode === "number") return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.exitCode };
      throw e;
    }
  }

  async readFile(path: string): Promise<string> {
    const s = await this.ensure();
    return s.files.read(workspacePath(path));
  }

  async writeFile(path: string, content: string): Promise<void> {
    const s = await this.ensure();
    await s.files.write(workspacePath(path), content);
  }

  async pause(): Promise<void> {
    if (this.handle) await this.handle.pause().catch(() => { /* already paused/gone */ });
  }

  async dispose(): Promise<void> {
    if (this.handle) await this.handle.kill().catch(() => { /* already gone */ });
    await this.pool.query("DELETE FROM toren_control.sandboxes WHERE run_id = $1", [this.runId]);
  }
}

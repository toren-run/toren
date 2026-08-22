import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import type { SandboxExec, SandboxProvider } from "@toren-run/core";

/**
 * Local sandbox backend: one docker container per run, holding a persistent
 * workspace bind-mounted from the host. The container gets no credentials
 * beyond what agent.yaml's sandbox.env explicitly grants, and no network
 * unless sandbox.network says so. The workspace directory outlives worker
 * crashes (it is host disk), so local resume needs no restore step; recorded
 * bash outputs replay from the event log and never touch the container.
 */

const run = promisify(execFile);

export const DEFAULT_SANDBOX_IMAGE = "node:22-slim";

export interface SandboxConfig {
  image?: string;
  network?: boolean;
  /** Resolved env values explicitly granted to the sandbox (never the runtime's own keys). */
  env?: Record<string, string>;
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    await run("docker", ["version", "--format", "{{.Server.Version}}"]);
    return true;
  } catch {
    return false;
  }
}

export class DockerSandboxProvider implements SandboxProvider {
  constructor(
    private cfg: SandboxConfig = {},
    private root = process.env.TOREN_SANDBOX_ROOT ?? join(homedir(), ".toren", "sandboxes"),
  ) {}
  forRun(runId: string): SandboxExec {
    return new DockerSandbox(runId, this.cfg, this.root);
  }
}

class DockerSandbox implements SandboxExec {
  private readonly name: string;
  private ready = false;
  constructor(private runId: string, private cfg: SandboxConfig, private root: string) {
    this.name = `toren-sbx-${runId}`;
  }

  workspaceDir(): string {
    return join(this.root, this.runId);
  }

  private async ensure(): Promise<void> {
    if (this.ready) return;
    const ws = this.workspaceDir();
    mkdirSync(ws, { recursive: true });
    try {
      const { stdout } = await run("docker", ["inspect", "-f", "{{.State.Running}}", this.name]);
      if (stdout.trim() === "true") {
        this.ready = true;
        return;
      }
      await run("docker", ["rm", "-f", this.name]).catch(() => { /* replaced below */ });
    } catch { /* no container yet */ }
    await run("docker", [
      "run", "-d", "--name", this.name, "--label", "toren-sandbox=1",
      "-v", `${ws}:/workspace`, "-w", "/workspace",
      ...(this.cfg.network ? [] : ["--network", "none"]),
      ...Object.entries(this.cfg.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      // Blast-radius controls: bounded memory/cpu/pids, no capabilities (bash
      // and dev tooling need none), and no privilege escalation via setuid.
      "--memory", "1g", "--cpus", "2", "--pids-limit", "512",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      this.cfg.image ?? DEFAULT_SANDBOX_IMAGE,
      "sleep", "infinity",
    ]);
    this.ready = true;
  }

  async exec(command: string, opts?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    await this.ensure();
    const seconds = Math.max(1, Math.ceil((opts?.timeoutMs ?? 120_000) / 1000));
    return await new Promise((resolve) => {
      // `timeout` runs inside the container, so a hung command dies in there,
      // not just on our side. Exit 124 marks a timeout, per coreutils.
      execFile(
        "docker", ["exec", this.name, "timeout", String(seconds), "bash", "-lc", command],
        { maxBuffer: 32 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number"
            ? ((err as unknown as { code: number }).code)
            : err ? 1 : 0;
          const timedOut = code === 124 ? "\n[command timed out]" : "";
          resolve({ stdout: String(stdout), stderr: String(stderr) + timedOut, exitCode: code });
        },
      );
    });
  }

  /**
   * Maps a user path to an absolute path under /workspace INSIDE the container,
   * rejecting escapes. File I/O runs in the container (below), not the worker,
   * so the container is the real boundary: a symlink here resolves in the
   * sandbox's own secret-free namespace, never the worker's. The lexical check
   * only confines intent to the workspace.
   */
  private containerPath(path: string): string {
    if (path.startsWith("/")) throw new Error(`path must be workspace-relative: ${path}`);
    const full = posix.join("/workspace", path);
    if (full !== "/workspace" && !full.startsWith("/workspace/")) throw new Error(`path escapes the workspace: ${path}`);
    return full;
  }

  async readFile(path: string): Promise<string> {
    await this.ensure();
    const cp = this.containerPath(path);
    // `cat` runs as the container user against the container fs; a symlink is
    // followed inside the sandbox, so it can only reach the sandbox's files.
    const { stdout } = await run("docker", ["exec", this.name, "cat", "--", cp], { maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.ensure();
    const cp = this.containerPath(path);
    await run("docker", ["exec", this.name, "mkdir", "-p", "--", posix.dirname(cp)]);
    await new Promise<void>((resolveP, reject) => {
      // The path is an argv positional ($1), never interpolated into the
      // script, so it cannot break out of the redirect. The write lands in the
      // container fs; following a symlink out of /workspace stays in the
      // sandbox, which holds nothing worth stealing.
      const child = execFile(
        "docker", ["exec", "-i", this.name, "sh", "-c", 'cat > "$1"', "sh", cp],
        (err) => (err ? reject(err) : resolveP()),
      );
      child.stdin?.end(content, "utf8");
    });
  }

  /** Best-effort teardown; the workspace directory is deliberately left behind. */
  async dispose(): Promise<void> {
    await run("docker", ["rm", "-f", this.name]).catch(() => { /* already gone */ });
  }
}

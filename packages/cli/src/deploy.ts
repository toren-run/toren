import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CmdIO } from "./commands.js";

const stdoutIO: CmdIO = { out: (l) => console.log(l) };

export interface DeployOpts {
  region: string;
  planOnly?: boolean;
  yes?: boolean;
  image?: string;
  agentDir?: string;
  anthropicApiKey?: string;
  /** Directory containing the terraform module (default: repo's infra/terraform-aws). */
  moduleDir?: string;
}

function findModuleDir(explicit?: string): string {
  if (explicit) return resolve(explicit);
  // Walk up from cwd looking for infra/terraform-aws (works inside the repo).
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, "infra/terraform-aws");
    if (existsSync(candidate)) return candidate;
    dir = resolve(dir, "..");
  }
  throw new Error("could not locate infra/terraform-aws — pass --module-dir");
}

function tfBinary(): string {
  for (const bin of ["terraform", "tofu"]) {
    try {
      execSync(`${bin} -version`, { stdio: "ignore" });
      return bin;
    } catch { /* try next */ }
  }
  throw new Error("neither terraform nor tofu found on PATH");
}

/**
 * `toren deploy aws` — one apply into the user's account.
 * Refuses to apply without --yes; --plan-only never mutates anything.
 */
export async function cmdDeployAws(opts: DeployOpts, io: CmdIO = stdoutIO): Promise<void> {
  const moduleDir = findModuleDir(opts.moduleDir);
  const tf = tfBinary();

  const varArgs = [
    "-var", `region=${opts.region}`,
    ...(opts.image ? ["-var", `image=${opts.image}`] : []),
    ...(opts.agentDir ? ["-var", `agent_dir=${opts.agentDir}`] : []),
    ...(opts.anthropicApiKey ? ["-var", `anthropic_api_key=${opts.anthropicApiKey}`] : []),
  ];

  io.out(`using ${tf} with module ${moduleDir}`);
  execFileSync(tf, ["init", "-input=false"], { cwd: moduleDir, stdio: "inherit" });

  if (opts.planOnly) {
    execFileSync(tf, ["plan", "-input=false", ...varArgs], { cwd: moduleDir, stdio: "inherit" });
    io.out("plan complete — nothing was created (--plan-only)");
    return;
  }
  if (!opts.yes) {
    throw new Error("refusing to apply without --yes (this creates billable AWS resources); use --plan-only to preview");
  }
  execFileSync(tf, ["apply", "-input=false", "-auto-approve", ...varArgs], { cwd: moduleDir, stdio: "inherit" });
  execFileSync(tf, ["output", "worker_env"], { cwd: moduleDir, stdio: "inherit" });
  io.out("deployed. Push your image to the ECR repo above (docker build/tag/push), then the service will pull :latest.");
}

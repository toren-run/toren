import { createRequire } from "node:module";
import { Command } from "commander";
import { resolveEnvProfile } from "./environments.js";
import { remoteJobsApprove, remoteJobsList, remoteJobsShow, remoteRun } from "./remote.js";
import {
  cmdDev, cmdInit, cmdJobsApprove, cmdJobsList, cmdJobsShow, cmdKeysCreate, cmdKeysList, cmdKeysRevoke,
  cmdRun, cmdScheduleCreate, cmdScheduleList, cmdScheduleSet,
} from "./commands.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export async function main(argv: string[]): Promise<void> {
  const program = new Command();
  program.name("toren").description("Durable agents in your own cloud").version(version);

  program.command("init <name>").description("Scaffold a filesystem-first agent").action(async (name: string) => {
    await cmdInit(name);
  });

  program.command("run <dir>")
    .description("Run an agent directory to completion (or until it parks on an approval)")
    .requiredOption("--input <input>", "run input (string)")
    .option("--json", "JSON output")
    .option("--detach", "start the run and exit without driving it (workers pick it up)")
    .option("--env <name>", "environment profile from .toren/environments.json", "local")
    .action(async (dir: string, opts: { input: string; json?: boolean; detach?: boolean; env?: string }) => {
      const profile = resolveEnvProfile(opts.env, dir);
      if (profile.kind === "api") {
        await remoteRun(profile, opts, { out: (l) => console.log(l) });
        return;
      }
      const settled = await cmdRun(dir, { ...opts, databaseUrl: profile.databaseUrl });
      if (settled.status === "failed") process.exitCode = 1;
    });

  program.command("dev")
    .description("Serve a fleet of process agents: workers + guardians for every agent in every --dir (HTTP API + console when TOREN_API_TOKEN is set)")
    .option("--dir <dir>", "agent directory, or a folder of agent directories (repeatable)", (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option("--api-port <port>", "HTTP API port (default 7433; requires TOREN_API_TOKEN)", (v) => parseInt(v, 10))
    .action(async (opts: { dir: string[]; apiPort?: number }) => cmdDev(opts.dir.length > 0 ? opts.dir : ["."], { apiPort: opts.apiPort }));

  program.command("deploy-aws")
    .description("Deploy toren into your AWS account via Terraform")
    .requiredOption("--region <region>", "AWS region")
    .option("--plan-only", "show the plan without creating anything")
    .option("--yes", "actually apply (creates billable resources)")
    .option("--image <uri>", "container image URI (default: module ECR repo :latest)")
    .option("--agent-dir <dir>", "agent directory inside the image")
    .option("--module-dir <dir>", "terraform module directory")
    .option("--profile <name>", "AWS shared-config profile")
    .option("--state-bucket <name>", "S3 bucket for remote terraform state (created if missing: versioned, public access blocked)")
    .option("--state-key <key>", "state object key", "toren/terraform.tfstate")
    .option("--image-context <dir>", "build the agent image from this directory (linux/arm64), push to the stack's ECR, deploy with the tag pinned")
    .action(async (opts: { region: string; planOnly?: boolean; yes?: boolean; image?: string; agentDir?: string; moduleDir?: string; profile?: string; stateBucket?: string; stateKey?: string; imageContext?: string }) => {
      const { cmdDeployAws } = await import("./deploy.js");
      await cmdDeployAws({ ...opts, anthropicApiKey: process.env.ANTHROPIC_API_KEY, openaiApiKey: process.env.OPENAI_API_KEY });
    });

  const io = { out: (l: string) => console.log(l) };
  const jobs = program.command("jobs").description("Inspect and control runs");
  jobs.command("list").option("--dir <dir>", "agent directory", ".").option("--json")
    .option("--env <name>", "environment profile", "local")
    .action(async (opts: { dir: string; json?: boolean; env?: string }) => {
      const profile = resolveEnvProfile(opts.env, opts.dir);
      if (profile.kind === "api") return remoteJobsList(profile, opts, io);
      return cmdJobsList(opts.dir, { ...opts, databaseUrl: profile.databaseUrl });
    });
  jobs.command("show <runId>").option("--dir <dir>", "agent directory", ".").option("--json")
    .option("--env <name>", "environment profile", "local")
    .action(async (runId: string, opts: { dir: string; json?: boolean; env?: string }) => {
      const profile = resolveEnvProfile(opts.env, opts.dir);
      if (profile.kind === "api") return remoteJobsShow(profile, runId, opts, io);
      return cmdJobsShow(opts.dir, runId, { ...opts, databaseUrl: profile.databaseUrl });
    });
  jobs.command("approve <runId> <taskId> <stepId>")
    .option("--dir <dir>", "agent directory", ".")
    .option("--deny", "deny instead of approve")
    .option("--comment <text>", "comment for the agent")
    .option("--json")
    .option("--env <name>", "environment profile", "local")
    .action(async (runId: string, taskId: string, stepId: string, opts: { dir: string; deny?: boolean; comment?: string; json?: boolean; env?: string }) => {
      const profile = resolveEnvProfile(opts.env, opts.dir);
      if (profile.kind === "api") return remoteJobsApprove(profile, runId, taskId, stepId, opts, io);
      void (await cmdJobsApprove(opts.dir, runId, taskId, stepId, { ...opts, databaseUrl: profile.databaseUrl }));
    });

  const keys = program.command("keys").description("Issue and revoke API keys for this deployment");
  keys.command("create <name>").option("--dir <dir>", "agent directory", ".")
    .option("--env <name>", "environment profile", "local")
    .action(async (name: string, opts: { dir: string; env?: string }) => {
      const profile = resolveEnvProfile(opts.env, opts.dir);
      if (profile.kind === "api") throw new Error("key management runs against the database — use a db-backed environment profile");
      return cmdKeysCreate(opts.dir, name, { databaseUrl: profile.databaseUrl });
    });
  keys.command("list").option("--dir <dir>", "agent directory", ".").option("--json")
    .option("--env <name>", "environment profile", "local")
    .action(async (opts: { dir: string; json?: boolean; env?: string }) => {
      const profile = resolveEnvProfile(opts.env, opts.dir);
      if (profile.kind === "api") throw new Error("key management runs against the database — use a db-backed environment profile");
      return cmdKeysList(opts.dir, { ...opts, databaseUrl: profile.databaseUrl });
    });
  keys.command("revoke <id>").option("--dir <dir>", "agent directory", ".")
    .option("--env <name>", "environment profile", "local")
    .action(async (id: string, opts: { dir: string; env?: string }) => {
      const profile = resolveEnvProfile(opts.env, opts.dir);
      if (profile.kind === "api") throw new Error("key management runs against the database — use a db-backed environment profile");
      return cmdKeysRevoke(opts.dir, id, { databaseUrl: profile.databaseUrl });
    });

  const schedule = program.command("schedule").description("Cron-triggered runs — fired by the workers, exactly once, crash-safe");
  schedule.command("create")
    .requiredOption("--cron <expr>", 'cron expression, e.g. "0 9 * * *"')
    .requiredOption("--input <input>", "run input (string)")
    .option("--agent <name>", "agent to run (default: the --dir agent)")
    .option("--name <name>", "display name")
    .option("--tz <zone>", "IANA timezone for the cron expression", "UTC")
    .option("--dir <dir>", "agent directory", ".")
    .option("--env <name>", "environment profile", "local")
    .action(async (opts: { cron: string; input: string; agent?: string; name?: string; tz?: string; dir: string; env?: string }) => {
      const profile = resolveEnvProfile(opts.env, opts.dir);
      if (profile.kind === "api") throw new Error("schedule management runs against the database — use a db-backed environment profile");
      return cmdScheduleCreate(opts.dir, { ...opts, databaseUrl: profile.databaseUrl });
    });
  schedule.command("list").option("--dir <dir>", "agent directory", ".").option("--json")
    .option("--env <name>", "environment profile", "local")
    .action(async (opts: { dir: string; json?: boolean; env?: string }) => {
      const profile = resolveEnvProfile(opts.env, opts.dir);
      if (profile.kind === "api") throw new Error("schedule management runs against the database — use a db-backed environment profile");
      return cmdScheduleList(opts.dir, { ...opts, databaseUrl: profile.databaseUrl });
    });
  for (const action of ["pause", "resume", "rm"] as const) {
    schedule.command(`${action} <id>`).option("--dir <dir>", "agent directory", ".")
      .option("--env <name>", "environment profile", "local")
      .action(async (id: string, opts: { dir: string; env?: string }) => {
        const profile = resolveEnvProfile(opts.env, opts.dir);
        if (profile.kind === "api") throw new Error("schedule management runs against the database — use a db-backed environment profile");
        return cmdScheduleSet(opts.dir, id, action, { databaseUrl: profile.databaseUrl });
      });
  }

  await program.parseAsync(argv);
}

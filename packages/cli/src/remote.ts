import { TorenClient } from "@toren/client";
import type { CmdIO } from "./commands.js";
import type { ResolvedEnv } from "./environments.js";

/** API-mode command implementations — used when --env targets a deployment. */

function clientFor(env: Extract<ResolvedEnv, { kind: "api" }>, io: CmdIO): TorenClient {
  io.out(`→ env: ${env.name} (${env.url})`);
  return new TorenClient({ url: env.url, token: env.token });
}

export async function remoteRun(
  env: Extract<ResolvedEnv, { kind: "api" }>,
  opts: { input: string; json?: boolean; detach?: boolean },
  io: CmdIO,
): Promise<void> {
  const client = clientFor(env, io);
  const { runId } = await client.startRun({ input: opts.input });
  if (opts.detach) {
    io.out(opts.json ? JSON.stringify({ runId, status: "detached" }) : `run ${runId}  detached — check: toren jobs show ${runId} --env ${env.name}`);
    return;
  }
  io.out(`run ${runId}  started`);
  const detail = await client.waitForRun(runId, { timeoutMs: 300_000 });
  if (opts.json) {
    io.out(JSON.stringify({ runId, status: detail.status, output: detail.run.output, approvals: detail.approvals }));
    return;
  }
  if (detail.status === "completed") {
    io.out(`run ${runId}  completed`);
    io.out(String(detail.run.output ?? ""));
  } else if (detail.status === "failed") {
    io.out(`run ${runId}  FAILED: ${String(detail.run.error ?? "")}`);
  } else {
    io.out(`run ${runId}  waiting for approval:`);
    for (const a of detail.approvals) {
      io.out(`  toren jobs approve ${a.runId} ${a.taskId} ${a.stepId} --env ${env.name}   # ${a.tool} ${JSON.stringify(a.args)}`);
    }
  }
}

export async function remoteJobsList(env: Extract<ResolvedEnv, { kind: "api" }>, opts: { json?: boolean }, io: CmdIO): Promise<void> {
  const client = clientFor(env, io);
  const runs = await client.listRuns();
  if (opts.json) return void io.out(JSON.stringify({ runs }));
  for (const r of runs) io.out(`${r.runId}  ${r.agent}  ${r.status}`);
}

export async function remoteJobsShow(env: Extract<ResolvedEnv, { kind: "api" }>, runId: string, opts: { json?: boolean }, io: CmdIO): Promise<void> {
  const client = clientFor(env, io);
  const d = await client.getRun(runId);
  if (opts.json) return void io.out(JSON.stringify(d));
  io.out(`${d.run.runId}  ${d.run.agent}  ${d.status}`);
  for (const w of d.waves) io.out(`  wave ${w.name}: ${w.settled}/${w.tasks} settled${w.done ? " ✓" : ""}`);
  for (const a of d.approvals) io.out(`  pending approval: ${a.tool} ${JSON.stringify(a.args)}  → toren jobs approve ${a.runId} ${a.taskId} ${a.stepId} --env ${env.name}`);
  if (d.status === "completed") io.out(`  output: ${String(d.run.output ?? "")}`);
}

export async function remoteJobsApprove(
  env: Extract<ResolvedEnv, { kind: "api" }>,
  runId: string, taskId: string, stepId: string,
  opts: { deny?: boolean; comment?: string; json?: boolean },
  io: CmdIO,
): Promise<void> {
  const client = clientFor(env, io);
  await client.approve(runId, { taskId, stepId, granted: !opts.deny, comment: opts.comment });
  const detail = await client.waitForRun(runId, { timeoutMs: 300_000 });
  if (opts.json) return void io.out(JSON.stringify({ runId, status: detail.status, output: detail.run.output }));
  io.out(detail.status === "completed" ? `run ${runId}  completed\n${String(detail.run.output ?? "")}` : `run ${runId}  ${detail.status}`);
}

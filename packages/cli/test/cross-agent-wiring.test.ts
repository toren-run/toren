import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { loadProject } from "../src/loader.js";
import { buildFleetRuntime, type FleetRuntime } from "../src/runtime.js";

let rt: FleetRuntime | undefined;
afterAll(async () => { await rt?.close(); });

test("consent wiring through the real loader and fleet runtime", async () => {
  const base = mkdtempSync(join(tmpdir(), "toren-xagents-"));
  const mk = (name: string, yaml: string) => {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent.yaml"), yaml);
    return dir;
  };
  const ceoDir = mk("wceo", "name: wceo\nmodel: mock/echo\nagents:\n  can_call: [wcfo, wghost]\n");
  const cfoDir = mk("wcfo", "name: wcfo\nmodel: mock/echo\nagents:\n  accept_from: [wceo]\n");
  const bystanderDir = mk("wext", "name: wext\nmodel: mock/echo\n");

  const project = await loadProject([ceoDir, cfoDir, bystanderDir]);
  rt = await buildFleetRuntime(project);
  const { wceo, wcfo, wext } = rt.byAgent as Record<string, (typeof rt.byAgent)[string]>;

  // caller: tool granted, edge resolved only where both sides consent
  expect(wceo!.agents.main!.tools.some((t) => t.name === "call_agent")).toBe(true);
  expect(wceo!.agentCalls?.callable).toEqual(["wcfo"]); // wghost declared but never consented

  // callee + bystander: no tool, no facet
  expect(wcfo!.agents.main!.tools.some((t) => t.name === "call_agent")).toBe(false);
  expect(wcfo!.agentCalls).toBeUndefined();
  expect(wext!.agentCalls).toBeUndefined();

  // a live call lands in the callee's schema, stamped with the caller
  const r = await wceo!.agentCalls!.call({ agent: "wcfo", input: "q3?", parentRunId: "44444444-4444-4444-8444-444444444444", parentTaskId: "w0t0", toolUseId: "wx1" });
  const child = await wcfo!.store.getRun(r.runId);
  expect(child?.channel).toBe("agent:wceo");
  expect(await wceo!.store.getRun(r.runId)).toBeNull();

  // denial names the callable set
  await expect(wceo!.agentCalls!.call({ agent: "wext", input: "x", parentRunId: "44444444-4444-4444-8444-444444444444", parentTaskId: "w0t0", toolUseId: "wx2" }))
    .rejects.toThrow(/not callable from wceo/);
});

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Environment profiles: `.toren/environments.json` in the agent dir (then cwd).
 * A profile targets either the database directly (local) or a deployment's
 * intake API. Tokens are referenced by env-var name — never stored in the file.
 */
export interface EnvProfileFile {
  databaseUrl?: string;
  api?: string;
  tokenEnv?: string;
}

export type ResolvedEnv =
  | { name: string; kind: "db"; databaseUrl?: string }
  | { name: string; kind: "api"; url: string; token: string };

export function loadEnvironments(agentDir: string): Record<string, EnvProfileFile> {
  for (const base of [resolve(agentDir), process.cwd()]) {
    const path = join(base, ".toren", "environments.json");
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf8"));
      } catch (e) {
        throw new Error(`${path}: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
      }
    }
  }
  return {};
}

export function resolveEnvProfile(name: string | undefined, agentDir: string): ResolvedEnv {
  const envs = loadEnvironments(agentDir);
  const chosen = name ?? "local";
  const profile = envs[chosen] ?? (chosen === "local" ? {} : undefined);
  if (profile === undefined) {
    const known = Object.keys(envs).join(", ") || "local (implicit)";
    throw new Error(`unknown environment "${chosen}" — known: ${known}`);
  }
  if (profile.api) {
    const tokenEnv = profile.tokenEnv ?? "TOREN_API_TOKEN";
    const token = process.env[tokenEnv];
    if (!token) throw new Error(`environment "${chosen}" needs a bearer token: set ${tokenEnv}`);
    return { name: chosen, kind: "api", url: profile.api, token };
  }
  return { name: chosen, kind: "db", databaseUrl: profile.databaseUrl };
}

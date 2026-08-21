import { execFileSync, execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CmdIO } from "./commands.js";

const stdoutIO: CmdIO = { out: (l) => console.log(l) };

export interface DeployOpts {
  region: string;
  planOnly?: boolean;
  yes?: boolean;
  image?: string;
  agentDir?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  /** AWS shared-config profile for terraform, the state backend, and bucket setup. */
  profile?: string;
  /** S3 bucket for remote terraform state. Created (versioned, public-access-blocked) if missing. */
  stateBucket?: string;
  /** State object key (default toren/terraform.tfstate). */
  stateKey?: string;
  /** Directory containing the terraform module (default: repo's infra/terraform-aws, or the copy shipped in this package). */
  moduleDir?: string;
  /**
   * Docker build context for the agent image. When set, deploy-aws builds for
   * linux/arm64, pushes to the stack's ECR repo (created first via a targeted
   * apply), and applies with the pinned tag — the whole image pipeline.
   */
  imageContext?: string;
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
  // Published install: the module ships inside the package (synced at pack time).
  for (const rel of ["../terraform-aws", "../../terraform-aws"]) {
    const packaged = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(packaged)) return packaged;
  }
  throw new Error("could not locate the terraform module — pass --module-dir");
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

/** Creates the state bucket if missing: versioned, all public access blocked. Idempotent. */
export async function ensureStateBucket(bucket: string, region: string, io: CmdIO): Promise<void> {
  const {
    S3Client, HeadBucketCommand, CreateBucketCommand,
    PutBucketVersioningCommand, PutPublicAccessBlockCommand,
  } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ region });
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    io.out(`state bucket s3://${bucket} exists`);
    return;
  } catch (e) {
    const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status !== 404 && status !== 403) throw e;
    if (status === 403) throw new Error(`state bucket "${bucket}" exists but belongs to another account — pick a unique name`);
  }
  await s3.send(new CreateBucketCommand({
    Bucket: bucket,
    ...(region === "us-east-1" ? {} : { CreateBucketConfiguration: { LocationConstraint: region as never } }),
  }));
  await s3.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
  await s3.send(new PutPublicAccessBlockCommand({
    Bucket: bucket,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true,
    },
  }));
  io.out(`created state bucket s3://${bucket} (versioned, public access blocked)`);
}

/** Pure: image tag from git state — sha when clean, sha-epoch when dirty, t-epoch without git. Unit-tested. */
export function imageTag(gitSha: string | null, dirty: boolean, epochSeconds: number): string {
  if (!gitSha) return `t${epochSeconds}`;
  return dirty ? `${gitSha}-${epochSeconds}` : gitSha;
}

function gitState(context: string): { sha: string | null; dirty: boolean } {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: context, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: context, stdio: ["ignore", "pipe", "ignore"] }).toString().trim().length > 0;
    return { sha, dirty };
  } catch {
    return { sha: null, dirty: false };
  }
}

/** Logs docker into the ECR registry that owns `repoUri` using the AWS SDK (no aws CLI needed). */
export async function ecrDockerLogin(repoUri: string, region: string, io: CmdIO): Promise<void> {
  const { ECRClient, GetAuthorizationTokenCommand } = await import("@aws-sdk/client-ecr");
  const ecr = new ECRClient({ region });
  const res = await ecr.send(new GetAuthorizationTokenCommand({}));
  const auth = res.authorizationData?.[0]?.authorizationToken;
  if (!auth) throw new Error("ECR returned no authorization token");
  const [user, password] = Buffer.from(auth, "base64").toString("utf8").split(":");
  const registry = repoUri.split("/")[0]!;
  execFileSync("docker", ["login", "--username", user!, "--password-stdin", registry], { input: password, stdio: ["pipe", "ignore", "inherit"] });
  io.out(`docker logged in to ${registry}`);
}

/** Builds the agent image for linux/arm64 (matching the Fargate runtime platform) and pushes it. */
export function buildAndPushImage(context: string, imageUri: string, io: CmdIO): void {
  try {
    execSync("docker info", { stdio: "ignore" });
  } catch {
    throw new Error("docker is not running — start Docker to build the agent image (or pass --image with a prebuilt URI)");
  }
  if (!existsSync(join(context, "Dockerfile"))) {
    throw new Error(`${context} has no Dockerfile — toren init scaffolds one, or pass --image with a prebuilt URI`);
  }
  io.out(`building ${imageUri} (linux/arm64) from ${context}`);
  execFileSync("docker", ["build", "--platform", "linux/arm64", "-t", imageUri, context], { stdio: "inherit" });
  execFileSync("docker", ["push", imageUri], { stdio: "inherit" });
  io.out(`pushed ${imageUri}`);
}

/** Pure: the init args for a remote-state setup — unit-tested. */
export function backendInitArgs(opts: { bucket: string; key: string; region: string; profile?: string; migrating: boolean }): string[] {
  return [
    "init", "-input=false",
    "-backend-config", `bucket=${opts.bucket}`,
    "-backend-config", `key=${opts.key}`,
    "-backend-config", `region=${opts.region}`,
    ...(opts.profile ? ["-backend-config", `profile=${opts.profile}`] : []),
    "-backend-config", "use_lockfile=true",
    ...(opts.migrating ? ["-migrate-state", "-force-copy"] : []),
  ];
}

/**
 * `toren deploy aws` — one apply into the user's account.
 * Refuses to apply without --yes; --plan-only never mutates the stack
 * (with --state-bucket it may still create the empty state bucket).
 */
export async function cmdDeployAws(opts: DeployOpts, io: CmdIO = stdoutIO): Promise<void> {
  const moduleDir = findModuleDir(opts.moduleDir);
  const tf = tfBinary();
  if (opts.profile) process.env.AWS_PROFILE = opts.profile;

  const varArgs = [
    "-var", `region=${opts.region}`,
    ...(opts.profile ? ["-var", `aws_profile=${opts.profile}`] : []),
    ...(opts.image ? ["-var", `image=${opts.image}`] : []),
    ...(opts.agentDir ? ["-var", `agent_dir=${opts.agentDir}`] : []),
    ...(opts.anthropicApiKey ? ["-var", `anthropic_api_key=${opts.anthropicApiKey}`] : []),
    ...(opts.openaiApiKey ? ["-var", `openai_api_key=${opts.openaiApiKey}`] : []),
  ];

  io.out(`using ${tf} with module ${moduleDir}`);

  if (opts.stateBucket) {
    await ensureStateBucket(opts.stateBucket, opts.region, io);
    const backendTf = join(moduleDir, "backend.tf");
    if (!existsSync(backendTf)) writeFileSync(backendTf, `terraform {\n  backend "s3" {}\n}\n`);
    const migrating = existsSync(join(moduleDir, "terraform.tfstate"));
    if (migrating) io.out("local state found — migrating it into the S3 backend");
    execFileSync(tf, backendInitArgs({
      bucket: opts.stateBucket,
      key: opts.stateKey ?? "toren/terraform.tfstate",
      region: opts.region,
      profile: opts.profile,
      migrating,
    }), { cwd: moduleDir, stdio: "inherit" });
    io.out(`remote state: s3://${opts.stateBucket}/${opts.stateKey ?? "toren/terraform.tfstate"} (native S3 locking)`);
  } else {
    execFileSync(tf, ["init", "-input=false"], { cwd: moduleDir, stdio: "inherit" });
    io.out("state: LOCAL — fine for a rehearsal; pass --state-bucket <name> for anything real");
  }

  if (opts.planOnly) {
    if (opts.imageContext) io.out("note: --plan-only skips the image build/push");
    execFileSync(tf, ["plan", "-input=false", ...varArgs], { cwd: moduleDir, stdio: "inherit" });
    io.out("plan complete — nothing was created (--plan-only)");
    return;
  }
  if (!opts.yes) {
    throw new Error("refusing to apply without --yes (this creates billable AWS resources); use --plan-only to preview");
  }

  if (opts.imageContext) {
    if (opts.image) throw new Error("--image and --image-context are mutually exclusive (prebuilt URI vs build-from-source)");
    const context = resolve(opts.imageContext);
    // ECR repo must exist before we can push, and the service should never
    // start against a missing image — so: repo first, push, then everything
    // else with the freshly pushed tag pinned into the task definition.
    execFileSync(tf, ["apply", "-input=false", "-auto-approve", "-target=aws_ecr_repository.toren", ...varArgs], { cwd: moduleDir, stdio: "inherit" });
    const repoUri = execFileSync(tf, ["output", "-raw", "ecr_repository_url"], { cwd: moduleDir }).toString().trim();
    const { sha, dirty } = gitState(context);
    const tag = imageTag(sha, dirty, Math.floor(Date.now() / 1000));
    const imageUri = `${repoUri}:${tag}`;
    await ecrDockerLogin(repoUri, opts.region, io);
    buildAndPushImage(context, imageUri, io);
    varArgs.push("-var", `image=${imageUri}`);
    io.out(`task definition will pin ${tag} — the apply rolls the service onto it`);
  }

  execFileSync(tf, ["apply", "-input=false", "-auto-approve", ...varArgs], { cwd: moduleDir, stdio: "inherit" });
  execFileSync(tf, ["output", "worker_env"], { cwd: moduleDir, stdio: "inherit" });
  io.out(opts.imageContext
    ? "deployed — image built, pushed, and pinned; the service is rolling onto it."
    : "deployed. Push your image to the ECR repo (docker build/tag/push) — or rerun with --image-context <dir> to have toren do it.");
}

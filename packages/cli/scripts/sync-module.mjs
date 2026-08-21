// prepack: ship the terraform module inside the published CLI package so
// `toren deploy-aws` works from a plain npm install, not just the repo.
import { cpSync, rmSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const src = resolve(pkgDir, "../../infra/terraform-aws");
const dest = resolve(pkgDir, "terraform-aws");

if (!existsSync(src)) {
  console.error(`sync-module: ${src} not found — packing outside the repo?`);
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, {
  recursive: true,
  filter: (p) => !/\.terraform|terraform\.tfstate|backend\.tf$|\.tfvars$/.test(p),
});
console.log(`sync-module: ${src} -> ${dest}`);

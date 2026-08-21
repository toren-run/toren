import { expect, test } from "vitest";
import { backendInitArgs, imageTag } from "../src/deploy.js";

test("image tag: clean git uses the sha; dirty appends epoch; no git falls back to epoch", () => {
  expect(imageTag("abc1234", false, 1_700_000_000)).toBe("abc1234");
  expect(imageTag("abc1234", true, 1_700_000_000)).toBe("abc1234-1700000000");
  expect(imageTag(null, false, 1_700_000_000)).toBe("t1700000000");
});

test("backend init args: fresh setup with profile", () => {
  expect(backendInitArgs({ bucket: "b", key: "k", region: "eu-central-1", profile: "acme", migrating: false })).toEqual([
    "init", "-input=false",
    "-backend-config", "bucket=b",
    "-backend-config", "key=k",
    "-backend-config", "region=eu-central-1",
    "-backend-config", "profile=acme",
    "-backend-config", "use_lockfile=true",
  ]);
});

test("backend init args: migrating local state, default credential chain", () => {
  const args = backendInitArgs({ bucket: "b", key: "k", region: "us-east-1", migrating: true });
  expect(args).toContain("-migrate-state");
  expect(args).toContain("-force-copy");
  expect(args.join(" ")).not.toContain("profile=");
});

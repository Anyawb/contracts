import { spawnSync } from "node:child_process";
import * as path from "node:path";

const E2E_DIR = path.join(__dirname, "..");
const RUN_ALL = path.join(E2E_DIR, "tools", "run-all-e2e.ts");

const GOLDEN_SCRIPTS = [
  "e2e-localhost-blocks-only-rollout-smoke.ts",
  "e2e-localhost-full-with-views.ts",
  "e2e-localhost-batch-10-users.ts",
  "e2e-localhost-batch-advanced-10-users.ts",
  "e2e-localhost-attack-suite.ts",
  "e2e-localhost-scenario-matrix.ts",
  "e2e-localhost-systemview-routing.ts",
  "e2e-localhost-statisticsview-acceptance.ts",
];

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function setDefault(
  env: Record<string, string | undefined>,
  key: string,
  value: string,
) {
  if (!env[key]) env[key] = value;
}

function main() {
  const network = getArg("--network") ?? "localhost";
  const rpcUrl = getArg("--rpc") ?? process.env.LOCALHOST_RPC_URL ?? "";
  const failFast = hasFlag("--fail-fast");

  const env = { ...process.env } as Record<string, string | undefined>;
  setDefault(env, "E2E_STRICT_VIEWS", "1");
  setDefault(env, "E2E_VIEW_STRICT", "1");
  if (rpcUrl) env.LOCALHOST_RPC_URL = rpcUrl;

  const only = GOLDEN_SCRIPTS.join(",");
  const args = [
    "-s",
    "exec",
    "ts-node",
    "--project",
    "./tsconfig.scripts.json",
    RUN_ALL,
    "--network",
    network,
    "--only",
    only,
  ];
  if (failFast) args.push("--fail-fast");

  const result = spawnSync("pnpm", args, { env, encoding: "utf8" });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  process.exitCode = typeof result.status === "number" ? result.status : 1;
}

main();

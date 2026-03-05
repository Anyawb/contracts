import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const E2E_DIR = path.join(__dirname, "..");
const LOG_ROOT = path.join(E2E_DIR, "logs");

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function listE2eScripts(): string[] {
  return fs
    .readdirSync(E2E_DIR)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => f.startsWith("e2e-"))
    .filter((f) => f !== "quantify-latest-batch-artifacts.ts")
    .sort();
}

function safeWrite(filePath: string, data: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, data, "utf8");
}

function nowId() {
  return new Date().toISOString().replace(/[-:TZ.]/g, "");
}

async function main() {
  const network = getArg("--network") ?? "localhost";
  const rpcUrl = getArg("--rpc") ?? process.env.LOCALHOST_RPC_URL ?? "";
  const failFast = hasFlag("--fail-fast");

  const runId = `e2e-run-${nowId()}`;
  const runDir = path.join(LOG_ROOT, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const scripts = listE2eScripts();
  if (scripts.length === 0) {
    console.error("No E2E scripts found under scripts/e2e");
    process.exitCode = 1;
    return;
  }

  const manifest: {
    runId: string;
    startedAt: string;
    finishedAt?: string;
    network: string;
    rpcUrl: string;
    failFast: boolean;
    scripts: Array<{
      file: string;
      logFile: string;
      exitCode: number | null;
      durationMs: number;
    }>;
  } = {
    runId,
    startedAt: new Date().toISOString(),
    network,
    rpcUrl,
    failFast,
    scripts: [],
  };

  for (const file of scripts) {
    const started = Date.now();
    const scriptPath = path.join(E2E_DIR, file);
    const logFile = path.join(runDir, `${file.replace(/\.ts$/, "")}.log`);

    const env = { ...process.env };
    if (rpcUrl) env.LOCALHOST_RPC_URL = rpcUrl;

    const result = spawnSync(
      "pnpm",
      ["-s", "exec", "hardhat", "run", scriptPath, "--network", network],
      { env, encoding: "utf8" }
    );

    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    safeWrite(logFile, `${stdout}${stderr}`);

    const exitCode = typeof result.status === "number" ? result.status : null;
    const durationMs = Date.now() - started;

    manifest.scripts.push({
      file,
      logFile,
      exitCode,
      durationMs,
    });

    const status = exitCode === 0 ? "OK" : "FAIL";
    console.log(`[${status}] ${file} (${(durationMs / 1000).toFixed(1)}s)`);

    if (exitCode !== 0 && failFast) break;
  }

  manifest.finishedAt = new Date().toISOString();
  safeWrite(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  console.log(`\nLogs: ${runDir}`);
  console.log(`Manifest: ${path.join(runDir, "manifest.json")}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

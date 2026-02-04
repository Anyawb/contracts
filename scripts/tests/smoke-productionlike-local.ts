import { ethers, network } from "hardhat";
import { spawnSync } from "child_process";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";

function envBool(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "y") return true;
  if (v === "0" || v === "false" || v === "no" || v === "n") return false;
  return defaultValue;
}

function envStr(name: string, defaultValue?: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const v = raw.trim();
  return v.length ? v : defaultValue;
}

function pnpmBin(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

async function assertFreshLocalhostOrThrow(opts: {
  enabled: boolean;
  allowNonFresh: boolean;
  runDeploy: boolean;
}) {
  const { enabled, allowNonFresh, runDeploy } = opts;
  if (!enabled) return;

  const reasons: string[] = [];
  try {
    const blockNumber = await ethers.provider.getBlockNumber();
    if (blockNumber > 0) reasons.push(`blockNumber=${blockNumber} (expected 0 on a freshly started hardhat node)`);
  } catch (e: any) {
    reasons.push(`cannot read blockNumber from RPC (${e?.message ?? String(e)})`);
  }

  // Hardhat default deployer (account[0]) on localhost runs.
  const defaultDeployer = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
  try {
    const nonce = await ethers.provider.getTransactionCount(defaultDeployer);
    if (nonce > 0) reasons.push(`deployerNonce(${defaultDeployer})=${nonce} (expected 0)`);
  } catch (e: any) {
    reasons.push(`cannot read deployer nonce (${e?.message ?? String(e)})`);
  }

  // If frontend-config points to a deployed Registry and it has code, the node is not fresh.
  try {
    const code = await ethers.provider.getCode(CONTRACT_ADDRESSES.Registry);
    if (code && code !== "0x") reasons.push(`Registry bytecode exists at ${CONTRACT_ADDRESSES.Registry}`);
  } catch (e: any) {
    // Non-fatal: config may be stale or RPC may be down.
    reasons.push(`cannot read Registry code (${e?.message ?? String(e)})`);
  }

  if (reasons.length === 0) return;

  const msg =
    [
      `Non-fresh localhost node detected (MODE=fresh expects a truly fresh chain).`,
      runDeploy
        ? `Note: You are running with RUN_DEPLOY=1; do NOT run "pnpm -s run deploy:localhost" manually beforehand on the same node.`
        : `Note: If you already deployed on this node, MODE=fresh will refuse to proceed.`,
      ``,
      `Evidence:`,
      ...reasons.map((r) => `- ${r}`),
      ``,
      `Fix (recommended):`,
      `- Stop your current hardhat node, then start a fresh one:`,
      `  - terminal A: pnpm -s run node`,
      `  - terminal B: MODE=fresh RUN_DEPLOY=1 RUN_GRANT=1 RUN_PRECONFIG=1 pnpm -s run test:smoke:prodlike:localhost`,
      ``,
      `Bypass (not recommended): set ALLOW_NONFRESH_NODE=1`,
      `Or use an ephemeral node runner: pnpm -s run test:smoke:prodlike:localhost:autonode`,
    ].join("\n");

  if (allowNonFresh) {
    console.log(`\n⚠️  ${msg}\n`);
    return;
  }
  throw new Error(msg);
}

function runHardhatScript(label: string, scriptPath: string, extraEnv?: Record<string, string>) {
  const cmd = pnpmBin();
  const args = ["-s", "exec", "hardhat", "run", scriptPath, "--network", "localhost"];
  console.log(`\n== SmokeStep: ${label} ==`);
  console.log(`  $ ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, ...(extraEnv ?? {}) },
  });
  if (res.status !== 0) {
    throw new Error(`[FAIL] ${label} failed with exitCode=${res.status ?? "null"}`);
  }
}

/**
 * Production-like smoke runner (localhost)
 *
 * Goal:
 * - Provide a single entrypoint to run the recommended smoke recipe in a more “real ops” way:
 *   - SSOT/config sanity checks
 *   - unified cache refresh (A-class)
 *   - funds-flow invariants suite (supports dirty state)
 *   - attack suite (broad security scan, including view-module guards)
 *
 * Modes:
 * - MODE=dirty (default): closest to testnet/mainnet; assumes existing state; does NOT auto-deploy.
 * - MODE=fresh: deterministic; still assumes node is already running; optionally deploys.
 *
 * Toggles (all are env vars; defaults depend on MODE):
 * - RUN_DEPLOY=1: run deploylocal (fresh only; default 0)
 * - RUN_GRANT=1: grant required roles on localhost (default 0; production-like keeps this off)
 * - RUN_PRECONFIG=1: idempotent local preconfig for strict smoke (default 0; production-like keeps this off)
 * - RUN_CACHE_REFRESH=1: run CacheMaintenanceManager.batchRefresh checks (default 1)
 * - RUN_SSOT_VERIFY=1: run SSOT wiring checks (default 1)
 * - RUN_FUNDS=1: run funds-flow invariants suite (default 1)
 * - RUN_ATTACK=1: run attack suite (default 1)
 */
async function main() {
  if (network.name !== "localhost") {
    throw new Error(`This script must run with --network localhost (got ${network.name})`);
  }

  const mode = (envStr("MODE", "dirty") ?? "dirty").toLowerCase();
  if (mode !== "dirty" && mode !== "fresh") {
    throw new Error(`Invalid MODE=${mode} (expected "dirty" or "fresh")`);
  }

  const RUN_DEPLOY = envBool("RUN_DEPLOY", false);
  const RUN_GRANT = envBool("RUN_GRANT", false);
  const RUN_PRECONFIG = envBool("RUN_PRECONFIG", false);
  const RUN_CACHE_REFRESH = envBool("RUN_CACHE_REFRESH", true);
  const RUN_SSOT_VERIFY = envBool("RUN_SSOT_VERIFY", true);
  const RUN_VIEW_SMOKE = envBool("RUN_VIEW_SMOKE", true);
  const RUN_VIEWCACHE_SMOKE = envBool("RUN_VIEWCACHE_SMOKE", true);
  const RUN_LE_SMOKE = envBool("RUN_LE_SMOKE", false);
  const RUN_FUNDS = envBool("RUN_FUNDS", true);
  const RUN_ATTACK = envBool("RUN_ATTACK", true);

  console.log("=== Smoke (production-like) runner ===");
  console.log(`  network=${network.name}`);
  console.log(`  MODE=${mode}`);
  console.log(
    `  steps: deploy=${RUN_DEPLOY} grant=${RUN_GRANT} preconfig=${RUN_PRECONFIG} cacheRefresh=${RUN_CACHE_REFRESH} ssot=${RUN_SSOT_VERIFY} viewSmoke=${RUN_VIEW_SMOKE} viewCacheSmoke=${RUN_VIEWCACHE_SMOKE} leSmoke=${RUN_LE_SMOKE} funds=${RUN_FUNDS} attack=${RUN_ATTACK}`
  );

  // Fresh-mode guard: "fresh" means the node itself is fresh (restart hardhat node).
  // Set ALLOW_NONFRESH_NODE=1 to keep going anyway (acts like a dirty run).
  const FRESH_GUARD = envBool("FRESH_GUARD", true);
  const ALLOW_NONFRESH_NODE = envBool("ALLOW_NONFRESH_NODE", false);
  if (mode === "fresh") {
    await assertFreshLocalhostOrThrow({ enabled: FRESH_GUARD, allowNonFresh: ALLOW_NONFRESH_NODE, runDeploy: RUN_DEPLOY });
  }

  // Optional "fresh-state" helpers.
  if (RUN_DEPLOY) {
    runHardhatScript("deploylocal", "scripts/deploy/deploylocal.ts");
  }
  if (RUN_GRANT) {
    runHardhatScript("grant-required-roles-local", "scripts/tests/grant-required-roles-local.ts");
  }
  if (RUN_PRECONFIG) {
    runHardhatScript("preconfig-strict-smoke-local", "scripts/tests/preconfig-strict-smoke-local.ts");
  }

  // Recommended real-ops acceptance steps.
  if (RUN_CACHE_REFRESH) {
    runHardhatScript("cache-refresh-local (A-class cache + unified refresh entry)", "scripts/tests/cache-refresh-local.ts");
  }
  if (RUN_SSOT_VERIFY) {
    runHardhatScript("verify-config-ssot-local (SSOT wiring)", "scripts/tests/verify-config-ssot-local.ts");
  }
  if (RUN_VIEW_SMOKE) {
    runHardhatScript("view-schemeu-smoke-local (Risk/Health/SystemRisk)", "scripts/tests/view-schemeu-smoke-local.ts");
  }
  if (RUN_VIEWCACHE_SMOKE) {
    runHardhatScript("viewcache-smoke-local (system cache)", "scripts/tests/viewcache-smoke-local.ts");
  }
  if (RUN_LE_SMOKE) {
    runHardhatScript("lendingengine-smoke-local (LendingEngineView focused)", "scripts/tests/lendingengine-smoke-local.ts");
  }
  if (RUN_FUNDS) {
    const extraEnv: Record<string, string> = {};
    // Default to dirty-state tolerant selection unless user explicitly overrides.
    if (process.env.E2E_ALLOW_DIRTY_STATE === undefined) {
      extraEnv.E2E_ALLOW_DIRTY_STATE = mode === "dirty" ? "1" : "0";
    }
    runHardhatScript("funds-flow-invariants-suite", "scripts/tests/funds-flow-invariants-suite.ts", extraEnv);
  }
  if (RUN_ATTACK) {
    runHardhatScript("e2e-localhost-attack-suite", "scripts/e2e/e2e-localhost-attack-suite.ts");
  }

  console.log("\n✅ Smoke runner finished.\n");
}

main().catch((e) => {
  console.error("\n❌ Smoke runner FAILED\n");
  console.error(e);
  process.exit(1);
});


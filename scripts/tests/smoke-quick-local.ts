import { spawnSync } from "child_process";

function envBool(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "y") return true;
  if (v === "0" || v === "false" || v === "no" || v === "n") return false;
  return defaultValue;
}

function pnpmBin(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function runSmokeQuick() {
  const cmd = pnpmBin();
  const args = ["-s", "exec", "hardhat", "run", "scripts/tests/smoke-productionlike-local.ts", "--network", "localhost"];

  const env = {
    ...process.env,
    MODE: process.env.MODE ?? "dirty",
    RUN_DEPLOY: process.env.RUN_DEPLOY ?? "0",
    RUN_GRANT: process.env.RUN_GRANT ?? "0",
    RUN_PRECONFIG: process.env.RUN_PRECONFIG ?? "0",
    RUN_CACHE_REFRESH: process.env.RUN_CACHE_REFRESH ?? "1",
    RUN_SSOT_VERIFY: process.env.RUN_SSOT_VERIFY ?? "1",
    RUN_VIEW_SMOKE: process.env.RUN_VIEW_SMOKE ?? "1",
    RUN_VIEWCACHE_SMOKE: process.env.RUN_VIEWCACHE_SMOKE ?? "1",
    RUN_REWARD_SMOKE: process.env.RUN_REWARD_SMOKE ?? "1",
    RUN_REWARD_CONFIGS_SMOKE: process.env.RUN_REWARD_CONFIGS_SMOKE ?? "0",
    RUN_LE_SMOKE: process.env.RUN_LE_SMOKE ?? "0",
    RUN_FUNDS: process.env.RUN_FUNDS ?? "0",
    RUN_ATTACK: process.env.RUN_ATTACK ?? "0",
  };

  const keepState = envBool("KEEP_STATE", false);
  if (!keepState && env.E2E_ALLOW_DIRTY_STATE === undefined) {
    env.E2E_ALLOW_DIRTY_STATE = "1";
  }

  console.log("=== Smoke quick (localhost) ===");
  console.log(`  MODE=${env.MODE} RUN_FUNDS=${env.RUN_FUNDS} RUN_ATTACK=${env.RUN_ATTACK}`);
  console.log(`  $ ${cmd} ${args.join(" ")}`);

  const res = spawnSync(cmd, args, { stdio: "inherit", env });
  if (res.status !== 0) {
    throw new Error(`smoke-quick failed with exitCode=${res.status ?? "null"}`);
  }
}

runSmokeQuick();

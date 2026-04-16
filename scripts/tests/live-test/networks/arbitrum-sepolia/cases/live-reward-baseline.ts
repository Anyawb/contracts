import { logLiveScriptFailure, logLiveScriptSuccess } from "../core/_scriptStatus";
import { runLiveDomainPreflight } from "../core/_liveDomainPreflight";

type RewardLayer = "runtime" | "observability";

function resolveMode(): RewardLayer | "all" {
  const raw = process.env.LIVE_REWARD_BASELINE_LAYER?.trim().toLowerCase();
  if (raw === "runtime" || raw === "observability" || raw === "all") {
    return raw;
  }
  return "all";
}

async function runLiveModule(modulePath: string) {
  const mod = await import(modulePath) as { liveScriptPromise?: Promise<void> };
  if (!mod.liveScriptPromise) {
    throw new Error(`${modulePath} does not export liveScriptPromise`);
  }
  await mod.liveScriptPromise;
}

async function runLayer(layer: RewardLayer) {
  console.log(`=== Live Reward Layer: ${layer} ===`);
  if (layer === "runtime") {
    await runLiveModule("./live-reward-lender-view");
    await runLiveModule("./live-view-reward-loanflow-boundary");
    await runLiveModule("./live-reward-config-governance");
    await runLiveModule("./live-reward-mint-threshold-guard");
    await runLiveModule("./live-reward-borrow-gate-rmcore");
    return;
  }
  await runLiveModule("./live-reward-command-model-sequences");
}

async function main() {
  await runLiveDomainPreflight("reward");
  const mode = resolveMode();
  if (mode === "all") {
    await runLayer("runtime");
    await runLayer("observability");
  } else {
    await runLayer(mode);
  }
  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = main().catch((error) => {
  logLiveScriptFailure(__filename, error);
  process.exit(1);
});
import { REWARD_LONG_SEQUENCE_CATALOG } from "../../../../../e2e/utils/reward-command-model";

async function runLiveModule(modulePath: string) {
  const mod = await import(modulePath) as { liveScriptPromise?: Promise<void> };
  if (!mod.liveScriptPromise) {
    throw new Error(`${modulePath} does not export liveScriptPromise`);
  }
  await mod.liveScriptPromise;
}

async function main() {
  console.log("=== Live Reward Command Model Sequence Mapping ===");

  for (const scenario of REWARD_LONG_SEQUENCE_CATALOG) {
    console.log(`  [Scenario] ${scenario.id} -> ${scenario.mappedLiveCase}`);
    console.log(`  [Intent] ${scenario.liveIntent}`);
    if (scenario.mappedLiveCase === "live-reward-multi-borrower-stress") {
      await runLiveModule("./live-reward-multi-borrower-stress");
      continue;
    }
    if (scenario.mappedLiveCase === "live-reward-penalty-recycle-recovery") {
      await runLiveModule("./live-reward-penalty-recycle-recovery");
      continue;
    }
    throw new Error("unsupported live reward scenario mapping");
  }
}

export const liveScriptPromise = main();
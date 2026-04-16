import { envBool } from "../../../../_addressResolver";
import { runMockLiveIgnition } from "../core/_mockLiveIgnition";
import { primeMockLiveViewCache } from "../core/_mockLiveViewCache";
import { runWithNetworkRetry } from "../core/_networkRetry";
import { logLiveScriptFailure, logLiveScriptSuccess } from "../core/_scriptStatus";

// 完整 warmup 入口：
// 1. 跑一遍真实写模式的借贷/还款流程，尽量把 RewardView / HealthView / PositionView 写热。
// 2. 如开启 PRIME_VIEW_CACHE，再额外把 ViewCache 的系统维度缓存补齐。
async function main() {
  await runWithNetworkRetry("live-warmup-ignition-bnb-testnet", async () => {
    await runMockLiveIgnition({
      label: "Mock Live Warmup",
      defaultEnableWrite: true,
      defaultAllowSingleParty: false,
      collateralAmountUnitsDefault: "10",
      borrowAmountUnitsDefault: "1200",
    });
  });

  // ViewCache 不一定会在最小借贷路径里自动变热，所以默认补做一次显式 prime。
  if (envBool("PRIME_VIEW_CACHE", true)) {
    await runWithNetworkRetry("live-warmup-view-cache-prime-bnb-testnet", async () => {
      await primeMockLiveViewCache({
        label: "Mock Live ViewCache Prime",
      });
    });
  }

  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = main().catch((error) => {
  logLiveScriptFailure(__filename, error);
  process.exit(1);
});
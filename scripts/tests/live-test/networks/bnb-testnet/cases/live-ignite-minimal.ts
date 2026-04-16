import { runMockLiveIgnition } from "../core/_mockLiveIgnition";
import { logLiveScriptFailure, logLiveScriptSuccess } from "../core/_scriptStatus";

// 最小化 live smoke 入口：
// 只复用完整的点火流程，但默认保持只读，便于先验证配置和依赖是否齐全。
async function main() {
  await runMockLiveIgnition({
    label: "Mock Live Minimal Ignition",
    defaultEnableWrite: false,
    defaultAllowSingleParty: false,
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "500",
  });
  logLiveScriptSuccess(__filename);
}

export const liveScriptPromise = main().catch((error) => {
  logLiveScriptFailure(__filename, error);
  process.exit(1);
});
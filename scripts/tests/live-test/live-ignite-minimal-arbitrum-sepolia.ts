import { runMockLiveIgnition } from "./_mockLiveIgnition";

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
}

main().catch((error) => {
  console.error("\n❌ live-ignite-minimal-arbitrum-sepolia FAILED\n");
  console.error(error);
  process.exit(1);
});
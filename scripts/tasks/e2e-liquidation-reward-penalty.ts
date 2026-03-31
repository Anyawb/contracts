import { task } from "hardhat/config";

/**
 * Run the liquidation -> reward penalty E2E on localhost/devnets.
 *
 * Example:
 *   pnpm -s exec hardhat e2e:liquidation-reward-penalty --network localhost
 */
task(
  "e2e:liquidation-reward-penalty",
  "Liquidation datapush + Reward penalty (liquidation tx has no reward push; penalty tx updates ledger)"
).setAction(async () => {
  const { runLiquidationRewardPenalty } = await import("../e2e/e2e-localhost-liquidation-reward-penalty");
  await runLiquidationRewardPenalty();
});

import { task } from "hardhat/config";

/**
 * Reward edge cases E2E (localhost):
 * - partial repay should NOT trigger Reward
 * - early/on-time/late full repay outcomes
 * - penalty burn vs penaltyLedger
 * - multi-order independence (same borrower)
 *
 * Usage:
 *   npx hardhat e2e:reward-edgecases --network localhost
 */
task("e2e:reward-edgecases", "Reward edge cases E2E (Architecture-Guide aligned)").setAction(async () => {
  const { runRewardEdgecases } = await import("../e2e/e2e-localhost-reward-edgecases");
  await runRewardEdgecases();
});



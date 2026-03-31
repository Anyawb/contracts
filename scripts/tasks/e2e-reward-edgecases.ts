import { task } from "hardhat/config";

/**
 * Run Reward edgecases E2E (multi-order/early/late/penalty ledger).
 */
task("e2e:reward-edgecases", "Reward edgecases E2E (penalty ledger and outcome semantics)").setAction(
  async () => {
    const { runRewardEdgecases } = await import("../e2e/e2e-localhost-reward-edgecases");
    await runRewardEdgecases();
  }
);

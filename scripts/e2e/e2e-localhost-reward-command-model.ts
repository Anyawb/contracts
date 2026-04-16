import { ethers, network } from "hardhat";

import { runViewPreflight } from "./utils/view-preflight.ts";
import { envBool, loadAddressMap, resolveAddress } from "../tests/_addressResolver";
import {
  buildConcurrentPenaltyOffsetScenario,
  buildInterleavedPenaltyLiquidationScenario,
  normalizeToSystemValue18,
  runRewardCommandScenario,
} from "./utils/reward-command-model";

function key(value: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(value));
}

function assertOk(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function readRewardState(params: {
  rewardView: any;
  rewardAccrualManager: any;
  easyToken: any;
  signer: any;
  userAddress: string;
}) {
  const summary = await params.rewardView.connect(params.signer).getUserRewardSummaryWithMeta(params.userAddress);
  const earnState = await params.rewardView.connect(params.signer).getUserEarnStateWithMeta(params.userAddress);

  return {
    easyBalance: (await params.easyToken.balanceOf(params.userAddress)) as bigint,
    penaltyDebt: (await params.rewardAccrualManager.getPenaltyDebt(params.userAddress)) as bigint,
    pendingPenalty: summary[1] as bigint,
    level: BigInt(summary[2] as number),
    lockedEasy: earnState[0] as bigint,
    eligibleLoanCount: earnState[1] as bigint,
    onTimeRepayCount: earnState[2] as bigint,
    totalBurned: summary[0] as bigint,
  };
}

async function runIsolatedScenario(params: {
  scenario: Parameters<typeof runRewardCommandScenario>[0]["scenario"];
  env: Parameters<typeof runRewardCommandScenario>[0]["env"];
}) {
  const snap = await network.provider.send("evm_snapshot", []);
  try {
    await runRewardCommandScenario({
      scenario: params.scenario,
      env: params.env,
    });
  } finally {
    await network.provider.send("evm_revert", [snap]);
  }
}

export async function runRewardCommandModelE2e() {
  const supportsHardhat = network.name === "localhost" || network.name === "hardhat";
  const readOnly = envBool("READ_ONLY", network.name !== "localhost");
  const enableWrite = envBool("ENABLE_WRITE", !readOnly);
  assertOk(supportsHardhat, "reward-command-model requires localhost/hardhat");
  assertOk(!readOnly && enableWrite, "reward-command-model requires ENABLE_WRITE=1");

  const addressMap = loadAddressMap(network.name);
  const registryAddr = resolveAddress({ name: "Registry", map: addressMap, envVar: "REGISTRY_ADDRESS" });

  const snap = await network.provider.send("evm_snapshot", []);
  try {
    const [deployer] = await ethers.getSigners();
    const registry = (await ethers.getContractAt("Registry", registryAddr)) as any;
    const acmAddr = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
    const settlementTokenAddr = (await registry.getModuleOrRevert(key("SETTLEMENT_TOKEN"))) as string;

    await runViewPreflight({
      registryAddr,
      acmAddr,
      adminSigner: deployer,
      assetForPriceCheck: settlementTokenAddr,
      ensureViewPushRole: true,
      ensureHealthPushDeps: true,
    });

    const rewardViewAddr = (await registry.getModuleOrRevert(key("REWARD_VIEW"))) as string;
    const rewardManagerAddr = (await registry.getModuleOrRevert(key("REWARD_MANAGER"))) as string;
    const rewardAccrualManagerAddr = (await registry.getModuleOrRevert(key("REWARD_ACCRUAL_MANAGER"))) as string;
    const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;
    const guaranteeFundAddr = (await registry.getModuleOrRevert(key("GUARANTEE_FUND_MANAGER"))) as string;
    const easyTokenAddr = (await registry.getModuleOrRevert(key("EASY_TOKEN"))) as string;
    const priceOracleAddr = (await registry.getModuleOrRevert(key("PRICE_ORACLE"))) as string;

    const rewardView = (await ethers.getContractAt("RewardView", rewardViewAddr)) as any;
    const rewardManager = (await ethers.getContractAt("RewardManager", rewardManagerAddr)) as any;
    const rewardAccrualManager = (await ethers.getContractAt("RewardAccrualManager", rewardAccrualManagerAddr)) as any;
    const easyToken = (await ethers.getContractAt("EasyToken", easyTokenAddr)) as any;
    const priceOracle = (await ethers.getContractAt("IPriceOracle", priceOracleAddr)) as any;
    const acm = (await ethers.getContractAt("AccessControlManager", acmAddr)) as any;

    assertOk(await acm.hasRole(key("SET_PARAMETER"), deployer.address), "missing SET_PARAMETER role for command-model e2e");

    await network.provider.send("hardhat_impersonateAccount", [orderEngineAddr]);
    await network.provider.send("hardhat_setBalance", [orderEngineAddr, "0x56BC75E2D63100000"]);
    const orderEngineSigner = await ethers.getSigner(orderEngineAddr);

    await network.provider.send("hardhat_impersonateAccount", [guaranteeFundAddr]);
    await network.provider.send("hardhat_setBalance", [guaranteeFundAddr, "0x56BC75E2D63100000"]);
    const guaranteeFundSigner = await ethers.getSigner(guaranteeFundAddr);

    const [settlementPrice, , settlementDecimals] = (await priceOracle.getPrice(settlementTokenAddr)) as [bigint, bigint, bigint];
    assertOk(settlementPrice > 0n, "SETTLEMENT_TOKEN price unavailable for reward command model e2e");
    assertOk(settlementDecimals > 0n, "SETTLEMENT_TOKEN decimals unavailable for reward command model e2e");

    function createScenarioEnv() {
      const actorMap = new Map<string, string>([
        ["borrowerAlice", ethers.Wallet.createRandom().address],
        ["borrowerBob", ethers.Wallet.createRandom().address],
        ["lenderCarol", ethers.Wallet.createRandom().address],
        ["lenderDave", ethers.Wallet.createRandom().address],
      ]);

      return {
        resolveActor(actor: string) {
          const resolved = actorMap.get(actor);
          assertOk(resolved, `unknown e2e actor ${actor}`);
          return resolved;
        },
        resolveAsset(asset: string) {
          assertOk(asset === "rewardAsset", `unknown e2e asset ${asset}`);
          return settlementTokenAddr;
        },
        async getAmountValue18(_assetAddress: string, amountBaseUnits: bigint) {
          return normalizeToSystemValue18(amountBaseUnits, settlementPrice, settlementDecimals);
        },
        async setLevelMultiplier(level: bigint, multiplierBps: bigint) {
          await (await rewardManager.connect(deployer).setLevelMultiplier(level, multiplierBps)).wait();
        },
        async setDynamicRewardParams(thresholdEasy: bigint, dynamicMultiplierBps: bigint) {
          await (await rewardManager.connect(deployer).setDynamicRewardParams(thresholdEasy, dynamicMultiplierBps)).wait();
        },
        async setLatePenaltyBps(latePenaltyBps: bigint) {
          await (await rewardManager.connect(deployer).setLatePenaltyBps(latePenaltyBps)).wait();
        },
        async setLiquidationPenaltyBps(liquidationPenaltyBps: bigint) {
          await (await rewardManager.connect(deployer).setLiquidationPenaltyBps(liquidationPenaltyBps)).wait();
        },
        async updateUserLevel(userAddress: string, level: bigint) {
          await (await rewardManager.connect(deployer).updateUserLevel(userAddress, level)).wait();
        },
        async onLoanEventByOrderWithLender(params: {
          borrowerAddress: string;
          lenderAddress: string;
          assetAddress: string;
          orderId: bigint;
          amountBaseUnits: bigint;
          maturity: bigint;
          outcome: number;
        }) {
          await (await rewardManager.connect(orderEngineSigner).onLoanEventByOrderWithLender(
            params.borrowerAddress,
            params.lenderAddress,
            params.assetAddress,
            params.orderId,
            params.amountBaseUnits,
            params.maturity,
            params.outcome,
          )).wait();
        },
        async quoteLiquidationPenalty(userAddress: string) {
          return rewardManager.quoteLiquidationPenalty(userAddress) as Promise<bigint>;
        },
        async applyLiquidationPenalty(userAddress: string) {
          await (await rewardManager.connect(guaranteeFundSigner).applyLiquidationPenalty(userAddress)).wait();
        },
        async applyManualPenalty(userAddress: string, amount: bigint) {
          await (await rewardAccrualManager.connect(guaranteeFundSigner).applyPenaltyByGfm(userAddress, amount)).wait();
        },
        async readUserState(userAddress: string) {
          return readRewardState({
            rewardView,
            rewardAccrualManager,
            easyToken,
            signer: deployer,
            userAddress,
          });
        },
      };
    }

    const amountBaseUnits = 1100n * 10n ** settlementDecimals;
    const maturity = BigInt((await ethers.provider.getBlockNumber()) + 7200);
    const orderIdSeed = BigInt(Date.now()) * 10n;

    console.log(`=== E2E Reward command model (${network.name}) ===`);

    await runIsolatedScenario({
      scenario: buildConcurrentPenaltyOffsetScenario({
        asset: "rewardAsset",
        amountBaseUnits,
        maturity,
        orderIdBase: orderIdSeed,
      }),
      env: createScenarioEnv(),
    });
    console.log("  [Scenario] concurrent penalty offset sequence passed");

    await runIsolatedScenario({
      scenario: buildInterleavedPenaltyLiquidationScenario({
        asset: "rewardAsset",
        amountBaseUnits,
        maturity,
        orderIdBase: orderIdSeed + 100n,
      }),
      env: createScenarioEnv(),
    });
    console.log("  [Scenario] interleaved penalty liquidation sequence passed");

    console.log("\n✅ e2e-localhost-reward-command-model PASSED\n");
  } finally {
    await network.provider.send("evm_revert", [snap]);
  }
}

async function main() {
  await runRewardCommandModelE2e();
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const isMain = typeof require !== "undefined" && require.main === module;
if (isMain) {
  main().catch((error) => {
    console.error("\n❌ e2e-localhost-reward-command-model FAILED\n");
    console.error(error);
    process.exit(1);
  });
}
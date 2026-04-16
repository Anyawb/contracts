import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import {
  buildConcurrentPenaltyOffsetScenario,
  buildInterleavedPenaltyLiquidationScenario,
  runRewardCommandScenario,
} from "../../../scripts/e2e/utils/reward-command-model";

const KEY_ACCESS_CONTROL = ethers.id("ACCESS_CONTROL_MANAGER");
const KEY_ORDER_ENGINE = ethers.id("ORDER_ENGINE");
const KEY_REWARD_MANAGER = ethers.id("REWARD_MANAGER");
const KEY_REWARD_MANAGER_CORE = ethers.id("REWARD_MANAGER_CORE");
const KEY_REWARD_CONFIG = ethers.id("REWARD_CONFIG");
const KEY_REWARD_EARN_CONFIG = ethers.id("REWARD_EARN_CONFIG");
const KEY_REWARD_ACCRUAL_MANAGER = ethers.id("REWARD_ACCRUAL_MANAGER");
const KEY_GUARANTEE_FUND = ethers.id("GUARANTEE_FUND_MANAGER");
const KEY_EASY_EMISSION_CONTROLLER = ethers.id("EASY_EMISSION_CONTROLLER");
const KEY_EASY_EMISSION_CONFIG = ethers.id("EASY_EMISSION_CONFIG");
const KEY_EASY_TOKEN = ethers.id("EASY_TOKEN");
const KEY_EASY_STAKING = ethers.id("EASY_STAKING");
const KEY_EASY_CONSUMPTION = ethers.id("EASY_CONSUMPTION");
const KEY_EASY_RECYCLE_DISTRIBUTOR = ethers.id("EASY_RECYCLE_DISTRIBUTOR");
const KEY_LOAN_FLOW_VIEW = ethers.id("LOAN_FLOW_VIEW");
const KEY_PRICE_ORACLE = ethers.id("PRICE_ORACLE");
const KEY_REWARD_VIEW = ethers.id("REWARD_VIEW");

type RewardFixture = Awaited<ReturnType<typeof deployFixture>>;

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

async function deployFixture() {
  const [
    admin,
    orderEngine,
    guaranteeFund,
    borrowerAlice,
    borrowerBob,
    lenderCarol,
    lenderDave,
    easyStakingWriter,
    easyConsumptionWriter,
    recycleWriter,
  ] = await ethers.getSigners();

  const AccessControlManager = await ethers.getContractFactory("AccessControlManager");
  const accessControlManager: any = await AccessControlManager.deploy(admin.address);
  await accessControlManager.waitForDeployment();

  const MockRegistry = await ethers.getContractFactory("MockRegistry");
  const registry: any = await MockRegistry.deploy();
  await registry.waitForDeployment();

  const RewardManagerCore = await ethers.getContractFactory("RewardManagerCore");
  const rewardManagerCore = await upgrades.deployProxy(RewardManagerCore, [registry.target], {
    kind: "uups",
    initializer: "initialize",
  });

  const RewardAccrualManager = await ethers.getContractFactory("RewardAccrualManager");
  const rewardAccrualManager = await upgrades.deployProxy(RewardAccrualManager, [registry.target], {
    kind: "uups",
    initializer: "initialize",
  });

  const RewardManager = await ethers.getContractFactory("RewardManager");
  const rewardManager = await upgrades.deployProxy(RewardManager, [registry.target], {
    kind: "uups",
    initializer: "initialize",
  });

  const RewardConfig = await ethers.getContractFactory("RewardConfig");
  const rewardConfig = await upgrades.deployProxy(RewardConfig, [registry.target], {
    kind: "uups",
    initializer: "initialize",
  });

  const EarnConfig = await ethers.getContractFactory("EarnConfig");
  const earnConfig = await upgrades.deployProxy(EarnConfig, [registry.target], {
    kind: "uups",
    initializer: "initialize",
  });

  const EasyEmissionController = await ethers.getContractFactory("EasyEmissionController");
  const easyEmissionController = await upgrades.deployProxy(EasyEmissionController, [registry.target], {
    kind: "uups",
    initializer: "initialize",
  });

  const EasyEmissionConfig = await ethers.getContractFactory("EasyEmissionConfig");
  const easyEmissionConfig = await upgrades.deployProxy(EasyEmissionConfig, [registry.target], {
    kind: "uups",
    initializer: "initialize",
  });

  const EasyToken = await ethers.getContractFactory("EasyToken");
  const easyToken = await upgrades.deployProxy(EasyToken, [admin.address], {
    kind: "uups",
    initializer: "initialize",
  });

  const LoanFlowView = await ethers.getContractFactory("LoanFlowView");
  const loanFlowView = await upgrades.deployProxy(LoanFlowView, [registry.target], {
    kind: "uups",
    initializer: "initialize",
  });

  const RewardView = await ethers.getContractFactory("RewardView");
  const rewardView = await upgrades.deployProxy(RewardView, [registry.target], {
    kind: "uups",
    initializer: "initialize",
  });

  const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
  const priceOracle = await MockPriceOracle.deploy();
  await priceOracle.waitForDeployment();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const asset = await MockERC20.deploy("Mock USDC", "USDC", 18, ethers.parseUnits("1000000", 18));
  await asset.waitForDeployment();

  await registry.setModule(KEY_ACCESS_CONTROL, await accessControlManager.getAddress());
  await registry.setModule(KEY_ORDER_ENGINE, orderEngine.address);
  await registry.setModule(KEY_REWARD_MANAGER, rewardManager.target);
  await registry.setModule(KEY_REWARD_MANAGER_CORE, rewardManagerCore.target);
  await registry.setModule(KEY_REWARD_CONFIG, rewardConfig.target);
  await registry.setModule(KEY_REWARD_EARN_CONFIG, earnConfig.target);
  await registry.setModule(KEY_REWARD_ACCRUAL_MANAGER, rewardAccrualManager.target);
  await registry.setModule(KEY_GUARANTEE_FUND, guaranteeFund.address);
  await registry.setModule(KEY_EASY_EMISSION_CONTROLLER, easyEmissionController.target);
  await registry.setModule(KEY_EASY_EMISSION_CONFIG, easyEmissionConfig.target);
  await registry.setModule(KEY_EASY_TOKEN, easyToken.target);
  await registry.setModule(KEY_EASY_STAKING, easyStakingWriter.address);
  await registry.setModule(KEY_EASY_CONSUMPTION, easyConsumptionWriter.address);
  await registry.setModule(KEY_EASY_RECYCLE_DISTRIBUTOR, recycleWriter.address);
  await registry.setModule(KEY_LOAN_FLOW_VIEW, loanFlowView.target);
  await registry.setModule(KEY_PRICE_ORACLE, priceOracle.target);
  await registry.setModule(KEY_REWARD_VIEW, rewardView.target);

  const roleSetParameter = ethers.id("SET_PARAMETER");
  const roleViewUserData = ethers.id("VIEW_USER_DATA");
  const roleViewSystemData = ethers.id("VIEW_SYSTEM_DATA");
  const roleActionAdmin = ethers.id("ACTION_ADMIN");

  const ensureRole = async (role: string, account: string) => {
    if (!(await accessControlManager.hasRole(role, account))) {
      await accessControlManager.grantRole(role, account);
    }
  };

  await ensureRole(roleSetParameter, admin.address);
  await ensureRole(roleViewUserData, admin.address);
  await ensureRole(roleViewSystemData, admin.address);
  await ensureRole(roleActionAdmin, admin.address);

  await easyToken.connect(admin).setSoleMinter(easyEmissionController.target);

  const currentBlock = await ethers.provider.getBlockNumber();
  await priceOracle.setPrice(asset.target, ethers.parseUnits("1", 18), currentBlock, 18);

  return {
    admin,
    orderEngine,
    guaranteeFund,
    borrowerAlice,
    borrowerBob,
    lenderCarol,
    lenderDave,
    rewardManager,
    rewardAccrualManager,
    rewardView,
    easyToken,
    asset,
  };
}

function createFixtureEnv(fixture: RewardFixture) {
  const actorMap = new Map<string, string>([
    ["borrowerAlice", fixture.borrowerAlice.address],
    ["borrowerBob", fixture.borrowerBob.address],
    ["lenderCarol", fixture.lenderCarol.address],
    ["lenderDave", fixture.lenderDave.address],
  ]);

  const signerMap = new Map<string, any>([
    [fixture.borrowerAlice.address, fixture.borrowerAlice],
    [fixture.borrowerBob.address, fixture.borrowerBob],
    [fixture.lenderCarol.address, fixture.lenderCarol],
    [fixture.lenderDave.address, fixture.lenderDave],
  ]);

  return {
    resolveActor(actor: string) {
      const resolved = actorMap.get(actor);
      expect(resolved, `unknown fixture actor ${actor}`).to.exist;
      return resolved!;
    },
    resolveAsset(asset: string) {
      expect(asset).to.equal("rewardAsset");
      return fixture.asset.target as string;
    },
    async getAmountValue18(_assetAddress: string, amountBaseUnits: bigint) {
      return amountBaseUnits;
    },
    async setLevelMultiplier(level: bigint, multiplierBps: bigint) {
      await fixture.rewardManager.connect(fixture.admin).setLevelMultiplier(level, multiplierBps);
    },
    async setDynamicRewardParams(thresholdEasy: bigint, dynamicMultiplierBps: bigint) {
      await fixture.rewardManager.connect(fixture.admin).setDynamicRewardParams(thresholdEasy, dynamicMultiplierBps);
    },
    async setLatePenaltyBps(latePenaltyBps: bigint) {
      await fixture.rewardManager.connect(fixture.admin).setLatePenaltyBps(latePenaltyBps);
    },
    async setLiquidationPenaltyBps(liquidationPenaltyBps: bigint) {
      await fixture.rewardManager.connect(fixture.admin).setLiquidationPenaltyBps(liquidationPenaltyBps);
    },
    async updateUserLevel(userAddress: string, level: bigint) {
      await fixture.rewardManager.connect(fixture.admin).updateUserLevel(userAddress, level);
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
      await fixture.rewardManager.connect(fixture.orderEngine).onLoanEventByOrderWithLender(
        params.borrowerAddress,
        params.lenderAddress,
        params.assetAddress,
        params.orderId,
        params.amountBaseUnits,
        params.maturity,
        params.outcome,
      );
    },
    async quoteLiquidationPenalty(userAddress: string) {
      return fixture.rewardManager.quoteLiquidationPenalty(userAddress) as Promise<bigint>;
    },
    async applyLiquidationPenalty(userAddress: string) {
      await fixture.rewardManager.connect(fixture.guaranteeFund).applyLiquidationPenalty(userAddress);
    },
    async applyManualPenalty(userAddress: string, amount: bigint) {
      await fixture.rewardAccrualManager.connect(fixture.guaranteeFund).applyPenaltyByGfm(userAddress, amount);
    },
    async readUserState(userAddress: string) {
      const signer = signerMap.get(userAddress) ?? fixture.admin;
      return readRewardState({
        rewardView: fixture.rewardView,
        rewardAccrualManager: fixture.rewardAccrualManager,
        easyToken: fixture.easyToken,
        signer,
        userAddress,
      });
    },
  };
}

export function describeRewardCommandModelSuite(title: string) {
  describe(title, function () {
    it("tracks multi-user concurrent lockedEasy and preserves borrower/lender penalty conservation across sequential settlements", async function () {
      const fixture = await loadFixture(deployFixture);
      const env = createFixtureEnv(fixture);
      await runRewardCommandScenario({
        scenario: buildConcurrentPenaltyOffsetScenario({
          asset: "rewardAsset",
          amountBaseUnits: ethers.parseUnits("1100", 18),
          maturity: 1000n,
          orderIdBase: 100n,
        }),
        env,
      });
    });

    it("handles interleaved late penalty and liquidation penalty across a long multi-mint offset sequence", async function () {
      const fixture = await loadFixture(deployFixture);
      const env = createFixtureEnv(fixture);
      await runRewardCommandScenario({
        scenario: buildInterleavedPenaltyLiquidationScenario({
          asset: "rewardAsset",
          amountBaseUnits: ethers.parseUnits("1100", 18),
          maturity: 1000n,
          orderIdBase: 300n,
        }),
        env,
      });
    });
  });
}
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import hardhat from "hardhat";
import type { RewardView } from "../../types/src/Vault/view/modules/RewardView.sol/RewardView";

const { ethers, upgrades } = hardhat;

describe("RewardView SSOT usage (Reward-System-Usage-Guide)", function () {
  const KEY_ACCESS_CONTROL = ethers.id("ACCESS_CONTROL_MANAGER");
  const KEY_ORDER_ENGINE = ethers.id("ORDER_ENGINE");
  const KEY_REWARD_MANAGER_CORE = ethers.id("REWARD_MANAGER_CORE");
  const KEY_REWARD_ACCRUAL_MANAGER = ethers.id("REWARD_ACCRUAL_MANAGER");
  const KEY_EASY_EMISSION_CONTROLLER = ethers.id("EASY_EMISSION_CONTROLLER");
  const KEY_EASY_EMISSION_CONFIG = ethers.id("EASY_EMISSION_CONFIG");
  const KEY_EASY_CONSUMPTION = ethers.id("EASY_CONSUMPTION");
  const KEY_EASY_RECYCLE_DISTRIBUTOR = ethers.id("EASY_RECYCLE_DISTRIBUTOR");
  const KEY_EASY_STAKING = ethers.id("EASY_STAKING");
  const ROLE_ADMIN = ethers.id("ACTION_ADMIN");

  const ROLE_VIEW_USER_DATA = ethers.id("VIEW_USER_DATA");
  const ROLE_VIEW_SYSTEM_DATA = ethers.id("VIEW_SYSTEM_DATA");

  async function fixture() {
    const [
      admin,
      orderEngine,
      rmWriter,
      ramWriter,
      ecWriter,
      econfWriter,
      econWriter,
      erdWriter,
      esWriter,
      alice,
      bob,
      ops,
    ] = await ethers.getSigners();

    const ACM = await ethers.getContractFactory("AccessControlManager");
    const acm: any = await ACM.deploy(admin.address);
    await acm.waitForDeployment();

    const MockRegistry = await ethers.getContractFactory("MockRegistry");
    const registry: any = await MockRegistry.deploy();
    await registry.waitForDeployment();

    const RewardViewF = await ethers.getContractFactory("RewardView");
    const rewardView = (await upgrades.deployProxy(RewardViewF, [registry.target], {
      kind: "uups",
      initializer: "initialize",
    })) as RewardView;

    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(KEY_ORDER_ENGINE, orderEngine.address);
    await registry.setModule(KEY_REWARD_MANAGER_CORE, rmWriter.address);
    await registry.setModule(KEY_REWARD_ACCRUAL_MANAGER, ramWriter.address);
    await registry.setModule(KEY_EASY_EMISSION_CONTROLLER, ecWriter.address);
    await registry.setModule(KEY_EASY_EMISSION_CONFIG, econfWriter.address);
    await registry.setModule(KEY_EASY_CONSUMPTION, econWriter.address);
    await registry.setModule(KEY_EASY_RECYCLE_DISTRIBUTOR, erdWriter.address);
    await registry.setModule(KEY_EASY_STAKING, esWriter.address);

    await acm.connect(admin).grantRole(ROLE_VIEW_USER_DATA, ops.address);
    await acm.connect(admin).grantRole(ROLE_VIEW_SYSTEM_DATA, ops.address);

    return {
      admin,
      orderEngine,
      rmWriter,
      ramWriter,
      ecWriter,
      econfWriter,
      econWriter,
      erdWriter,
      esWriter,
      alice,
      bob,
      ops,
      rewardView,
      acm,
    };
  }

  it("enforces RewardView writer whitelist and module-specific writers", async function () {
    const { rewardView, rmWriter, ramWriter, ecWriter, econfWriter, econWriter, erdWriter, esWriter, alice } =
      await loadFixture(fixture);

    await expect(
      rewardView.connect(alice).pushPenaltyLedger(alice.address, 1n, 1n),
    ).to.be.revertedWithCustomError(rewardView, "RewardView__UnauthorizedWriter");

    await expect(
      rewardView.connect(rmWriter).pushEarnState(alice.address, 1_000000000000000000n, 1n, 0n, 2n),
    ).to.not.be.reverted;

    await expect(
      rewardView.connect(ramWriter).pushPenaltyLedger(alice.address, 3n, 3n),
    ).to.not.be.reverted;

    const [lockedEasy, eligibleLoanCount, onTimeRepayCount] = await rewardView
      .connect(alice)
      .getUserEarnStateWithMeta(alice.address);
    expect(lockedEasy).to.equal(1_000000000000000000n);
    expect(eligibleLoanCount).to.equal(1n);
    expect(onTimeRepayCount).to.equal(0n);

    const [, pendingPenalty] = await rewardView.connect(alice).getUserRewardSummaryWithMeta(alice.address);
    expect(pendingPenalty).to.equal(3n);

    await expect(
      rewardView
        .connect(rmWriter)
        .pushEasyMinted(alice.address, alice.address, 10n, 5n, 5n, 1n, 1n, 10n),
    ).to.be.revertedWithCustomError(rewardView, "RewardView__UnauthorizedWriter");

    await expect(
      rewardView
        .connect(ecWriter)
        .pushEasyMinted(alice.address, alice.address, 10n, 5n, 5n, 1n, 1n, 10n),
    ).to.not.be.reverted;

    const [easyEarned] = await rewardView.connect(alice).getUserEasyEarnedWithMeta(alice.address);
    expect(easyEarned).to.equal(10n);

    await expect(
      rewardView.connect(econfWriter).pushEasyEmissionParamsUpdated(1n, 2n, 3n, 4n, 10n),
    ).to.not.be.reverted;

    await expect(rewardView.connect(econWriter).pushEasySpent(alice.address, 1, 7n, 9n)).to.not.be.reverted;

    await expect(
      rewardView.connect(erdWriter).pushEasyRecycledSplit(alice.address, 10n, 7n, 2n, 1n, 1, 9n),
    ).to.not.be.reverted;

    await expect(rewardView.connect(esWriter).pushEasyStaked(alice.address, 5n, 5n, 11n)).to.not.be.reverted;
    await expect(rewardView.connect(esWriter).pushEasyUnstaked(alice.address, 2n, 3n, 12n)).to.not.be.reverted;
  });

  it("allows self-read; non-self requires VIEW_USER_DATA or ACTION_ADMIN", async function () {
    const { rewardView, ramWriter, acm, admin, alice, bob } = await loadFixture(fixture);

    await rewardView.connect(ramWriter).pushPenaltyLedger(alice.address, 4n, 1n);

    await expect(rewardView.connect(alice).getUserRewardSummaryWithMeta(alice.address)).to.not.be.reverted;

    await expect(
      rewardView.connect(bob).getUserRewardSummaryWithMeta(alice.address),
    ).to.be.revertedWithCustomError(rewardView, "MissingRole");

    await acm.connect(admin).grantRole(ROLE_VIEW_USER_DATA, bob.address);

    await expect(rewardView.connect(bob).getUserRewardSummaryWithMeta(alice.address)).to.not.be.reverted;
  });

  it("restricts borrow-check read to OrderEngine", async function () {
    const { rewardView, rmWriter, orderEngine, alice, bob } = await loadFixture(fixture);

    await rewardView.connect(rmWriter).pushUserLevel(alice.address, 4, 10n);

    await expect(rewardView.connect(bob).getUserLevelForBorrowCheck(alice.address)).to.be.revertedWithCustomError(
      rewardView,
      "MissingRole",
    );

    await expect(rewardView.connect(orderEngine).getUserLevelForBorrowCheck(alice.address)).to.not.be.reverted;
  });

  it("gates system-level reads behind VIEW_SYSTEM_DATA or ADMIN", async function () {
    const { rewardView, econfWriter, bob, ops, admin } = await loadFixture(fixture);

    await rewardView.connect(econfWriter).pushEasyEmissionParamsUpdated(100n, 200n, 1n, 10n, 8n);

    await expect(rewardView.connect(bob).getEasyEmissionParamsWithMeta()).to.be.revertedWithCustomError(
      rewardView,
      "MissingRole",
    );

    await expect(rewardView.connect(ops).getEasyEmissionParamsWithMeta()).to.not.be.reverted;
    await expect(rewardView.connect(admin).getEasyEmissionParamsWithMeta()).to.not.be.reverted;
  });

  it("allows admin to replay penalty-ledger pushes and rejects non-admin callers", async function () {
    const { rewardView, admin, alice, bob } = await loadFixture(fixture);

    await expect(
      rewardView.connect(bob).retryPushPenaltyLedger(alice.address, 9n, 77n),
    ).to.be.revertedWithCustomError(rewardView, "MissingRole");

    await expect(rewardView.connect(admin).retryPushPenaltyLedger(alice.address, 9n, 77n)).to.not.be.reverted;

    const [, pendingPenalty, , lastActivity, blockNumber, isValid] = await rewardView
      .connect(admin)
      .getUserRewardSummaryWithMeta(alice.address);
    expect(pendingPenalty).to.equal(9n);
    expect(lastActivity).to.equal(77n);
    expect(blockNumber).to.be.greaterThan(0n);
    expect(isValid).to.equal(true);
  });
});

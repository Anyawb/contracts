import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import type { RewardAccrualManager } from "../../types/src/Reward/RewardAccrualManager";
import type { EasyToken } from "../../types/src/Token/EasyToken";
import type { RewardView } from "../../types/src/Vault/view/modules/RewardView.sol/RewardView";

// Comprehensive branch coverage for RewardAccrualManager.offsetPenaltyOnReward:
// - rewardAmount == 0 (early return, no role check)
// - debt == 0 (returns full rewardAmount, no push)
// - rewardAmount < debt (partial offset)
// - rewardAmount == debt (exact offset)
// - rewardAmount > debt (full offset + net remainder)
// - caller gate (only RMCore or EasyEmissionController)
// - best-effort push failure does not revert main flow

describe("Reward – RewardAccrualManager.offsetPenaltyOnReward boundary coverage", function () {
  const KEY_ACCESS_CONTROL = ethers.id("ACCESS_CONTROL_MANAGER");
  const KEY_REWARD_VIEW = ethers.id("REWARD_VIEW");
  const KEY_EASY_TOKEN = ethers.id("EASY_TOKEN");

  // RewardView writer keys (must all exist; RewardView.onlyWriter resolves all via Registry.getModuleOrRevert)
  const KEY_REWARD_MANAGER_CORE = ethers.id("REWARD_MANAGER_CORE");
  const KEY_EASY_EMISSION_CONTROLLER = ethers.id("EASY_EMISSION_CONTROLLER");
  const KEY_REWARD_ACCRUAL_MANAGER = ethers.id("REWARD_ACCRUAL_MANAGER");
  const KEY_EASY_STAKING = ethers.id("EASY_STAKING");
  const KEY_EASY_EMISSION_CONFIG = ethers.id("EASY_EMISSION_CONFIG");
  const KEY_EASY_CONSUMPTION = ethers.id("EASY_CONSUMPTION");
  const KEY_EASY_RECYCLE_DISTRIBUTOR = ethers.id("EASY_RECYCLE_DISTRIBUTOR");

  const DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED = ethers.id("REWARD_PENALTY_LEDGER_UPDATED");
  const DATA_PUSH_IFACE = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
  const DATA_PUSH_TOPIC0 = ethers.id("DataPushed(bytes32,bytes)").toLowerCase();
  const PUSH_FAILED_IFACE = new ethers.Interface([
    "event RewardViewPushFailed(address indexed user, address indexed rewardView, bytes32 indexed op, bytes payload, bytes reason)",
  ]);
  const REWARD_VIEW_UNAVAILABLE_BYTES = ethers.toUtf8Bytes("rewardView unavailable");

  function getDataPushes(receipt: any, emitter: string) {
    return receipt.logs
      .filter((log: any) => (log.topics?.[0] || "").toLowerCase() === DATA_PUSH_TOPIC0)
      .filter((log: any) => log.address.toLowerCase() === emitter.toLowerCase())
      .map((log: any) => {
        const parsed = DATA_PUSH_IFACE.parseLog(log);
        if (!parsed) throw new Error("failed to parse DataPushed log");
        return {
          dataTypeHash: (parsed.args.dataTypeHash as string).toLowerCase(),
          payload: parsed.args.payload as string,
        };
      });
  }

  function getRewardViewPushFailed(receipt: any, emitter: string) {
    return receipt.logs
      .filter((log: any) => log.address.toLowerCase() === emitter.toLowerCase())
      .map((log: any) => {
        try {
          const parsed = PUSH_FAILED_IFACE.parseLog(log);
          return parsed ? parsed.args : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  async function fixturePushOk() {
    const [admin, alice, rmc, ec, econf, es, econ, erd, outsider] = await ethers.getSigners();

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
    const rewardViewAddr = await rewardView.getAddress();

    const RewardAccrualManagerF = await ethers.getContractFactory("RewardAccrualManager");
    const rewardAccrualManager = (await upgrades.deployProxy(RewardAccrualManagerF, [registry.target], {
      kind: "uups",
      initializer: "initialize",
    })) as RewardAccrualManager;
    const rewardAccrualManagerAddr = await rewardAccrualManager.getAddress();

    const EasyTokenF = await ethers.getContractFactory("EasyToken");
    const easyToken = (await upgrades.deployProxy(EasyTokenF, [admin.address], {
      kind: "uups",
      initializer: "initialize",
    })) as EasyToken;
    const easyTokenAddr = await easyToken.getAddress();

    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(KEY_REWARD_VIEW, rewardViewAddr);
    await registry.setModule(KEY_EASY_TOKEN, easyTokenAddr);

    // RewardView writer keys
    await registry.setModule(KEY_REWARD_MANAGER_CORE, rmc.address);
    await registry.setModule(KEY_EASY_EMISSION_CONTROLLER, ec.address);
    await registry.setModule(KEY_REWARD_ACCRUAL_MANAGER, rewardAccrualManagerAddr);
    await registry.setModule(KEY_EASY_STAKING, es.address);
    await registry.setModule(KEY_EASY_EMISSION_CONFIG, econf.address);
    await registry.setModule(KEY_EASY_CONSUMPTION, econ.address);
    await registry.setModule(KEY_EASY_RECYCLE_DISTRIBUTOR, erd.address);

    return { admin, alice, rmc, ec, outsider, registry, rewardView, rewardAccrualManager, easyToken };
  }

  async function fixturePushFailsNoRewardView() {
    // Identical to fixturePushOk but intentionally does NOT set KEY_REWARD_VIEW,
    // to force RewardModuleBase._getRewardViewCached() to return address(0) and emit RewardViewPushFailed.
    const base = await fixturePushOk();
    await base.registry.setModule(KEY_REWARD_VIEW, ethers.ZeroAddress);
    return base;
  }

  async function seedDebtViaLatePenalty(opts: {
    rewardAccrualManager: any;
    rmc: any;
    user: string;
    amount: bigint;
  }) {
    // applyLateRepayPenalty uses _applyPenalty(); if burn fails, it goes to ledger.
    // We do NOT grant BURNER_ROLE to RewardAccrualManager here, so burn will revert and ledger will increase.
    const tx = await opts.rewardAccrualManager
      .connect(opts.rmc)
      .applyLateRepayPenalty(opts.user, opts.amount, opts.rmc.address);
    await tx.wait();
  }

  it("rewardAmount==0 returns 0 and skips role check (no revert for outsider)", async function () {
    const { rewardAccrualManager, outsider, alice } = await loadFixture(fixturePushOk);

    const net = await rewardAccrualManager.connect(outsider).offsetPenaltyOnReward.staticCall(alice.address, 0n, "zero");
    expect(net).to.equal(0n);

    const tx = await rewardAccrualManager.connect(outsider).offsetPenaltyOnReward(alice.address, 0n, "zero");
    await expect(tx).to.not.emit(rewardAccrualManager, "PenaltyOffsetApplied");
    await expect(tx).to.not.emit(rewardAccrualManager, "RewardViewPushFailed");
    await tx.wait();
    expect(await rewardAccrualManager.getPenaltyDebt(alice.address)).to.equal(0n);
  });

  it("rewardAmount==0 keeps existing debt unchanged and skips role check", async function () {
    const { rewardAccrualManager, outsider, rmc, alice } = await loadFixture(fixturePushOk);

    const debt = 33n;
    await seedDebtViaLatePenalty({ rewardAccrualManager, rmc, user: alice.address, amount: debt });
    expect(await rewardAccrualManager.getPenaltyDebt(alice.address)).to.equal(debt);

    const net = await rewardAccrualManager.connect(outsider).offsetPenaltyOnReward.staticCall(alice.address, 0n, "zero-with-debt");
    expect(net).to.equal(0n);

    const tx = await rewardAccrualManager.connect(outsider).offsetPenaltyOnReward(alice.address, 0n, "zero-with-debt");
    await expect(tx).to.not.emit(rewardAccrualManager, "PenaltyOffsetApplied");
    await expect(tx).to.not.emit(rewardAccrualManager, "RewardViewPushFailed");
    await tx.wait();

    expect(await rewardAccrualManager.getPenaltyDebt(alice.address)).to.equal(debt);
  });

  it("reverts for unauthorized caller when rewardAmount>0 (MissingRole)", async function () {
    const { rewardAccrualManager, outsider, alice } = await loadFixture(fixturePushOk);

    await expect(rewardAccrualManager.connect(outsider).offsetPenaltyOnReward(alice.address, 1n, "x")).to.be.revertedWithCustomError(
      rewardAccrualManager,
      "MissingRole"
    );
  });

  it("debt==0 returns full rewardAmount; no ledger push; no PenaltyOffsetApplied", async function () {
    const { rewardAccrualManager, rewardView, rmc, alice } = await loadFixture(fixturePushOk);

    const rewardAmount = 100n;

    const net = await rewardAccrualManager.connect(rmc).offsetPenaltyOnReward.staticCall(alice.address, rewardAmount, "no-debt");
    expect(net).to.equal(rewardAmount);

    const tx = await rewardAccrualManager.connect(rmc).offsetPenaltyOnReward(alice.address, rewardAmount, "no-debt");
    const rcpt = await tx.wait();
    if (!rcpt) throw new Error("missing receipt");

    expect(await rewardAccrualManager.getPenaltyDebt(alice.address)).to.equal(0n);

    const pushes = getDataPushes(rcpt, await rewardView.getAddress());
    const hasPenaltyLedgerPush = pushes.some(
      (p) => p.dataTypeHash === DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED.toLowerCase()
    );
    expect(hasPenaltyLedgerPush).to.equal(false);

    const summary = await rewardView.connect(alice).getUserRewardSummaryWithMeta(alice.address);
    const pendingPenalty = summary[1] as bigint;
    expect(pendingPenalty).to.equal(0n);

    await expect(tx).to.not.emit(rewardAccrualManager, "PenaltyOffsetApplied");
  });

  it("partial offset (rewardAmount < debt): remainingDebt decreases; net=0; emits DataPushed(REWARD_PENALTY_LEDGER_UPDATED)", async function () {
    const { rewardAccrualManager, rewardView, rmc, alice } = await loadFixture(fixturePushOk);

    const debt = 80n;
    await seedDebtViaLatePenalty({ rewardAccrualManager, rmc, user: alice.address, amount: debt });
    expect(await rewardAccrualManager.getPenaltyDebt(alice.address)).to.equal(debt);

    const rewardAmount = 30n;
    const net = await rewardAccrualManager.connect(rmc).offsetPenaltyOnReward.staticCall(alice.address, rewardAmount, "partial");
    expect(net).to.equal(0n);

    const tx = await rewardAccrualManager.connect(rmc).offsetPenaltyOnReward(alice.address, rewardAmount, "partial");
    const rcpt = await tx.wait();
    if (!rcpt) throw new Error("missing receipt");

    const remaining = debt - rewardAmount;
    expect(await rewardAccrualManager.getPenaltyDebt(alice.address)).to.equal(remaining);

    await expect(tx)
      .to.emit(rewardAccrualManager, "PenaltyOffsetApplied")
      .withArgs(ethers.id("CLAIM_REWARD"), alice.address, rewardAmount, remaining, "partial", rmc.address, anyValue);

    const pushes = getDataPushes(rcpt, await rewardView.getAddress());
    const match = pushes.find((p) => p.dataTypeHash === DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED.toLowerCase());
    expect(match, "missing penalty-ledger DataPushed").to.not.be.undefined;

    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["address", "uint256", "uint256"], (match as any).payload);
    expect(decoded[0]).to.equal(alice.address);
    expect(decoded[1]).to.equal(remaining);
    expect(decoded[2]).to.equal(BigInt(rcpt.blockNumber));

    const summary = await rewardView.connect(alice).getUserRewardSummaryWithMeta(alice.address);
    const pendingPenalty = summary[1] as bigint;
    expect(pendingPenalty).to.equal(remaining);
  });

  it("exact offset (rewardAmount == debt): remainingDebt=0; net=0; pushes ledger 0", async function () {
    const { rewardAccrualManager, rewardView, rmc, alice } = await loadFixture(fixturePushOk);

    const debt = 50n;
    await seedDebtViaLatePenalty({ rewardAccrualManager, rmc, user: alice.address, amount: debt });

    const net = await rewardAccrualManager.connect(rmc).offsetPenaltyOnReward.staticCall(alice.address, debt, "exact");
    expect(net).to.equal(0n);

    const tx = await rewardAccrualManager.connect(rmc).offsetPenaltyOnReward(alice.address, debt, "exact");
    const rcpt = await tx.wait();
    if (!rcpt) throw new Error("missing receipt");

    expect(await rewardAccrualManager.getPenaltyDebt(alice.address)).to.equal(0n);

    await expect(tx)
      .to.emit(rewardAccrualManager, "PenaltyOffsetApplied")
      .withArgs(ethers.id("CLAIM_REWARD"), alice.address, debt, 0n, "exact", rmc.address, anyValue);

    const pushes = getDataPushes(rcpt, await rewardView.getAddress());
    const match = pushes.find((p) => p.dataTypeHash === DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED.toLowerCase());
    expect(match, "missing penalty-ledger DataPushed").to.not.be.undefined;

    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["address", "uint256", "uint256"], (match as any).payload);
    expect(decoded[0]).to.equal(alice.address);
    expect(decoded[1]).to.equal(0n);

    const summary = await rewardView.connect(alice).getUserRewardSummaryWithMeta(alice.address);
    const pendingPenalty = summary[1] as bigint;
    expect(pendingPenalty).to.equal(0n);
  });

  it("full offset with remainder (rewardAmount > debt): remainingDebt=0; net = rewardAmount-debt", async function () {
    const { rewardAccrualManager, rewardView, rmc, ec, alice } = await loadFixture(fixturePushOk);

    const debt = 40n;
    // seed debt via RMCore (applyLateRepayPenalty is RMCore-only)
    await seedDebtViaLatePenalty({ rewardAccrualManager, rmc, user: alice.address, amount: debt });

    const rewardAmount = 100n;
    const net = await rewardAccrualManager.connect(ec).offsetPenaltyOnReward.staticCall(alice.address, rewardAmount, "remainder");
    expect(net).to.equal(rewardAmount - debt);

    const tx = await rewardAccrualManager.connect(ec).offsetPenaltyOnReward(alice.address, rewardAmount, "remainder");
    const rcpt = await tx.wait();
    if (!rcpt) throw new Error("missing receipt");

    expect(await rewardAccrualManager.getPenaltyDebt(alice.address)).to.equal(0n);

    await expect(tx)
      .to.emit(rewardAccrualManager, "PenaltyOffsetApplied")
      .withArgs(ethers.id("CLAIM_REWARD"), alice.address, debt, 0n, "remainder", ec.address, anyValue);

    const pushes = getDataPushes(rcpt, await rewardView.getAddress());
    const match = pushes.find((p) => p.dataTypeHash === DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED.toLowerCase());
    expect(match, "missing penalty-ledger DataPushed").to.not.be.undefined;

    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["address", "uint256", "uint256"], (match as any).payload);
    expect(decoded[0]).to.equal(alice.address);
    expect(decoded[1]).to.equal(0n);
    expect(decoded[2]).to.equal(BigInt(rcpt.blockNumber));

    const summary = await rewardView.connect(alice).getUserRewardSummaryWithMeta(alice.address);
    const pendingPenalty = summary[1] as bigint;
    expect(pendingPenalty).to.equal(0n);
  });

  it("multiple penalty ledger pushes in same tx use the last payload as final state", async function () {
    const { rewardAccrualManager, rewardView, rmc, registry, alice } = await loadFixture(fixturePushOk);

    const debt = 100n;
    await seedDebtViaLatePenalty({ rewardAccrualManager, rmc, user: alice.address, amount: debt });

    const BatchCallerF = await ethers.getContractFactory("MockRewardAccrualBatchCaller");
    const batchCaller = await BatchCallerF.deploy();
    await batchCaller.waitForDeployment();

    // Allow batch caller to act as RewardManagerCore for offset calls.
    await registry.setModule(KEY_REWARD_MANAGER_CORE, await batchCaller.getAddress());

    const amount1 = 30n;
    const amount2 = 20n;
    const expectedRemaining = debt - amount1 - amount2;

    const tx = await batchCaller.offsetTwice(
      await rewardAccrualManager.getAddress(),
      alice.address,
      amount1,
      amount2,
      "first",
      "second"
    );
    const rcpt = await tx.wait();
    if (!rcpt) throw new Error("missing receipt");

    const pushes = getDataPushes(rcpt, await rewardView.getAddress()).filter(
      (p) => p.dataTypeHash === DATA_TYPE_REWARD_PENALTY_LEDGER_UPDATED.toLowerCase()
    );
    expect(pushes.length).to.equal(2);

    const last = pushes[pushes.length - 1];
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["address", "uint256", "uint256"], last.payload);
    expect(decoded[0]).to.equal(alice.address);
    expect(decoded[1]).to.equal(expectedRemaining);

    const summary = await rewardView.connect(alice).getUserRewardSummaryWithMeta(alice.address);
    const pendingPenalty = summary[1] as bigint;
    expect(pendingPenalty).to.equal(expectedRemaining);
  });

  it("best-effort: missing RewardView does not revert; emits RewardViewPushFailed(rewardView==0)", async function () {
    const { rewardAccrualManager, rmc, alice } = await loadFixture(fixturePushFailsNoRewardView);

    const debt = 25n;
    await seedDebtViaLatePenalty({ rewardAccrualManager, rmc, user: alice.address, amount: debt });

    // debt offset triggers a push attempt; with KEY_REWARD_VIEW=0 it becomes rewardView unavailable.
    const tx = await rewardAccrualManager.connect(rmc).offsetPenaltyOnReward(alice.address, 10n, "no-rv");
    const rcpt = await tx.wait();
    if (!rcpt) throw new Error("missing receipt");

    await expect(tx)
      .to.emit(rewardAccrualManager, "RewardViewPushFailed")
      .withArgs(alice.address, ethers.ZeroAddress, ethers.id("PENALTY_LEDGER"), anyValue, anyValue);

    const events = getRewardViewPushFailed(rcpt, await rewardAccrualManager.getAddress());
    expect(events.length).to.equal(1);
    const reasonBytes = events[0].reason as string;
    const reasonHex = ethers.hexlify(ethers.getBytes(reasonBytes));
    const expectedHex = ethers.hexlify(REWARD_VIEW_UNAVAILABLE_BYTES);
    expect(reasonHex).to.equal(expectedHex);

    // main flow still succeeds
    expect(await rewardAccrualManager.getPenaltyDebt(alice.address)).to.equal(15n);
  });
});

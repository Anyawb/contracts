import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("LiquidationManager (Scheme A) - failure & edge scenarios", function () {
  const KEY_ACCESS_CONTROL = ethers.id("ACCESS_CONTROL_MANAGER");
  const KEY_CM = ethers.id("COLLATERAL_MANAGER");
  const KEY_LE = ethers.id("LENDING_ENGINE");
  const KEY_LIQUIDATION_MANAGER = ethers.id("LIQUIDATION_MANAGER");
  const KEY_LIQUIDATION_VIEW = ethers.id("LIQUIDATION_VIEW");
  const KEY_LIQUIDATION_PAYOUT_MANAGER = ethers.id("LIQUIDATION_PAYOUT_MANAGER");

  // Keep consistent with most mocks in this repo
  const ACTION_LIQUIDATE = ethers.id("LIQUIDATE");

  async function deployFixture() {
    const [admin, liquidator, user] = await ethers.getSigners();
    const asset = ethers.Wallet.createRandom().address;

    const registry = await (await ethers.getContractFactory("MockRegistry")).deploy();
    const access = await (await ethers.getContractFactory("MockAccessControlManager")).deploy();
    const collateral = await (await ethers.getContractFactory("MockCollateralManager")).deploy();
    const lending = await (await ethers.getContractFactory("MockLendingEngineBasic")).deploy();

    const eventsView = await (await ethers.getContractFactory("MockLiquidationEventsView")).deploy();
    const revertingView = await (await ethers.getContractFactory("RevertingLiquidationEventsView")).deploy();
    const payoutRecipients = {
      platform: admin.address,
      reserve: admin.address,
      lenderCompensation: admin.address,
    };
    const payoutRates = {
      platformBps: 1000,
      reserveBps: 2000,
      lenderBps: 2000,
      liquidatorBps: 5000,
    };

    const liquidationPayoutManagerFactory = await ethers.getContractFactory("LiquidationPayoutManager");
    const payoutManager = await upgrades.deployProxy(
      liquidationPayoutManagerFactory,
      [await registry.getAddress(), admin.address, payoutRecipients, payoutRates],
      { kind: "uups" },
    );
    await payoutManager.waitForDeployment();

    const liquidationManagerFactory = await ethers.getContractFactory("LiquidationManager");
    const liquidationManager = await upgrades.deployProxy(liquidationManagerFactory, [await registry.getAddress()], {
      kind: "uups",
      initializer: "initialize",
      unsafeAllow: ["constructor"],
    });
    await liquidationManager.waitForDeployment();

    // Registry bindings
    await registry.setModule(KEY_ACCESS_CONTROL, await access.getAddress());
    await registry.setModule(KEY_CM, await collateral.getAddress());
    await registry.setModule(KEY_LE, await lending.getAddress());
    await registry.setModule(KEY_LIQUIDATION_VIEW, await eventsView.getAddress());
    await registry.setModule(KEY_LIQUIDATION_PAYOUT_MANAGER, await payoutManager.getAddress());
    await registry.setModule(KEY_LIQUIDATION_MANAGER, await liquidationManager.getAddress());

    // Roles:
    // - external liquidator must have ACTION_LIQUIDATE (LiquidationManager checks caller)
    // - LiquidationManager itself must have ACTION_LIQUIDATE (LendingEngine/CM may check msg.sender)
    await access.grantRole(ACTION_LIQUIDATE, liquidator.address);
    await access.grantRole(ACTION_LIQUIDATE, await liquidationManager.getAddress());

    // Seed ledger state
    await collateral.depositCollateral(user.address, asset, 100n);
    await lending.borrow(user.address, asset, 80n, 0n, 0);
    // Ensure ledger aggregate matches mock expectations to avoid underflow/panic
    await lending.setTotalDebtByAsset(asset, 80n);

    return {
      admin,
      liquidator,
      user,
      asset,
      registry,
      access,
      collateral,
      lending,
      eventsView,
      revertingView,
      liquidationManager,
    };
  }

  it("reverts atomically if debt reduction fails (no collateral seized)", async function () {
    const { liquidationManager, liquidator, user, asset, collateral, lending } = await loadFixture(deployFixture);

    const beforeCollateral = await collateral.getCollateral(user.address, asset);
    const beforeDebt = await lending.getDebt(user.address, asset);

    await expect(
      liquidationManager.connect(liquidator).liquidate(user.address, asset, asset, 50n, beforeDebt + 1n, 0n),
    ).to.be.revertedWith("Insufficient debt");

    expect(await collateral.getCollateral(user.address, asset)).to.equal(beforeCollateral);
    expect(await lending.getDebt(user.address, asset)).to.equal(beforeDebt);
  });

  it("does NOT revert if view push fails (best-effort); emits CacheUpdateFailed", async function () {
    const { liquidationManager, registry, revertingView, liquidator, user, asset, collateral, lending } =
      await loadFixture(deployFixture);

    await registry.setModule(KEY_LIQUIDATION_VIEW, await revertingView.getAddress());

    const beforeCollateral = await collateral.getCollateral(user.address, asset);
    const beforeDebt = await lending.getDebt(user.address, asset);

    await expect(liquidationManager.connect(liquidator).liquidate(user.address, asset, asset, 30n, 30n, 0n))
      .to.emit(liquidationManager, "CacheUpdateFailed");

    expect(await collateral.getCollateral(user.address, asset)).to.equal(beforeCollateral - 30n);
    expect(await lending.getDebt(user.address, asset)).to.equal(beforeDebt - 30n);
  });

  it("prevents unauthorized liquidation callers (MissingRole from ACM)", async function () {
    const { liquidationManager, access, user, asset } = await loadFixture(deployFixture);

    await expect(liquidationManager.connect(user).liquidate(user.address, asset, asset, 10n, 10n, 0n))
      .to.be.revertedWithCustomError(access, "MissingRole");
  });

  it("rejects zero-address params", async function () {
    const { liquidationManager, liquidator, user, asset } = await loadFixture(deployFixture);

    await expect(liquidationManager.connect(liquidator).liquidate(ethers.ZeroAddress, asset, asset, 10n, 10n, 0n))
      .to.be.revertedWithCustomError(liquidationManager, "ZeroAddress");

    await expect(liquidationManager.connect(liquidator).liquidate(user.address, ethers.ZeroAddress, asset, 10n, 10n, 0n))
      .to.be.revertedWithCustomError(liquidationManager, "ZeroAddress");

    await expect(liquidationManager.connect(liquidator).liquidate(user.address, asset, ethers.ZeroAddress, 10n, 10n, 0n))
      .to.be.revertedWithCustomError(liquidationManager, "ZeroAddress");
  });

  it("rejects zero amounts", async function () {
    const { liquidationManager, liquidator, user, asset } = await loadFixture(deployFixture);

    await expect(liquidationManager.connect(liquidator).liquidate(user.address, asset, asset, 0n, 10n, 0n))
      .to.be.revertedWithCustomError(liquidationManager, "AmountIsZero");

    await expect(liquidationManager.connect(liquidator).liquidate(user.address, asset, asset, 10n, 0n, 0n))
      .to.be.revertedWithCustomError(liquidationManager, "AmountIsZero");
  });

  it("reverts when collateral is insufficient", async function () {
    const { liquidationManager, liquidator, user, asset, collateral } = await loadFixture(deployFixture);

    const availableCollateral = await collateral.getCollateral(user.address, asset);
    await expect(liquidationManager.connect(liquidator).liquidate(user.address, asset, asset, availableCollateral + 1n, 10n, 0n))
      .to.be.revertedWith("Insufficient collateral");
  });

  it("reverts when CM or LE missing in registry (ledger writes must not proceed)", async function () {
    const { liquidationManager, registry, liquidator, user, asset } = await loadFixture(deployFixture);

    await registry.setModule(KEY_CM, ethers.ZeroAddress);
    await expect(liquidationManager.connect(liquidator).liquidate(user.address, asset, asset, 10n, 10n, 0n)).to.be.reverted;

    await registry.setModule(KEY_CM, ethers.Wallet.createRandom().address);
    await registry.setModule(KEY_LE, ethers.ZeroAddress);
    await expect(liquidationManager.connect(liquidator).liquidate(user.address, asset, asset, 10n, 10n, 0n)).to.be.reverted;
  });

  it("does NOT revert when liquidation view missing; emits CacheUpdateFailed and continues", async function () {
    const { liquidationManager, registry, liquidator, user, asset, collateral, lending, eventsView } =
      await loadFixture(deployFixture);

    await registry.setModule(KEY_LIQUIDATION_VIEW, ethers.ZeroAddress);

    const beforeCollateral = await collateral.getCollateral(user.address, asset);
    const beforeDebt = await lending.getDebt(user.address, asset);
    const beforeCount = await eventsView.getUserLiquidationCount(user.address);

    await expect(liquidationManager.connect(liquidator).liquidate(user.address, asset, asset, 20n, 20n, 0n))
      .to.emit(liquidationManager, "CacheUpdateFailed");

    expect(await collateral.getCollateral(user.address, asset)).to.equal(beforeCollateral - 20n);
    expect(await lending.getDebt(user.address, asset)).to.equal(beforeDebt - 20n);
    // View wasn't available, so mock view shouldn't have counted it
    expect(await eventsView.getUserLiquidationCount(user.address)).to.equal(beforeCount);
  });

  it("success path updates ledger and pushes to view", async function () {
    const { liquidationManager, liquidator, user, asset, collateral, lending, eventsView } = await loadFixture(deployFixture);

    const beforeCollateral = await collateral.getCollateral(user.address, asset);
    const beforeDebt = await lending.getDebt(user.address, asset);

    await expect(liquidationManager.connect(liquidator).liquidate(user.address, asset, asset, 30n, 30n, 5n))
      .to.not.be.reverted;

    expect(await collateral.getCollateral(user.address, asset)).to.equal(beforeCollateral - 30n);
    expect(await lending.getDebt(user.address, asset)).to.equal(beforeDebt - 30n);
    expect(await eventsView.getUserLiquidationCount(user.address)).to.equal(1n);
    expect(await eventsView.getLiquidatorTotalBonus(liquidator.address)).to.equal(5n);
  });

  it("ARCH 4.10 LQ-01: liquidation DataPushed is emitted only by LiquidatorView (single point, no duplicates)", async function () {
    const { liquidationManager, liquidator, user, asset, registry, access } = await loadFixture(deployFixture);

    // Swap the liquidation view implementation to the real LiquidatorView, so the liquidation flow
    // calls LiquidatorView.push* and emits DataPushed from the view contract itself.
    const LiquidatorViewF = await ethers.getContractFactory("LiquidatorView");
    const liquidatorView = await upgrades.deployProxy(
      LiquidatorViewF,
      [await registry.getAddress(), ethers.ZeroAddress],
      { kind: "uups" },
    );
    await liquidatorView.waitForDeployment();
    await registry.setModule(ethers.id("LIQUIDATION_VIEW"), await liquidatorView.getAddress());

    // Ensure role key is consistent with other tests (LiquidationManager checks caller in ACM).
    const ACTION_LIQUIDATE = ethers.id("LIQUIDATE");
    await access.grantRole(ACTION_LIQUIDATE, liquidator.address);

    const tx = await liquidationManager.connect(liquidator).liquidate(user.address, asset, asset, 30n, 30n, 5n);
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt!.blockNumber!);

    // DataPushed(bytes32 indexed dataTypeHash, bytes payload)
    const DATA_PUSH_TOPIC0 = ethers.id("DataPushed(bytes32,bytes)");
    const TYPE_LIQUIDATION_UPDATE = ethers.id("LIQUIDATION_UPDATE");
    const TYPE_LIQUIDATION_PAYOUT = ethers.id("LIQUIDATION_PAYOUT");

    const dataPushLogs = receipt!.logs.filter((l) => l.topics?.[0] === DATA_PUSH_TOPIC0);

    // There should be exactly one LIQUIDATION_UPDATE and one LIQUIDATION_PAYOUT, and both must come from LiquidatorView.
    const counts: Record<string, number> = {};
    for (const l of dataPushLogs) {
      expect(l.address).to.equal(await liquidatorView.getAddress());
      const t = l.topics[1]!.toLowerCase();
      counts[t] = (counts[t] ?? 0) + 1;
    }
    expect(counts[TYPE_LIQUIDATION_UPDATE.toLowerCase()] ?? 0).to.equal(1);
    expect(counts[TYPE_LIQUIDATION_PAYOUT.toLowerCase()] ?? 0).to.equal(1);

    // Decode and assert payloads so we don't accidentally accept duplicate/mis-typed pushes.
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const updateLog = dataPushLogs.find((l) => l.topics[1]!.toLowerCase() === TYPE_LIQUIDATION_UPDATE.toLowerCase())!;
    const payoutLog = dataPushLogs.find((l) => l.topics[1]!.toLowerCase() === TYPE_LIQUIDATION_PAYOUT.toLowerCase())!;

    const updatePayload: string = abiCoder.decode(["bytes"], updateLog.data)[0];
    const [
      uUser,
      uCollateralAsset,
      uDebtAsset,
      uCollateralAmount,
      uDebtAmount,
      uLiquidator,
      uBonus,
      uTimestamp,
    ] = abiCoder.decode(
      ["address", "address", "address", "uint256", "uint256", "address", "uint256", "uint256"],
      updatePayload,
    );
    expect(uUser).to.equal(user.address);
    expect(uCollateralAsset).to.equal(asset);
    expect(uDebtAsset).to.equal(asset);
    expect(uCollateralAmount).to.equal(30n);
    expect(uDebtAmount).to.equal(30n);
    expect(uLiquidator).to.equal(liquidator.address);
    expect(uBonus).to.equal(5n);
    expect(uTimestamp).to.equal(BigInt(block!.timestamp));

    const payoutPayload: string = abiCoder.decode(["bytes"], payoutLog.data)[0];
    const [
      pUser,
      pCollateralAsset,
      pPlatform,
      pReserve,
      pLender,
      pLiquidator,
      pPlatformShare,
      pReserveShare,
      pLenderShare,
      pLiquidatorShare,
      pTimestamp,
    ] = abiCoder.decode(
      ["address", "address", "address", "address", "address", "address", "uint256", "uint256", "uint256", "uint256", "uint256"],
      payoutPayload,
    );

    // Recipients are all admin in this fixture; shares are derived from payoutRates in deployFixture.
    expect(pUser).to.equal(user.address);
    expect(pCollateralAsset).to.equal(asset);
    expect(pLiquidator).to.equal(liquidator.address);
    expect(pPlatformShare).to.equal(3n); // 30 * 1000 / 10000
    expect(pReserveShare).to.equal(6n); // 30 * 2000 / 10000
    expect(pLenderShare).to.equal(6n); // 30 * 2000 / 10000
    expect(pLiquidatorShare).to.equal(15n); // remainder
    expect(pTimestamp).to.equal(BigInt(block!.timestamp));

    // Permission semantics: no view-role mixing here; push is strictly initiated by LiquidationManager via registry wiring.
    pPlatform; pReserve; pLender;
  });
});


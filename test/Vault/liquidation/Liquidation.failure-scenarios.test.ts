import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("VaultBusinessLogic - 清算失败路径", () => {
  const KEY_ACCESS_CONTROL = ethers.id("ACCESS_CONTROL_MANAGER");
  const KEY_CM = ethers.id("COLLATERAL_MANAGER");
  const KEY_LE = ethers.id("LENDING_ENGINE");
  const KEY_LIQUIDATION_VIEW = ethers.id("LIQUIDATION_VIEW");
  const ACTION_LIQUIDATE = ethers.id("LIQUIDATE");

  async function deployFixture() {
    const [admin, liquidator, user] = await ethers.getSigners();
    const asset = ethers.Wallet.createRandom().address;

    const Registry = await ethers.getContractFactory("MockRegistry");
    const registry = await Registry.deploy();

    const Access = await ethers.getContractFactory("MockAccessControlManager");
    const access = await Access.deploy();
    await access.grantRole(ACTION_LIQUIDATE, liquidator.address);

    const Collateral = await ethers.getContractFactory("MockCollateralManager");
    const collateral = await Collateral.deploy();

    const Lending = await ethers.getContractFactory("MockLendingEngineBasic");
    const lending = await Lending.deploy();

    const EventsView = await ethers.getContractFactory("MockLiquidationEventsView");
    const eventsView = await EventsView.deploy();

    const RevertingView = await ethers.getContractFactory("RevertingLiquidationEventsView");
    const revertingView = await RevertingView.deploy();

    const Token = await ethers.getContractFactory("MockERC20");
    const settlementToken = await Token.deploy("Settlement Token", "SET", 0);

    await registry.setModule(KEY_ACCESS_CONTROL, await access.getAddress());
    await registry.setModule(KEY_CM, await collateral.getAddress());
    await registry.setModule(KEY_LE, await lending.getAddress());
    await registry.setModule(KEY_LIQUIDATION_VIEW, await eventsView.getAddress());

    const VaultBusinessLogic = await ethers.getContractFactory("VaultBusinessLogic");
    const vbl = await upgrades.deployProxy(
      VaultBusinessLogic,
      [await registry.getAddress(), await settlementToken.getAddress()],
      { kind: "uups" }
    );

    await collateral.depositCollateral(user.address, asset, 100n);
    await lending.borrow(user.address, asset, 80n, 0n, 0);

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
      vbl,
    };
  }

  it("应在扣押成功但减债失败时整体回滚", async () => {
    const { vbl, liquidator, user, asset, collateral, lending } = await loadFixture(deployFixture);

    const beforeCollateral = await collateral.getCollateral(user.address, asset);
    const beforeDebt = await lending.getDebt(user.address, asset);

    await expect(
      vbl
        .connect(liquidator)
        .liquidate(user.address, asset, asset, 50n, beforeDebt + 1n, 0)
    ).to.be.revertedWith("Insufficient debt");

    expect(await collateral.getCollateral(user.address, asset)).to.equal(beforeCollateral);
    expect(await lending.getDebt(user.address, asset)).to.equal(beforeDebt);
  });

  it("应在事件推送失败时回滚减债与扣押", async () => {
    const { vbl, registry, revertingView, liquidator, user, asset, collateral, lending } =
      await loadFixture(deployFixture);

    await registry.setModule(KEY_LIQUIDATION_VIEW, await revertingView.getAddress());

    const beforeCollateral = await collateral.getCollateral(user.address, asset);
    const beforeDebt = await lending.getDebt(user.address, asset);

    await expect(
      vbl.connect(liquidator).liquidate(user.address, asset, asset, 30n, 30n, 0)
    ).to.be.revertedWithCustomError(
      revertingView,
      "RevertingLiquidationEventsView__ForcedRevert"
    );

    expect(await collateral.getCollateral(user.address, asset)).to.equal(beforeCollateral);
    expect(await lending.getDebt(user.address, asset)).to.equal(beforeDebt);
  });

  it("应防止同一用户的并发清算导致重复事件或异常状态", async () => {
    const { vbl, eventsView, liquidator, user, asset, collateral, lending } =
      await loadFixture(deployFixture);

    await vbl.connect(liquidator).liquidate(user.address, asset, asset, 30n, 30n, 0);

    const afterFirstCollateral = await collateral.getCollateral(user.address, asset);
    const afterFirstDebt = await lending.getDebt(user.address, asset);

    await expect(
      vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, afterFirstDebt + 1n, 0)
    ).to.be.revertedWith("Insufficient debt");

    expect(await eventsView.getUserLiquidationCount(user.address)).to.equal(1n);
    expect(await collateral.getCollateral(user.address, asset)).to.equal(afterFirstCollateral);
    expect(await lending.getDebt(user.address, asset)).to.equal(afterFirstDebt);
  });

  describe("权限与参数验证", () => {
    it("非清算人调用应被拒绝", async () => {
      const { vbl, access, user, asset } = await loadFixture(deployFixture);

      await expect(
        vbl.connect(user).liquidate(user.address, asset, asset, 10n, 10n, 0)
      ).to.be.revertedWithCustomError(access, "MissingRole");
    });

    it("零地址参数应被拒绝", async () => {
      const { vbl, liquidator, user, asset } = await loadFixture(deployFixture);

      await expect(
        vbl.connect(liquidator).liquidate(ethers.ZeroAddress, asset, asset, 10n, 10n, 0)
      ).to.be.revertedWithCustomError(vbl, "ZeroAddress");

      await expect(
        vbl.connect(liquidator).liquidate(user.address, ethers.ZeroAddress, asset, 10n, 10n, 0)
      ).to.be.revertedWithCustomError(vbl, "ZeroAddress");

      await expect(
        vbl.connect(liquidator).liquidate(user.address, asset, ethers.ZeroAddress, 10n, 10n, 0)
      ).to.be.revertedWithCustomError(vbl, "ZeroAddress");
    });

    it("零金额应被拒绝", async () => {
      const { vbl, liquidator, user, asset } = await loadFixture(deployFixture);

      await expect(
        vbl.connect(liquidator).liquidate(user.address, asset, asset, 0n, 10n, 0)
      ).to.be.revertedWithCustomError(vbl, "AmountIsZero");

      await expect(
        vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, 0n, 0)
      ).to.be.revertedWithCustomError(vbl, "AmountIsZero");
    });
  });

  describe("扣押失败场景", () => {
    it("抵押不足时应回滚", async () => {
      const { vbl, liquidator, user, asset, collateral, lending } = await loadFixture(deployFixture);

      const availableCollateral = await collateral.getCollateral(user.address, asset);
      const beforeCollateral = availableCollateral;
      const beforeDebt = await lending.getDebt(user.address, asset);

      await expect(
        vbl.connect(liquidator).liquidate(user.address, asset, asset, availableCollateral + 1n, 10n, 0)
      ).to.be.revertedWith("Insufficient collateral");

      expect(await collateral.getCollateral(user.address, asset)).to.equal(beforeCollateral);
      expect(await lending.getDebt(user.address, asset)).to.equal(beforeDebt);
    });

    it("扣押失败时不应影响债务", async () => {
      const { vbl, liquidator, user, asset, collateral, lending } = await loadFixture(deployFixture);

      const availableCollateral = await collateral.getCollateral(user.address, asset);
      const beforeDebt = await lending.getDebt(user.address, asset);

      await expect(
        vbl.connect(liquidator).liquidate(user.address, asset, asset, availableCollateral + 1n, 20n, 0)
      ).to.be.reverted;

      expect(await lending.getDebt(user.address, asset)).to.equal(beforeDebt);
    });
  });

  describe("模块缺失场景", () => {
    it("CollateralManager 未注册时应回滚", async () => {
      const { vbl, registry, liquidator, user, asset } = await loadFixture(deployFixture);

      await registry.setModule(KEY_CM, ethers.ZeroAddress);

      await expect(
        vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, 10n, 0)
      ).to.be.reverted;
    });

    it("LendingEngine 未注册时应回滚", async () => {
      const { vbl, registry, liquidator, user, asset } = await loadFixture(deployFixture);

      await registry.setModule(KEY_LE, ethers.ZeroAddress);

      await expect(
        vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, 10n, 0)
      ).to.be.reverted;
    });

    it("LiquidationView 未注册时应回滚", async () => {
      const { vbl, registry, liquidator, user, asset } = await loadFixture(deployFixture);

      await registry.setModule(KEY_LIQUIDATION_VIEW, ethers.ZeroAddress);

      await expect(
        vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, 10n, 0)
      ).to.be.reverted;
    });
  });

  describe("成功清算后的状态验证", () => {
    it("成功清算后应正确更新抵押和债务", async () => {
      const { vbl, liquidator, user, asset, collateral, lending, eventsView } =
        await loadFixture(deployFixture);

      const beforeCollateral = await collateral.getCollateral(user.address, asset);
      const beforeDebt = await lending.getDebt(user.address, asset);
      const seizeAmount = 30n;
      const reduceAmount = 30n;

      await vbl.connect(liquidator).liquidate(user.address, asset, asset, seizeAmount, reduceAmount, 0);

      const afterCollateral = await collateral.getCollateral(user.address, asset);
      const afterDebt = await lending.getDebt(user.address, asset);

      expect(afterCollateral).to.equal(beforeCollateral - seizeAmount);
      expect(afterDebt).to.equal(beforeDebt - reduceAmount);
      expect(await eventsView.getUserLiquidationCount(user.address)).to.equal(1n);
    });

    it("成功清算后应发出事件", async () => {
      const { vbl, liquidator, user, asset, eventsView } = await loadFixture(deployFixture);

      const seizeAmount = 20n;
      const reduceAmount = 20n;
      const bonus = 1n;

      await vbl.connect(liquidator).liquidate(user.address, asset, asset, seizeAmount, reduceAmount, bonus);

      expect(await eventsView.getUserLiquidationCount(user.address)).to.equal(1n);
      expect(await eventsView.getLiquidatorTotalBonus(liquidator.address)).to.equal(bonus);
    });
  });

  describe("部分清算场景", () => {
    it("部分清算后应允许继续清算剩余部分", async () => {
      const { vbl, liquidator, user, asset, collateral, lending, eventsView } =
        await loadFixture(deployFixture);

      const initialCollateral = await collateral.getCollateral(user.address, asset);
      const initialDebt = await lending.getDebt(user.address, asset);

      // 第一次部分清算
      await vbl.connect(liquidator).liquidate(user.address, asset, asset, 30n, 30n, 0);
      expect(await eventsView.getUserLiquidationCount(user.address)).to.equal(1n);

      // 第二次部分清算
      const remainingCollateral = await collateral.getCollateral(user.address, asset);
      const remainingDebt = await lending.getDebt(user.address, asset);
      await vbl.connect(liquidator).liquidate(user.address, asset, asset, 20n, 20n, 0);

      expect(await eventsView.getUserLiquidationCount(user.address)).to.equal(2n);
      expect(await collateral.getCollateral(user.address, asset)).to.equal(initialCollateral - 50n);
      expect(await lending.getDebt(user.address, asset)).to.equal(initialDebt - 50n);
    });

    it("部分清算后不应超过剩余债务", async () => {
      const { vbl, liquidator, user, asset, lending } = await loadFixture(deployFixture);

      await vbl.connect(liquidator).liquidate(user.address, asset, asset, 30n, 30n, 0);

      const remainingDebt = await lending.getDebt(user.address, asset);
      await expect(
        vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, remainingDebt + 1n, 0)
      ).to.be.revertedWith("Insufficient debt");
    });
  });

  describe("边界条件", () => {
    it("应处理最小金额清算（1 wei）", async () => {
      const { vbl, liquidator, user, asset, collateral, lending } = await loadFixture(deployFixture);

      await expect(
        vbl.connect(liquidator).liquidate(user.address, asset, asset, 1n, 1n, 0)
      ).to.not.be.reverted;

      const afterCollateral = await collateral.getCollateral(user.address, asset);
      const afterDebt = await lending.getDebt(user.address, asset);
      expect(afterCollateral).to.be.lt(100n);
      expect(afterDebt).to.be.lt(80n);
    });

    it("应拒绝超过可用抵押的清算", async () => {
      const { vbl, liquidator, user, asset, collateral } = await loadFixture(deployFixture);

      const availableCollateral = await collateral.getCollateral(user.address, asset);
      await expect(
        vbl.connect(liquidator).liquidate(user.address, asset, asset, availableCollateral + 1n, 10n, 0)
      ).to.be.revertedWith("Insufficient collateral");
    });

    it("应拒绝超过可用债务的清算", async () => {
      const { vbl, liquidator, user, asset, lending } = await loadFixture(deployFixture);

      const availableDebt = await lending.getDebt(user.address, asset);
      await expect(
        vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, availableDebt + 1n, 0)
      ).to.be.revertedWith("Insufficient debt");
    });
  });

  describe("多清算人场景", () => {
    it("不同清算人应能清算同一用户", async () => {
      const { vbl, registry, access, user, asset, collateral, lending, eventsView } =
        await loadFixture(deployFixture);

      const signers = await ethers.getSigners();
      const liquidator1 = signers[3];
      const liquidator2 = signers[4];
      await access.grantRole(ACTION_LIQUIDATE, liquidator1.address);
      await access.grantRole(ACTION_LIQUIDATE, liquidator2.address);

      // 第一个清算人
      await vbl.connect(liquidator1).liquidate(user.address, asset, asset, 20n, 20n, 0);
      expect(await eventsView.getUserLiquidationCount(user.address)).to.equal(1n);

      // 第二个清算人
      await vbl.connect(liquidator2).liquidate(user.address, asset, asset, 20n, 20n, 0);
      expect(await eventsView.getUserLiquidationCount(user.address)).to.equal(2n);

      const finalCollateral = await collateral.getCollateral(user.address, asset);
      const finalDebt = await lending.getDebt(user.address, asset);
      expect(finalCollateral).to.equal(60n);
      expect(finalDebt).to.equal(40n);
    });

    it("不同清算人的奖励应分别累计", async () => {
      const { vbl, registry, access, user, asset, eventsView } = await loadFixture(deployFixture);

      const signers = await ethers.getSigners();
      const liquidator1 = signers[3];
      const liquidator2 = signers[4];
      await access.grantRole(ACTION_LIQUIDATE, liquidator1.address);
      await access.grantRole(ACTION_LIQUIDATE, liquidator2.address);

      await vbl.connect(liquidator1).liquidate(user.address, asset, asset, 20n, 20n, 5n);
      await vbl.connect(liquidator2).liquidate(user.address, asset, asset, 20n, 20n, 3n);

      expect(await eventsView.getLiquidatorTotalBonus(liquidator1.address)).to.equal(5n);
      expect(await eventsView.getLiquidatorTotalBonus(liquidator2.address)).to.equal(3n);
    });
  });

  describe("清算奖励验证", () => {
    it("清算奖励应正确记录", async () => {
      const { vbl, liquidator, user, asset, eventsView } = await loadFixture(deployFixture);

      const bonus = 10n;
      await vbl.connect(liquidator).liquidate(user.address, asset, asset, 30n, 30n, bonus);

      expect(await eventsView.getLiquidatorTotalBonus(liquidator.address)).to.equal(bonus);
    });

    it("零奖励清算应正常工作", async () => {
      const { vbl, liquidator, user, asset, eventsView } = await loadFixture(deployFixture);

      await vbl.connect(liquidator).liquidate(user.address, asset, asset, 30n, 30n, 0);

      expect(await eventsView.getUserLiquidationCount(user.address)).to.equal(1n);
      expect(await eventsView.getLiquidatorTotalBonus(liquidator.address)).to.equal(0n);
    });
  });

  describe("状态一致性验证", () => {
    it("清算失败后所有状态应保持不变", async () => {
      const { vbl, liquidator, user, asset, collateral, lending, eventsView } =
        await loadFixture(deployFixture);

      const beforeCollateral = await collateral.getCollateral(user.address, asset);
      const beforeDebt = await lending.getDebt(user.address, asset);
      const beforeCount = await eventsView.getUserLiquidationCount(user.address);

      // 尝试超额清算
      await expect(
        vbl.connect(liquidator).liquidate(user.address, asset, asset, beforeCollateral + 1n, 10n, 0)
      ).to.be.reverted;

      // 验证所有状态未变
      expect(await collateral.getCollateral(user.address, asset)).to.equal(beforeCollateral);
      expect(await lending.getDebt(user.address, asset)).to.equal(beforeDebt);
      expect(await eventsView.getUserLiquidationCount(user.address)).to.equal(beforeCount);
    });

    it("多次失败清算不应累积状态变化", async () => {
      const { vbl, liquidator, user, asset, collateral, lending, eventsView } =
        await loadFixture(deployFixture);

      const initialCollateral = await collateral.getCollateral(user.address, asset);
      const initialDebt = await lending.getDebt(user.address, asset);

      // 连续失败尝试
      await expect(
        vbl.connect(liquidator).liquidate(user.address, asset, asset, initialCollateral + 1n, 10n, 0)
      ).to.be.reverted;

      await expect(
        vbl.connect(liquidator).liquidate(user.address, asset, asset, 10n, initialDebt + 1n, 0)
      ).to.be.reverted;

      // 状态应完全未变
      expect(await collateral.getCollateral(user.address, asset)).to.equal(initialCollateral);
      expect(await lending.getDebt(user.address, asset)).to.equal(initialDebt);
      expect(await eventsView.getUserLiquidationCount(user.address)).to.equal(0n);
    });
  });
});


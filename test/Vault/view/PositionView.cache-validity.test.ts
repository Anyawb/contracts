import { expect } from "chai";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const KEY_CM = ethers.id("COLLATERAL_MANAGER");
const KEY_LE = ethers.id("LENDING_ENGINE");
const KEY_ACM = ethers.id("ACCESS_CONTROL_MANAGER");
const KEY_VC = ethers.id("VAULT_CORE");
const KEY_VBL = ethers.id("VAULT_BUSINESS_LOGIC");
const ACTION_ADMIN = ethers.id("ACTION_ADMIN");
const ACTION_VIEW_PUSH = ethers.id("ACTION_VIEW_PUSH");

describe("PositionView - 缓存有效性与回退", function () {
  async function deployFixture() {
    const [admin, user, vbl] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("MockRegistry");
    const registry = await Registry.deploy();

    const Access = await ethers.getContractFactory("MockAccessControlManager");
    const access = await Access.deploy();
    await access.grantRole(ACTION_ADMIN, admin.address);

    const Collateral = await ethers.getContractFactory("MockCollateralManager");
    const collateral = await Collateral.deploy();
    const Lending = await ethers.getContractFactory("MockLendingEngineBasic");
    const lending = await Lending.deploy();

    // 注册模块
    await registry.setModule(KEY_ACM, await access.getAddress());
    await registry.setModule(KEY_CM, await collateral.getAddress());
    await registry.setModule(KEY_LE, await lending.getAddress());
    await registry.setModule(KEY_VC, admin.address);
    await registry.setModule(KEY_VBL, vbl.address);

    // 授权推送角色给业务模块与 Core
    await access.grantRole(ACTION_VIEW_PUSH, await collateral.getAddress());
    await access.grantRole(ACTION_VIEW_PUSH, await lending.getAddress());
    await access.grantRole(ACTION_VIEW_PUSH, admin.address); // vaultCore
    await access.grantRole(ACTION_VIEW_PUSH, vbl.address);   // vaultBusinessLogic

    const PositionView = await ethers.getContractFactory("PositionView");
    const pv = await PositionView.deploy();
    await pv.initialize(await registry.getAddress());

    const asset = ethers.Wallet.createRandom().address;
    return { admin, user, vbl, asset, registry, access, collateral, lending, pv };
  }

  it("缓存有效时返回缓存值并标记有效", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);

    // 账本与推送一致
    await collateral.depositCollateral(user.address, asset, 100n);
    await lending.setUserDebt(user.address, asset, 50n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 100n, 50n);
    const [collateralOut, debtOut, isValid] = await pv.connect(user).getUserPositionWithValidity(user.address, asset);

    expect(isValid).to.equal(true);
    expect(collateralOut).to.equal(100n);
    expect(debtOut).to.equal(50n);
  });

  it("缓存过期时回退账本并标记无效", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);

    // 推送与账本一致
    await collateral.depositCollateral(user.address, asset, 10n);
    await lending.setUserDebt(user.address, asset, 5n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 10n, 5n);

    // 更新账本真实数据（注意：MockCollateralManager 的 deposit 是累加，因此这里补到 200）
    await collateral.depositCollateral(user.address, asset, 190n);
    await lending.setUserDebt(user.address, asset, 80n);

    await time.increase(5 * 60 + 1); // 超过 CACHE_DURATION

    const [collateralOut, debtOut, isValid] = await pv.connect(user).getUserPositionWithValidity(user.address, asset);
    expect(isValid).to.equal(false);
    expect(collateralOut).to.equal(200n);
    expect(debtOut).to.equal(80n);
  });

  it("非业务模块调用被拒绝", async function () {
    const { pv, user, asset, collateral, access } = await loadFixture(deployFixture);
    await expect(
      pv.connect(user).pushUserPositionUpdate(user.address, asset, 1n, 1n)
    ).to.be.revertedWithCustomError(pv, "PositionView__Unauthorized");

    // 业务模块但缺角色也被拒绝（MissingRole）
    await access.revokeRole(ACTION_VIEW_PUSH, await collateral.getAddress());
    await expect(
      (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 1n, 1n)
    ).to.be.revertedWithCustomError(access, "MissingRole");
  });

  it("推送数据与账本不一致时回滚", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    await collateral.depositCollateral(user.address, asset, 10n);
    await lending.setUserDebt(user.address, asset, 5n);

    await expect(
      (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 11n, 5n)
    ).to.be.revertedWithCustomError(pv, "PositionView__LedgerMismatch");
  });

  it("账本读取失败时发出 CacheUpdateFailed 并回滚", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    // 让账本读取失败
    await collateral.setShouldFail(true);
    const tx = await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 1n, 1n);
    await expect(tx)
      .to.emit(pv, "CacheUpdateFailed")
      .withArgs(user.address, asset, await pv.getAddress(), 1n, 1n, anyValue);
  });

  it("账本读取债务失败时发出 CacheUpdateFailed 并回滚", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    await lending.setMockSuccess(false); // 让 getDebt revert
    const tx = await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 1n, 1n);
    await expect(tx)
      .to.emit(pv, "CacheUpdateFailed")
      .withArgs(user.address, asset, await pv.getAddress(), 1n, 1n, anyValue);
    // 恢复账本读取，避免 read path 的账本回退读取直接透传 revert
    await lending.setMockSuccess(true);
    const [collateralCached, debtCached, isValid] = await pv.connect(user).getUserPositionWithValidity(user.address, asset);
    expect(isValid).to.equal(false); // 未写入缓存
    expect(collateralCached).to.equal(0n);
    expect(debtCached).to.equal(0n);
  });

  it("管理员可通过 retryUserPositionUpdate 读取最新账本并修复缓存", async function () {
    const { pv, admin, user, asset, collateral, lending } = await loadFixture(deployFixture);
    await collateral.depositCollateral(user.address, asset, 10n);
    await lending.setUserDebt(user.address, asset, 5n);
    // 初次推送失败，触发 CacheUpdateFailed
    await lending.setMockSuccess(false);
    await expect(
      (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 10n, 5n)
    ).to.emit(pv, "CacheUpdateFailed");
    await lending.setMockSuccess(true);

    // 手动重试应刷新缓存
    await pv.connect(admin).retryUserPositionUpdate(user.address, asset);
    const [c, d, isValid] = await pv.connect(user).getUserPositionWithValidity(user.address, asset);
    expect(isValid).to.equal(true);
    expect(c).to.equal(10n);
    expect(d).to.equal(5n);
  });

  it("零地址输入被拒绝", async function () {
    const { pv, collateral } = await loadFixture(deployFixture);
    await expect(
      (collateral as any).pushToPositionView(pv.getAddress(), ethers.ZeroAddress, ethers.Wallet.createRandom().address, 1n, 1n)
    ).to.be.revertedWithCustomError(pv, "PositionView__InvalidInput");
    await expect(
      (collateral as any).pushToPositionView(pv.getAddress(), ethers.Wallet.createRandom().address, ethers.ZeroAddress, 1n, 1n)
    ).to.be.revertedWithCustomError(pv, "PositionView__InvalidInput");
  });

  it("业务模块 VaultBusinessLogic 有权限时可推送并写缓存", async function () {
    const { pv, user, asset, vbl, registry, access } = await loadFixture(deployFixture);
    // vbl 已在 fixture 获得 ACTION_VIEW_PUSH
    // 更新账本假数据：因为 vbl 不是真账本，这里先注册一个虚拟账本返回 0/0，推送 0/0 成功
    const Collateral = await ethers.getContractFactory("MockCollateralManager");
    const collateral2 = await Collateral.deploy();
    const Lending = await ethers.getContractFactory("MockLendingEngineBasic");
    const lending2 = await Lending.deploy();
    await registry.setModule(KEY_CM, await collateral2.getAddress());
    await registry.setModule(KEY_LE, await lending2.getAddress());
    await access.grantRole(ACTION_VIEW_PUSH, await collateral2.getAddress());
    await access.grantRole(ACTION_VIEW_PUSH, await lending2.getAddress());

    await (vbl as any).sendTransaction({ to: await pv.getAddress(), data: pv.interface.encodeFunctionData("pushUserPositionUpdate", [user.address, asset, 0, 0]) });
    const [collateralCached, debtCached, isValid] = await pv.connect(user).getUserPositionWithValidity(user.address, asset);
    expect(collateralCached).to.equal(0n);
    expect(debtCached).to.equal(0n);
    expect(isValid).to.equal(true);
  });

  it("业务模块缺推送角色时被 MissingRole 拒绝", async function () {
    const { pv, user, asset, collateral, access } = await loadFixture(deployFixture);
    await access.revokeRole(ACTION_VIEW_PUSH, await collateral.getAddress());
    await expect(
      (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 1n, 1n)
    ).to.be.revertedWithCustomError(access, "MissingRole");
  });

  it("非白名单地址即便拥有推送角色也会被拒绝", async function () {
    const { pv, user, asset, access } = await loadFixture(deployFixture);
    const [, nonBiz] = await ethers.getSigners();
    await access.grantRole(ACTION_VIEW_PUSH, nonBiz.address);
    await expect(
      pv.connect(nonBiz).pushUserPositionUpdate(user.address, asset, 1n, 1n)
    ).to.be.revertedWithCustomError(pv, "PositionView__Unauthorized");
  });

  it("写入成功时事件与缓存更新", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    await collateral.depositCollateral(user.address, asset, 123n);
    await lending.setUserDebt(user.address, asset, 45n);
    await expect(
      (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 123n, 45n)
    ).to.emit(pv, "UserPositionCached").withArgs(user.address, asset, 123n, 45n, anyValue);
    const [c, d, isValid] = await pv.connect(user).getUserPositionWithValidity(user.address, asset);
    expect(c).to.equal(123n);
    expect(d).to.equal(45n);
    expect(isValid).to.equal(true);
  });

  it("Registry 更新后旧模块被拒，新模块可推送", async function () {
    const { pv, admin, user, asset, collateral, registry, access } = await loadFixture(deployFixture);
    // 原模块仍有注册，但我们切换到新模块地址
    const Collateral = await ethers.getContractFactory("MockCollateralManager");
    const collateralNew = await Collateral.deploy();
    await registry.setModule(KEY_CM, await collateralNew.getAddress());
    await access.grantRole(ACTION_VIEW_PUSH, await collateralNew.getAddress());
    // PositionView 使用短期模块缓存：Registry 变更后需手动刷新缓存
    await pv.connect(admin).refreshModuleCache();

    // 旧模块调用应被拒绝（地址不在白名单）
    await expect(
      (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 1n, 1n)
    ).to.be.revertedWithCustomError(pv, "PositionView__Unauthorized");

    // 新模块调用成功（账本返回默认 0）
    await (collateralNew as any).pushToPositionView(pv.getAddress(), user.address, asset, 0n, 0n);
    const [collateralCached, debtCached, isValid] = await pv.connect(user).getUserPositionWithValidity(user.address, asset);
    expect(collateralCached).to.equal(0n);
    expect(debtCached).to.equal(0n);
    expect(isValid).to.equal(true);
  });
});


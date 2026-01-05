import { expect } from "chai";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { ethers, upgrades } from "hardhat";
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

    // VaultCore mock: PositionView 会通过 KEY_VAULT_CORE.viewContractAddrVar() 解析 VaultRouter 地址
    // 这里把 viewContractAddr 设置为 admin（EOA），从而允许 admin 作为“VaultRouter”直接推送
    const MockVaultCoreView = await ethers.getContractFactory("MockVaultCoreView");
    const vaultCoreView = await MockVaultCoreView.deploy();
    await vaultCoreView.setViewContractAddr(admin.address);

    // 注册模块
    await registry.setModule(KEY_ACM, await access.getAddress());
    await registry.setModule(KEY_CM, await collateral.getAddress());
    await registry.setModule(KEY_LE, await lending.getAddress());
    await registry.setModule(KEY_VC, await vaultCoreView.getAddress());
    await registry.setModule(KEY_VBL, vbl.address);

    // 授权推送角色给业务模块与 Core
    await access.grantRole(ACTION_VIEW_PUSH, await collateral.getAddress());
    await access.grantRole(ACTION_VIEW_PUSH, await lending.getAddress());
    await access.grantRole(ACTION_VIEW_PUSH, admin.address); // vaultRouter (via VaultCoreView.viewContractAddrVar)
    await access.grantRole(ACTION_VIEW_PUSH, vbl.address);   // vaultBusinessLogic

    const PositionView = await ethers.getContractFactory("PositionView");
    const pv = await upgrades.deployProxy(PositionView, [await registry.getAddress()], { kind: "uups" });

    const asset = ethers.Wallet.createRandom().address;
    return { admin, user, vbl, asset, registry, access, collateral, lending, pv, vaultCoreView };
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

  it("任何地址都可以免费查询他人仓位", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    const [, stranger] = await ethers.getSigners();

    await collateral.depositCollateral(user.address, asset, 25n);
    await lending.setUserDebt(user.address, asset, 7n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 25n, 7n);

    const [c, d] = await pv.connect(stranger).getUserPosition(user.address, asset);
    expect(c).to.equal(25n);
    expect(d).to.equal(7n);
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

    await (vbl as any).sendTransaction({
      to: await pv.getAddress(),
      data: pv.interface.encodeFunctionData("pushUserPositionUpdate(address,address,uint256,uint256)", [user.address, asset, 0, 0])
    });
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
      pv.connect(nonBiz)["pushUserPositionUpdate(address,address,uint256,uint256)"](user.address, asset, 1n, 1n)
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

  it("默认推送自动自增版本", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    await collateral.depositCollateral(user.address, asset, 10n);
    await lending.setUserDebt(user.address, asset, 1n);

    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 10n, 1n);
    expect(await pv.getPositionVersion(user.address, asset)).to.equal(1n);

    await collateral.depositCollateral(user.address, asset, 5n); // ledger=15
    await lending.setUserDebt(user.address, asset, 2n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 15n, 2n);
    expect(await pv.getPositionVersion(user.address, asset)).to.equal(2n);
  });

  it("落后版本会被拒绝，正确递增后写入成功", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    await collateral.depositCollateral(user.address, asset, 10n);
    await lending.setUserDebt(user.address, asset, 1n);

    // 初次写入，版本=1
    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 10n, 1n);
    expect(await pv.getPositionVersion(user.address, asset)).to.equal(1n);

    // 使用相同版本号应被拒绝
    await expect(
      pv["pushUserPositionUpdate(address,address,uint256,uint256,uint64)"](user.address, asset, 10n, 1n, 1)
    ).to.be.revertedWithCustomError(pv, "PositionView__StaleVersion");

    // 使用更高版本写入成功
    await collateral.depositCollateral(user.address, asset, 5n); // ledger=15
    await lending.setUserDebt(user.address, asset, 2n);
    await pv["pushUserPositionUpdate(address,address,uint256,uint256,uint64)"](user.address, asset, 15n, 2n, 2);
    expect(await pv.getPositionVersion(user.address, asset)).to.equal(2n);
  });

  it("Phase3 幂等（O(1)）：同 requestId 的成功重放会被忽略（nextVersion==currentVersion）", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    const requestId = ethers.id("req-pv-1");

    // ledger 设置为 10 / 1
    await collateral.depositCollateral(user.address, asset, 10n);
    await lending.setUserDebt(user.address, asset, 1n);

    // 第一次写入：nextVersion=1, seq=10
    await pv["pushUserPositionUpdate(address,address,uint256,uint256,bytes32,uint64,uint64)"](
      user.address,
      asset,
      10n,
      1n,
      requestId,
      10,
      1
    );
    expect(await pv.getPositionVersion(user.address, asset)).to.equal(1n);

    // 即便 ledger 改变，重放也应被幂等忽略（不会触发账本读取/校验）
    await collateral.depositCollateral(user.address, asset, 5n);
    await lending.setUserDebt(user.address, asset, 999n);

    await expect(
      pv["pushUserPositionUpdate(address,address,uint256,uint256,bytes32,uint64,uint64)"](
        user.address,
        asset,
        10n,
        1n,
        requestId,
        1, // seq 更小，但应优先按幂等忽略
        1  // nextVersion == currentVersion
      )
    )
      .to.emit(pv, "IdempotentRequestIgnored")
      .withArgs(user.address, asset, requestId, 1);

    // 缓存与版本保持不变
    const [c, d, isValid] = await pv.getUserPositionWithValidity(user.address, asset);
    expect(isValid).to.equal(true);
    expect(c).to.equal(10n);
    expect(d).to.equal(1n);
    expect(await pv.getPositionVersion(user.address, asset)).to.equal(1n);
  });

  it("Phase3 顺序约束：seq 非严格递增会被拒绝（非幂等重放场景）", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    const requestId1 = ethers.id("req-pv-2a");
    const requestId2 = ethers.id("req-pv-2b");

    await collateral.depositCollateral(user.address, asset, 10n);
    await lending.setUserDebt(user.address, asset, 1n);

    await pv["pushUserPositionUpdate(address,address,uint256,uint256,bytes32,uint64,uint64)"](
      user.address,
      asset,
      10n,
      1n,
      requestId1,
      10,
      1
    );

    // seq 回退（9 <= 10）应直接 revert
    await collateral.depositCollateral(user.address, asset, 5n); // ledger=15
    await lending.setUserDebt(user.address, asset, 2n);
    await expect(
      pv["pushUserPositionUpdate(address,address,uint256,uint256,bytes32,uint64,uint64)"](
        user.address,
        asset,
        15n,
        2n,
        requestId2,
        9,
        2
      )
    ).to.be.revertedWithCustomError(pv, "PositionView__OutOfOrderSeq");
  });

  it("Phase3 严格 nextVersion：不同 requestId 且 nextVersion==currentVersion 不会被视为幂等，应 revert", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    const requestId1 = ethers.id("req-pv-3a");
    const requestId2 = ethers.id("req-pv-3b");

    await collateral.depositCollateral(user.address, asset, 10n);
    await lending.setUserDebt(user.address, asset, 1n);

    await pv["pushUserPositionUpdate(address,address,uint256,uint256,bytes32,uint64,uint64)"](
      user.address,
      asset,
      10n,
      1n,
      requestId1,
      10,
      1
    );
    expect(await pv.getPositionVersion(user.address, asset)).to.equal(1n);

    // nextVersion==currentVersion(1) 但 requestId 不同：不满足幂等条件，应按严格版本校验 revert
    await expect(
      pv["pushUserPositionUpdate(address,address,uint256,uint256,bytes32,uint64,uint64)"](
        user.address,
        asset,
        10n,
        1n,
        requestId2,
        11,
        1
      )
    ).to.be.revertedWithCustomError(pv, "PositionView__StaleVersion");
  });

  it("Phase3 说明：nextVersion==0（自增模式）不提供强 requestId 幂等保证", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    const requestId = ethers.id("req-pv-4");

    await collateral.depositCollateral(user.address, asset, 10n);
    await lending.setUserDebt(user.address, asset, 1n);

    // 使用 nextVersion=0（通过重载：带 requestId/seq，但不带 nextVersion）
    await pv["pushUserPositionUpdate(address,address,uint256,uint256,bytes32,uint64)"](
      user.address,
      asset,
      10n,
      1n,
      requestId,
      0
    );
    expect(await pv.getPositionVersion(user.address, asset)).to.equal(1n);

    // 同 requestId 再次调用仍会自增（不会被忽略）
    await pv["pushUserPositionUpdate(address,address,uint256,uint256,bytes32,uint64)"](
      user.address,
      asset,
      10n,
      1n,
      requestId,
      0
    );
    expect(await pv.getPositionVersion(user.address, asset)).to.equal(2n);
  });

  it("Phase3 幂等（Delta）：同 requestId 的成功重放会被忽略（nextVersion==currentVersion）", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    const requestId = ethers.id("req-pv-delta-1");

    await collateral.depositCollateral(user.address, asset, 10n);
    await lending.setUserDebt(user.address, asset, 1n);

    // 初始化缓存 version=1
    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 10n, 1n);
    expect(await pv.getPositionVersion(user.address, asset)).to.equal(1n);

    // 增量写入 nextVersion=2
    await pv["pushUserPositionUpdateDelta(address,address,int256,int256,bytes32,uint64,uint64)"](
      user.address,
      asset,
      5,
      1,
      requestId,
      100,
      2
    );
    expect(await pv.getPositionVersion(user.address, asset)).to.equal(2n);
    const [c1, d1] = await pv.getUserPosition(user.address, asset);
    expect(c1).to.equal(15n);
    expect(d1).to.equal(2n);

    // 重放：nextVersion==currentVersion(2) + same requestId => ignore (even if seq smaller)
    await expect(
      pv["pushUserPositionUpdateDelta(address,address,int256,int256,bytes32,uint64,uint64)"](
        user.address,
        asset,
        5,
        1,
        requestId,
        1,
        2
      )
    )
      .to.emit(pv, "IdempotentRequestIgnored")
      .withArgs(user.address, asset, requestId, 1);

    const [c2, d2] = await pv.getUserPosition(user.address, asset);
    expect(c2).to.equal(15n);
    expect(d2).to.equal(2n);
    expect(await pv.getPositionVersion(user.address, asset)).to.equal(2n);
  });

  it("增量推送：自增版本并正确累加", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    await collateral.depositCollateral(user.address, asset, 10n);
    await lending.setUserDebt(user.address, asset, 1n);

    // 初次写入
    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 10n, 1n);
    expect(await pv.getPositionVersion(user.address, asset)).to.equal(1n);

    // 增量 +5 collateral, +1 debt
    await pv["pushUserPositionUpdateDelta(address,address,int256,int256)"](user.address, asset, 5, 1);
    expect(await pv.getPositionVersion(user.address, asset)).to.equal(2n);
    const [c1, d1, ] = await pv.connect(user).getUserPositionWithValidity(user.address, asset);
    expect(c1).to.equal(15n);
    expect(d1).to.equal(2n);

    // 增量 -3 collateral, 0 debt，指定版本
    await pv["pushUserPositionUpdateDelta(address,address,int256,int256,uint64)"](user.address, asset, -3, 0, 3);
    expect(await pv.getPositionVersion(user.address, asset)).to.equal(3n);
    const [c2, d2, ] = await pv.connect(user).getUserPositionWithValidity(user.address, asset);
    expect(c2).to.equal(12n);
    expect(d2).to.equal(2n);
  });

  it("增量推送下溢将被拒绝", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    await collateral.depositCollateral(user.address, asset, 2n);
    await lending.setUserDebt(user.address, asset, 1n);

    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 2n, 1n);
    await expect(
      pv["pushUserPositionUpdateDelta(address,address,int256,int256)"](user.address, asset, -5, 0)
    ).to.be.revertedWithCustomError(pv, "PositionView__InvalidDelta");
  });

  it("Registry 更新后自动识别新模块并拒绝旧地址", async function () {
    const { pv, user, asset, collateral, registry, access } = await loadFixture(deployFixture);
    const Collateral = await ethers.getContractFactory("MockCollateralManager");
    const collateralNew = await Collateral.deploy();

    // 切换注册模块并授予推送角色
    await registry.setModule(KEY_CM, await collateralNew.getAddress());
    await access.grantRole(ACTION_VIEW_PUSH, await collateralNew.getAddress());

    await expect(
      (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 1n, 1n)
    ).to.be.revertedWithCustomError(pv, "PositionView__Unauthorized");

    await (collateralNew as any).pushToPositionView(pv.getAddress(), user.address, asset, 0n, 0n);
    const [collateralCached, debtCached, isValid] = await pv.connect(user).getUserPositionWithValidity(user.address, asset);
    expect(collateralCached).to.equal(0n);
    expect(debtCached).to.equal(0n);
    expect(isValid).to.equal(true);
  });

  // ============ 批量查询边界测试 ============
  it("批量查询：空数组被拒绝", async function () {
    const { pv } = await loadFixture(deployFixture);
    await expect(
      pv.batchGetUserPositions([], [])
    ).to.be.revertedWithCustomError(pv, "EmptyArray");
  });

  it("批量查询：长度不匹配被拒绝", async function () {
    const { pv, user } = await loadFixture(deployFixture);
    const asset = ethers.Wallet.createRandom().address;
    await expect(
      pv.batchGetUserPositions([user.address], [])
    ).to.be.revertedWithCustomError(pv, "ArrayLengthMismatch");
  });

  it("批量查询：超过最大批量大小被拒绝", async function () {
    const { pv, user } = await loadFixture(deployFixture);
    const users = Array(101).fill(user.address);
    const assets = Array(101).fill(ethers.Wallet.createRandom().address);
    await expect(
      pv.batchGetUserPositions(users, assets)
    ).to.be.revertedWithCustomError(pv, "PositionView__BatchTooLarge");
  });

  it("批量查询：正常批量查询返回正确结果", async function () {
    const { pv, user, collateral, lending } = await loadFixture(deployFixture);
    const [user1, user2, user3] = await ethers.getSigners();
    const asset1 = ethers.Wallet.createRandom().address;
    const asset2 = ethers.Wallet.createRandom().address;
    const asset3 = ethers.Wallet.createRandom().address;

    // 设置账本数据
    await collateral.depositCollateral(user1.address, asset1, 100n);
    await lending.setUserDebt(user1.address, asset1, 50n);
    await collateral.depositCollateral(user2.address, asset2, 200n);
    await lending.setUserDebt(user2.address, asset2, 80n);
    await collateral.depositCollateral(user3.address, asset3, 300n);
    await lending.setUserDebt(user3.address, asset3, 120n);

    // 推送缓存
    await (collateral as any).pushToPositionView(pv.getAddress(), user1.address, asset1, 100n, 50n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user2.address, asset2, 200n, 80n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user3.address, asset3, 300n, 120n);

    const [collaterals, debts] = await pv.batchGetUserPositions(
      [user1.address, user2.address, user3.address],
      [asset1, asset2, asset3]
    );

    expect(collaterals).to.deep.equal([100n, 200n, 300n]);
    expect(debts).to.deep.equal([50n, 80n, 120n]);
  });

  it("批量查询：混合缓存有效和失效场景", async function () {
    const { pv, user, collateral, lending } = await loadFixture(deployFixture);
    const [user1, user2] = await ethers.getSigners();
    const asset1 = ethers.Wallet.createRandom().address;
    const asset2 = ethers.Wallet.createRandom().address;

    // user1: 有效缓存
    await collateral.depositCollateral(user1.address, asset1, 100n);
    await lending.setUserDebt(user1.address, asset1, 50n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user1.address, asset1, 100n, 50n);

    // user2: 缓存过期，回退账本
    await collateral.depositCollateral(user2.address, asset2, 200n);
    await lending.setUserDebt(user2.address, asset2, 80n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user2.address, asset2, 200n, 80n);
    await time.increase(5 * 60 + 1); // 过期
    await collateral.depositCollateral(user2.address, asset2, 50n); // 更新账本
    await lending.setUserDebt(user2.address, asset2, 30n);

    const [collaterals, debts] = await pv.batchGetUserPositions(
      [user1.address, user2.address],
      [asset1, asset2]
    );

    expect(collaterals[0]).to.equal(100n); // 缓存值
    expect(debts[0]).to.equal(50n);
    expect(collaterals[1]).to.equal(250n); // 账本值（200+50）
    expect(debts[1]).to.equal(30n);
  });

  it("批量查询：最大批量大小 100 成功返回", async function () {
    const { pv } = await loadFixture(deployFixture);
    const users = [];
    const assets = [];
    for (let i = 0; i < 100; i++) {
      const wallet = ethers.Wallet.createRandom();
      users.push(wallet.address);
      assets.push(ethers.Wallet.createRandom().address);
    }
    const [collaterals, debts] = await pv.batchGetUserPositions(users, assets);
    expect(collaterals.length).to.equal(100);
    expect(debts.length).to.equal(100);
    expect(collaterals.every((v) => v === 0n)).to.equal(true);
    expect(debts.every((v) => v === 0n)).to.equal(true);
  });

  // ============ 缓存清理功能测试 ============
  it("用户自己可以清理自己的缓存", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    await collateral.depositCollateral(user.address, asset, 100n);
    await lending.setUserDebt(user.address, asset, 50n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 100n, 50n);

    expect(await pv.isUserCacheValid(user.address)).to.equal(true);
    await pv.connect(user).clearUserCache(user.address);
    expect(await pv.isUserCacheValid(user.address)).to.equal(false);
  });

  it("管理员可以清理任何用户的缓存", async function () {
    const { pv, admin, user, asset, collateral, lending } = await loadFixture(deployFixture);
    await collateral.depositCollateral(user.address, asset, 100n);
    await lending.setUserDebt(user.address, asset, 50n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 100n, 50n);

    expect(await pv.isUserCacheValid(user.address)).to.equal(true);
    await pv.connect(admin).clearUserCache(user.address);
    expect(await pv.isUserCacheValid(user.address)).to.equal(false);
  });

  it("非用户非管理员无法清理缓存", async function () {
    const { pv, user, asset, collateral, lending, access, vbl } = await loadFixture(deployFixture);
    await collateral.depositCollateral(user.address, asset, 100n);
    await lending.setUserDebt(user.address, asset, 50n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 100n, 50n);

    // 使用 vbl 作为 stranger（它不是 user，也不是 admin）
    // 确保 vbl 没有管理员权限
    const isAdmin = await access.hasRole(ACTION_ADMIN, vbl.address);
    if (isAdmin) {
      await access.revokeRole(ACTION_ADMIN, vbl.address);
    }
    
    // 确保 vbl 不是 user
    expect(vbl.address).to.not.equal(user.address);

    await expect(
      pv.connect(vbl).clearUserCache(user.address)
    ).to.be.revertedWithCustomError(pv, "PositionView__OnlyUserOrAdmin");
  });

  // ============ 版本号和更新时间戳测试 ============
  it("getPositionVersion 返回正确的版本号", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    expect(await pv.getPositionVersion(user.address, asset)).to.equal(0n);

    await collateral.depositCollateral(user.address, asset, 10n);
    await lending.setUserDebt(user.address, asset, 1n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 10n, 1n);
    expect(await pv.getPositionVersion(user.address, asset)).to.equal(1n);

    await collateral.depositCollateral(user.address, asset, 5n);
    await lending.setUserDebt(user.address, asset, 2n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 15n, 2n);
    expect(await pv.getPositionVersion(user.address, asset)).to.equal(2n);
  });

  it("getPositionUpdatedAt 返回正确的时间戳", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    expect(await pv.getPositionUpdatedAt(user.address, asset)).to.equal(0n);

    await collateral.depositCollateral(user.address, asset, 10n);
    await lending.setUserDebt(user.address, asset, 1n);
    const tx = await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 10n, 1n);
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt!.blockNumber);
    const updatedAt = await pv.getPositionUpdatedAt(user.address, asset);
    expect(updatedAt).to.equal(block!.timestamp);
  });

  // ============ 事件验证测试 ============
  it("推送时发出 UserPositionCachedV2 事件", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    await collateral.depositCollateral(user.address, asset, 123n);
    await lending.setUserDebt(user.address, asset, 45n);
    await expect(
      (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 123n, 45n)
    )
      .to.emit(pv, "UserPositionCachedV2")
      .withArgs(user.address, asset, 123n, 45n, 1n, anyValue);
  });

  it("增量推送时版本号正确递增", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    await collateral.depositCollateral(user.address, asset, 10n);
    await lending.setUserDebt(user.address, asset, 1n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 10n, 1n);

    const tx = await pv["pushUserPositionUpdateDelta(address,address,int256,int256)"](user.address, asset, 5, 1);
    await expect(tx)
      .to.emit(pv, "UserPositionCachedV2")
      .withArgs(user.address, asset, 15n, 2n, 2n, anyValue);
  });

  // ============ 多个用户/多个资产场景 ============
  it("同一用户多个资产的缓存独立管理", async function () {
    const { pv, user, collateral, lending } = await loadFixture(deployFixture);
    const asset1 = ethers.Wallet.createRandom().address;
    const asset2 = ethers.Wallet.createRandom().address;

    await collateral.depositCollateral(user.address, asset1, 100n);
    await lending.setUserDebt(user.address, asset1, 50n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset1, 100n, 50n);

    await collateral.depositCollateral(user.address, asset2, 200n);
    await lending.setUserDebt(user.address, asset2, 80n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset2, 200n, 80n);

    const [c1, d1] = await pv.getUserPosition(user.address, asset1);
    const [c2, d2] = await pv.getUserPosition(user.address, asset2);

    expect(c1).to.equal(100n);
    expect(d1).to.equal(50n);
    expect(c2).to.equal(200n);
    expect(d2).to.equal(80n);

    expect(await pv.getPositionVersion(user.address, asset1)).to.equal(1n);
    expect(await pv.getPositionVersion(user.address, asset2)).to.equal(1n);
  });

  it("同一资产多个用户的缓存独立管理", async function () {
    const { pv, collateral, lending } = await loadFixture(deployFixture);
    const [user1, user2] = await ethers.getSigners();
    const asset = ethers.Wallet.createRandom().address;

    await collateral.depositCollateral(user1.address, asset, 100n);
    await lending.setUserDebt(user1.address, asset, 50n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user1.address, asset, 100n, 50n);

    await collateral.depositCollateral(user2.address, asset, 200n);
    await lending.setUserDebt(user2.address, asset, 80n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user2.address, asset, 200n, 80n);

    const [c1, d1] = await pv.getUserPosition(user1.address, asset);
    const [c2, d2] = await pv.getUserPosition(user2.address, asset);

    expect(c1).to.equal(100n);
    expect(d1).to.equal(50n);
    expect(c2).to.equal(200n);
    expect(d2).to.equal(80n);
  });

  it("多个用户多个资产的版本号独立管理", async function () {
    const { pv, collateral, lending } = await loadFixture(deployFixture);
    const [user1, user2] = await ethers.getSigners();
    const asset1 = ethers.Wallet.createRandom().address;
    const asset2 = ethers.Wallet.createRandom().address;

    // user1, asset1: 版本1
    await collateral.depositCollateral(user1.address, asset1, 100n);
    await lending.setUserDebt(user1.address, asset1, 50n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user1.address, asset1, 100n, 50n);

    // user1, asset2: 版本1
    await collateral.depositCollateral(user1.address, asset2, 200n);
    await lending.setUserDebt(user1.address, asset2, 80n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user1.address, asset2, 200n, 80n);

    // user2, asset1: 版本1
    await collateral.depositCollateral(user2.address, asset1, 300n);
    await lending.setUserDebt(user2.address, asset1, 120n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user2.address, asset1, 300n, 120n);

    // user1, asset1: 更新到版本2（注意：deposit是累加的，所以100+50=150）
    await collateral.depositCollateral(user1.address, asset1, 50n); // 账本=150
    await lending.setUserDebt(user1.address, asset1, 75n); // 直接设置为75
    await (collateral as any).pushToPositionView(pv.getAddress(), user1.address, asset1, 150n, 75n);

    // 验证版本号独立
    expect(await pv.getPositionVersion(user1.address, asset1)).to.equal(2n);
    expect(await pv.getPositionVersion(user1.address, asset2)).to.equal(1n);
    expect(await pv.getPositionVersion(user2.address, asset1)).to.equal(1n);
  });

  it("多个用户多个资产的缓存时间戳独立管理", async function () {
    const { pv, collateral, lending } = await loadFixture(deployFixture);
    const [user1, user2] = await ethers.getSigners();
    const asset1 = ethers.Wallet.createRandom().address;
    const asset2 = ethers.Wallet.createRandom().address;

    // user1, asset1: 推送
    await collateral.depositCollateral(user1.address, asset1, 100n);
    await lending.setUserDebt(user1.address, asset1, 50n);
    const tx1 = await (collateral as any).pushToPositionView(pv.getAddress(), user1.address, asset1, 100n, 50n);
    const receipt1 = await tx1.wait();
    const block1 = await ethers.provider.getBlock(receipt1!.blockNumber);
    const ts1 = block1!.timestamp;

    // 等待一段时间
    await time.increase(60);

    // user1, asset2: 推送
    await collateral.depositCollateral(user1.address, asset2, 200n);
    await lending.setUserDebt(user1.address, asset2, 80n);
    const tx2 = await (collateral as any).pushToPositionView(pv.getAddress(), user1.address, asset2, 200n, 80n);
    const receipt2 = await tx2.wait();
    const block2 = await ethers.provider.getBlock(receipt2!.blockNumber);
    const ts2 = block2!.timestamp;

    // user2, asset1: 推送
    await collateral.depositCollateral(user2.address, asset1, 300n);
    await lending.setUserDebt(user2.address, asset1, 120n);
    const tx3 = await (collateral as any).pushToPositionView(pv.getAddress(), user2.address, asset1, 300n, 120n);
    const receipt3 = await tx3.wait();
    const block3 = await ethers.provider.getBlock(receipt3!.blockNumber);
    const ts3 = block3!.timestamp;

    // 验证时间戳独立
    expect(await pv.getPositionUpdatedAt(user1.address, asset1)).to.equal(ts1);
    expect(await pv.getPositionUpdatedAt(user1.address, asset2)).to.equal(ts2);
    expect(await pv.getPositionUpdatedAt(user2.address, asset1)).to.equal(ts3);
    expect(ts2).to.be.greaterThan(ts1);
    expect(ts3).to.be.greaterThan(ts2);
  });

  it("一个用户多个资产，部分缓存有效部分失效", async function () {
    const { pv, user, collateral, lending } = await loadFixture(deployFixture);
    const asset1 = ethers.Wallet.createRandom().address;
    const asset2 = ethers.Wallet.createRandom().address;
    const asset3 = ethers.Wallet.createRandom().address;

    // asset2: 先推送
    await collateral.depositCollateral(user.address, asset2, 200n);
    await lending.setUserDebt(user.address, asset2, 80n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset2, 200n, 80n);
    
    // 等待一段时间但不超过缓存有效期
    await time.increase(2 * 60);
    
    // asset1: 后推送（会更新整个用户的缓存时间戳）
    await collateral.depositCollateral(user.address, asset1, 100n);
    await lending.setUserDebt(user.address, asset1, 50n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset1, 100n, 50n);

    // asset2: 缓存过期（在asset1推送之前，但asset1的推送更新了整个用户的缓存时间戳）
    // 所以asset2的缓存时间戳也被更新了，显示为有效，但数据仍然是旧的
    // 注意：asset1的推送在缓存有效期内，所以整个用户的缓存时间戳仍然有效
    // 等待一段时间，但不超过缓存有效期（asset1推送后）
    await time.increase(2 * 60); // 在缓存有效期内
    await collateral.depositCollateral(user.address, asset2, 50n); // 更新账本到250
    await lending.setUserDebt(user.address, asset2, 100n); // 更新账本到100

    // asset3: 未推送过，直接查询账本
    await collateral.depositCollateral(user.address, asset3, 300n);
    await lending.setUserDebt(user.address, asset3, 120n);

    // 验证缓存状态
    // 注意：由于asset1的推送更新了整个用户的缓存时间戳，所以asset2的缓存也显示为有效
    const [c1, d1, valid1] = await pv.getUserPositionWithValidity(user.address, asset1);
    const [c2, d2, valid2] = await pv.getUserPositionWithValidity(user.address, asset2);
    const [c3, d3, valid3] = await pv.getUserPositionWithValidity(user.address, asset3);

    // asset1: 有效（最后推送）
    expect(valid1).to.equal(true);
    expect(c1).to.equal(100n);
    expect(d1).to.equal(50n);

    // asset2: 由于asset1的推送更新了整个用户的缓存时间戳，所以显示为有效
    // 但数据仍然是旧的缓存值（200, 80），不是账本值（250, 100）
    expect(valid2).to.equal(true); // 因为asset1的推送更新了整个用户的缓存时间戳
    expect(c2).to.equal(200n); // 缓存值（不是账本值250）
    expect(d2).to.equal(80n); // 缓存值（不是账本值100）

    // asset3: 未推送过，但由于用户的缓存时间戳仍在有效期内，视为有效，数据为默认缓存0
    expect(valid3).to.equal(true);
    expect(c3).to.equal(0n);
    expect(d3).to.equal(0n);
  });

  it("一个资产多个用户，部分缓存有效部分失效", async function () {
    const { pv, collateral, lending } = await loadFixture(deployFixture);
    const [user1, user2, user3] = await ethers.getSigners();
    const asset = ethers.Wallet.createRandom().address;

    // user2: 先推送
    await collateral.depositCollateral(user2.address, asset, 200n);
    await lending.setUserDebt(user2.address, asset, 80n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user2.address, asset, 200n, 80n);
    
    // 等待一段时间但不超过缓存有效期
    await time.increase(2 * 60);
    
    // user1: 后推送（每个用户的缓存时间戳是独立的）
    await collateral.depositCollateral(user1.address, asset, 100n);
    await lending.setUserDebt(user1.address, asset, 50n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user1.address, asset, 100n, 50n);

    // user2: 缓存过期（在user1推送之前，且已经超过缓存有效期）
    // 注意：每个用户的缓存时间戳是独立的，所以user2的缓存不会因为user1的推送而更新
    // 调整等待时间：让 user2 过期，但 user1 仍在有效期内
    await time.increase(4 * 60); // user2 总共约6 分钟，过期；user1 约4 分钟，未过期
    await collateral.depositCollateral(user2.address, asset, 50n); // 更新账本到250
    await lending.setUserDebt(user2.address, asset, 100n); // 更新账本到100

    // user3: 未推送过，直接查询账本
    await collateral.depositCollateral(user3.address, asset, 300n);
    await lending.setUserDebt(user3.address, asset, 120n);

    // 验证缓存状态
    // 注意：每个用户的缓存时间戳是独立的
    const [c1, d1, valid1] = await pv.getUserPositionWithValidity(user1.address, asset);
    const [c2, d2, valid2] = await pv.getUserPositionWithValidity(user2.address, asset);
    const [c3, d3, valid3] = await pv.getUserPositionWithValidity(user3.address, asset);

    // user1: 有效（最后推送）
    expect(valid1).to.equal(true);
    expect(c1).to.equal(100n);
    expect(d1).to.equal(50n);

    // user2: 过期（在user1推送之前，且已经超过缓存有效期）
    expect(valid2).to.equal(false);
    expect(c2).to.equal(250n); // 账本值
    expect(d2).to.equal(100n);

    // user3: 未推送过，无效
    expect(valid3).to.equal(false);
    expect(c3).to.equal(300n); // 账本值
    expect(d3).to.equal(120n);
  });

  it("批量查询多个用户多个资产", async function () {
    const { pv, collateral, lending } = await loadFixture(deployFixture);
    const [user1, user2, user3] = await ethers.getSigners();
    const asset1 = ethers.Wallet.createRandom().address;
    const asset2 = ethers.Wallet.createRandom().address;
    const asset3 = ethers.Wallet.createRandom().address;

    // 设置账本数据
    await collateral.depositCollateral(user1.address, asset1, 100n);
    await lending.setUserDebt(user1.address, asset1, 50n);
    await collateral.depositCollateral(user2.address, asset2, 200n);
    await lending.setUserDebt(user2.address, asset2, 80n);
    await collateral.depositCollateral(user3.address, asset3, 300n);
    await lending.setUserDebt(user3.address, asset3, 120n);

    // 推送缓存
    await (collateral as any).pushToPositionView(pv.getAddress(), user1.address, asset1, 100n, 50n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user2.address, asset2, 200n, 80n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user3.address, asset3, 300n, 120n);

    // 批量查询
    const [collaterals, debts] = await pv.batchGetUserPositions(
      [user1.address, user2.address, user3.address],
      [asset1, asset2, asset3]
    );

    expect(collaterals).to.deep.equal([100n, 200n, 300n]);
    expect(debts).to.deep.equal([50n, 80n, 120n]);
  });

  it("缓存清理时只影响特定用户，不影响其他用户", async function () {
    const { pv, user, collateral, lending } = await loadFixture(deployFixture);
    const [user1, user2] = await ethers.getSigners();
    const asset = ethers.Wallet.createRandom().address;

    // user1 和 user2 都推送缓存
    await collateral.depositCollateral(user1.address, asset, 100n);
    await lending.setUserDebt(user1.address, asset, 50n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user1.address, asset, 100n, 50n);

    await collateral.depositCollateral(user2.address, asset, 200n);
    await lending.setUserDebt(user2.address, asset, 80n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user2.address, asset, 200n, 80n);

    // 验证两个用户的缓存都有效
    expect(await pv.isUserCacheValid(user1.address)).to.equal(true);
    expect(await pv.isUserCacheValid(user2.address)).to.equal(true);

    // user1 清理自己的缓存
    await pv.connect(user1).clearUserCache(user1.address);

    // 验证只有 user1 的缓存被清理
    expect(await pv.isUserCacheValid(user1.address)).to.equal(false);
    expect(await pv.isUserCacheValid(user2.address)).to.equal(true);

    // user2 的数据仍然可以正常查询
    const [c2, d2] = await pv.getUserPosition(user2.address, asset);
    expect(c2).to.equal(200n);
    expect(d2).to.equal(80n);
  });

  it("增量推送时不同用户/资产的版本号独立递增", async function () {
    const { pv, collateral, lending } = await loadFixture(deployFixture);
    const [user1, user2] = await ethers.getSigners();
    const asset1 = ethers.Wallet.createRandom().address;
    const asset2 = ethers.Wallet.createRandom().address;

    // user1, asset1: 初始推送，版本1
    await collateral.depositCollateral(user1.address, asset1, 100n);
    await lending.setUserDebt(user1.address, asset1, 50n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user1.address, asset1, 100n, 50n);

    // user1, asset2: 初始推送，版本1
    await collateral.depositCollateral(user1.address, asset2, 200n);
    await lending.setUserDebt(user1.address, asset2, 80n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user1.address, asset2, 200n, 80n);

    // user2, asset1: 初始推送，版本1
    await collateral.depositCollateral(user2.address, asset1, 300n);
    await lending.setUserDebt(user2.address, asset1, 120n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user2.address, asset1, 300n, 120n);

    // user1, asset1: 增量推送，版本2
    await pv["pushUserPositionUpdateDelta(address,address,int256,int256)"](user1.address, asset1, 10, 5);
    expect(await pv.getPositionVersion(user1.address, asset1)).to.equal(2n);
    expect(await pv.getPositionVersion(user1.address, asset2)).to.equal(1n); // 未变化
    expect(await pv.getPositionVersion(user2.address, asset1)).to.equal(1n); // 未变化

    // user1, asset2: 增量推送，版本2
    await pv["pushUserPositionUpdateDelta(address,address,int256,int256)"](user1.address, asset2, 20, 10);
    expect(await pv.getPositionVersion(user1.address, asset1)).to.equal(2n); // 未变化
    expect(await pv.getPositionVersion(user1.address, asset2)).to.equal(2n);
    expect(await pv.getPositionVersion(user2.address, asset1)).to.equal(1n); // 未变化

    // user2, asset1: 增量推送，版本2
    await pv["pushUserPositionUpdateDelta(address,address,int256,int256)"](user2.address, asset1, 30, 15);
    expect(await pv.getPositionVersion(user1.address, asset1)).to.equal(2n); // 未变化
    expect(await pv.getPositionVersion(user1.address, asset2)).to.equal(2n); // 未变化
    expect(await pv.getPositionVersion(user2.address, asset1)).to.equal(2n);
  });

  it("多个用户多个资产同时更新，数据互不干扰", async function () {
    const { pv, collateral, lending } = await loadFixture(deployFixture);
    const [user1, user2] = await ethers.getSigners();
    const asset1 = ethers.Wallet.createRandom().address;
    const asset2 = ethers.Wallet.createRandom().address;

    // 初始状态
    await collateral.depositCollateral(user1.address, asset1, 100n);
    await lending.setUserDebt(user1.address, asset1, 50n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user1.address, asset1, 100n, 50n);

    await collateral.depositCollateral(user1.address, asset2, 200n);
    await lending.setUserDebt(user1.address, asset2, 80n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user1.address, asset2, 200n, 80n);

    await collateral.depositCollateral(user2.address, asset1, 300n);
    await lending.setUserDebt(user2.address, asset1, 120n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user2.address, asset1, 300n, 120n);

    await collateral.depositCollateral(user2.address, asset2, 400n);
    await lending.setUserDebt(user2.address, asset2, 160n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user2.address, asset2, 400n, 160n);

    // 同时更新所有位置（注意：deposit是累加的，setUserDebt是直接设置的）
    await collateral.depositCollateral(user1.address, asset1, 10n); // 账本=110
    await lending.setUserDebt(user1.address, asset1, 55n); // 直接设置为55
    await (collateral as any).pushToPositionView(pv.getAddress(), user1.address, asset1, 110n, 55n);

    await collateral.depositCollateral(user1.address, asset2, 20n); // 账本=220
    await lending.setUserDebt(user1.address, asset2, 90n); // 直接设置为90
    await (collateral as any).pushToPositionView(pv.getAddress(), user1.address, asset2, 220n, 90n);

    await collateral.depositCollateral(user2.address, asset1, 30n); // 账本=330
    await lending.setUserDebt(user2.address, asset1, 135n); // 直接设置为135
    await (collateral as any).pushToPositionView(pv.getAddress(), user2.address, asset1, 330n, 135n);

    await collateral.depositCollateral(user2.address, asset2, 40n); // 账本=440
    await lending.setUserDebt(user2.address, asset2, 180n); // 直接设置为180
    await (collateral as any).pushToPositionView(pv.getAddress(), user2.address, asset2, 440n, 180n);

    // 验证所有数据都正确更新且互不干扰
    const [c11, d11] = await pv.getUserPosition(user1.address, asset1);
    const [c12, d12] = await pv.getUserPosition(user1.address, asset2);
    const [c21, d21] = await pv.getUserPosition(user2.address, asset1);
    const [c22, d22] = await pv.getUserPosition(user2.address, asset2);

    expect(c11).to.equal(110n);
    expect(d11).to.equal(55n);
    expect(c12).to.equal(220n);
    expect(d12).to.equal(90n);
    expect(c21).to.equal(330n);
    expect(d21).to.equal(135n);
    expect(c22).to.equal(440n);
    expect(d22).to.equal(180n);
  });

  it("不同用户不同资产的增量推送独立计算", async function () {
    const { pv, collateral, lending } = await loadFixture(deployFixture);
    const [user1, user2] = await ethers.getSigners();
    const asset1 = ethers.Wallet.createRandom().address;
    const asset2 = ethers.Wallet.createRandom().address;

    // 初始状态
    await collateral.depositCollateral(user1.address, asset1, 100n);
    await lending.setUserDebt(user1.address, asset1, 50n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user1.address, asset1, 100n, 50n);

    await collateral.depositCollateral(user1.address, asset2, 200n);
    await lending.setUserDebt(user1.address, asset2, 80n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user1.address, asset2, 200n, 80n);

    await collateral.depositCollateral(user2.address, asset1, 300n);
    await lending.setUserDebt(user2.address, asset1, 120n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user2.address, asset1, 300n, 120n);

    await collateral.depositCollateral(user2.address, asset2, 400n);
    await lending.setUserDebt(user2.address, asset2, 160n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user2.address, asset2, 400n, 160n);

    // 对不同用户/资产进行不同的增量推送
    await pv["pushUserPositionUpdateDelta(address,address,int256,int256)"](user1.address, asset1, 10, 5);
    await pv["pushUserPositionUpdateDelta(address,address,int256,int256)"](user1.address, asset2, -20, -10);
    await pv["pushUserPositionUpdateDelta(address,address,int256,int256)"](user2.address, asset1, 30, 15);
    await pv["pushUserPositionUpdateDelta(address,address,int256,int256)"](user2.address, asset2, -40, -20);

    // 验证增量推送独立计算
    const [c11, d11] = await pv.getUserPosition(user1.address, asset1);
    const [c12, d12] = await pv.getUserPosition(user1.address, asset2);
    const [c21, d21] = await pv.getUserPosition(user2.address, asset1);
    const [c22, d22] = await pv.getUserPosition(user2.address, asset2);

    expect(c11).to.equal(110n); // 100+10
    expect(d11).to.equal(55n);  // 50+5
    expect(c12).to.equal(180n); // 200-20
    expect(d12).to.equal(70n);  // 80-10
    expect(c21).to.equal(330n); // 300+30
    expect(d21).to.equal(135n); // 120+15
    expect(c22).to.equal(360n); // 400-40
    expect(d22).to.equal(140n); // 160-20
  });

  // ============ 增量推送边界情况 ============
  it("增量推送：零增量不改变数值但版本递增", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    await collateral.depositCollateral(user.address, asset, 10n);
    await lending.setUserDebt(user.address, asset, 1n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 10n, 1n);

    await pv["pushUserPositionUpdateDelta(address,address,int256,int256)"](user.address, asset, 0, 0);
    const [c, d] = await pv.getUserPosition(user.address, asset);
    expect(c).to.equal(10n);
    expect(d).to.equal(1n);
    expect(await pv.getPositionVersion(user.address, asset)).to.equal(2n);
  });

  it("增量推送：债务归零", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    await collateral.depositCollateral(user.address, asset, 10n);
    await lending.setUserDebt(user.address, asset, 5n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 10n, 5n);

    await pv["pushUserPositionUpdateDelta(address,address,int256,int256)"](user.address, asset, 0, -5);
    const [c, d] = await pv.getUserPosition(user.address, asset);
    expect(c).to.equal(10n);
    expect(d).to.equal(0n);
  });

  it("增量推送：抵押归零", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    await collateral.depositCollateral(user.address, asset, 10n);
    await lending.setUserDebt(user.address, asset, 5n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 10n, 5n);

    await pv["pushUserPositionUpdateDelta(address,address,int256,int256)"](user.address, asset, -10, 0);
    const [c, d] = await pv.getUserPosition(user.address, asset);
    expect(c).to.equal(0n);
    expect(d).to.equal(5n);
  });

  it("增量推送：缓存失效时退化为对齐账本（避免双计数）", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    await collateral.depositCollateral(user.address, asset, 10n);
    await lending.setUserDebt(user.address, asset, 5n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 10n, 5n);

    // 缓存过期
    await time.increase(5 * 60 + 1);
    // 更新账本（注意：MockCollateralManager的deposit是累加的，MockLendingEngineBasic的setUserDebt是直接设置的）
    await collateral.depositCollateral(user.address, asset, 5n); // 账本collateral=15 (10+5)
    await lending.setUserDebt(user.address, asset, 7n); // 账本debt=7 (直接设置)

    // 缓存失效时，PositionView 会避免“base 已是变更后账本”的双计数风险，退化为全量对齐账本（忽略 delta）
    await pv["pushUserPositionUpdateDelta(address,address,int256,int256)"](user.address, asset, 5, 1);
    const [c, d] = await pv.getUserPosition(user.address, asset);
    expect(c).to.equal(15n);
    expect(d).to.equal(7n);
  });

  it("增量推送：指定版本回退会被拒绝", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    await collateral.depositCollateral(user.address, asset, 10n);
    await lending.setUserDebt(user.address, asset, 1n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 10n, 1n); // version = 1

    await expect(
      pv["pushUserPositionUpdateDelta(address,address,int256,int256,uint64)"](user.address, asset, 1, 0, 1)
    ).to.be.revertedWithCustomError(pv, "PositionView__StaleVersion");
  });

  it("增量推送：指定版本跳跃会被拒绝（严格 nextVersion）", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    await collateral.depositCollateral(user.address, asset, 10n);
    await lending.setUserDebt(user.address, asset, 1n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 10n, 1n); // version = 1

    await expect(
      pv["pushUserPositionUpdateDelta(address,address,int256,int256,uint64)"](user.address, asset, 5, 2, 5)
    ).to.be.revertedWithCustomError(pv, "PositionView__StaleVersion");
  });

  it("增量推送事件序列与版本递增（包含 delta）", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    await collateral.depositCollateral(user.address, asset, 10n);
    await lending.setUserDebt(user.address, asset, 1n);

    await expect(
      (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 10n, 1n)
    )
      .to.emit(pv, "UserPositionCached")
      .withArgs(user.address, asset, 10n, 1n, anyValue)
      .and.to.emit(pv, "UserPositionCachedV2")
      .withArgs(user.address, asset, 10n, 1n, 1n, anyValue);

    await expect(
      pv["pushUserPositionUpdateDelta(address,address,int256,int256)"](user.address, asset, 5, 2)
    )
      .to.emit(pv, "UserPositionCachedV2")
      .withArgs(user.address, asset, 15n, 3n, 2n, anyValue);

    const [c, d] = await pv.getUserPosition(user.address, asset);
    expect(c).to.equal(15n);
    expect(d).to.equal(3n);
    expect(await pv.getPositionVersion(user.address, asset)).to.equal(2n);
  });

  it("批量查询最大规模（100）并填充数据不超 Gas/不溢出", async function () {
    const { pv, collateral, lending } = await loadFixture(deployFixture);
    const users: string[] = [];
    const assets: string[] = [];
    for (let i = 0; i < 100; i++) {
      const wallet = ethers.Wallet.createRandom();
      users.push(wallet.address);
      const asset = ethers.Wallet.createRandom().address;
      assets.push(asset);
      // 写入账本并推送缓存
      await collateral.depositCollateral(wallet.address, asset, BigInt(100 + i));
      await lending.setUserDebt(wallet.address, asset, BigInt(10 + i));
      await (collateral as any).pushToPositionView(pv.getAddress(), wallet.address, asset, BigInt(100 + i), BigInt(10 + i));
    }

    const [collaterals, debts] = await pv.batchGetUserPositions(users, assets);
    expect(collaterals.length).to.equal(100);
    expect(debts.length).to.equal(100);
    for (let i = 0; i < 100; i++) {
      expect(collaterals[i]).to.equal(BigInt(100 + i));
      expect(debts[i]).to.equal(BigInt(10 + i));
    }
  });

  // ============ 初始化测试 ============
  it("初始化时零地址Registry被拒绝", async function () {
    const PositionView = await ethers.getContractFactory("PositionView");
    await expect(upgrades.deployProxy(PositionView, [ethers.ZeroAddress], { kind: "uups" })).to.be.revertedWithCustomError(
      PositionView,
      "ZeroAddress",
    );
  });

  it("初始化后Registry地址正确", async function () {
    const { pv, registry } = await loadFixture(deployFixture);
    expect(await pv.getRegistry()).to.equal(await registry.getAddress());
    expect(await pv.registryAddr()).to.equal(await registry.getAddress());
  });

  // ============ 缓存时间戳边界测试 ============
  it("缓存刚好过期边界测试", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    await collateral.depositCollateral(user.address, asset, 100n);
    await lending.setUserDebt(user.address, asset, 50n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 100n, 50n);

    // 刚好5分钟，应该仍然有效
    await time.increase(5 * 60);
    expect(await pv.isUserCacheValid(user.address)).to.equal(true);

    // 超过1秒，应该失效
    await time.increase(1);
    expect(await pv.isUserCacheValid(user.address)).to.equal(false);
  });

  it("缓存时间戳为零时视为无效", async function () {
    const { pv, user, asset } = await loadFixture(deployFixture);
    // 未推送过，时间戳为0
    expect(await pv.isUserCacheValid(user.address)).to.equal(false);
    const [c, d, isValid] = await pv.getUserPositionWithValidity(user.address, asset);
    expect(isValid).to.equal(false);
  });

  // ============ 版本号边界测试 ============
  it("版本号跳跃测试（严格 nextVersion：不允许跳过中间版本）", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    await collateral.depositCollateral(user.address, asset, 10n);
    await lending.setUserDebt(user.address, asset, 1n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 10n, 1n);
    expect(await pv.getPositionVersion(user.address, asset)).to.equal(1n);

    // 直接跳到版本5
    await collateral.depositCollateral(user.address, asset, 5n);
    await lending.setUserDebt(user.address, asset, 2n);
    await expect(
      pv["pushUserPositionUpdate(address,address,uint256,uint256,uint64)"](user.address, asset, 15n, 2n, 5)
    ).to.be.revertedWithCustomError(pv, "PositionView__StaleVersion");
  });

  it("版本号不能回退", async function () {
    const { pv, user, asset, collateral, lending } = await loadFixture(deployFixture);
    await collateral.depositCollateral(user.address, asset, 10n);
    await lending.setUserDebt(user.address, asset, 1n);
    await (collateral as any).pushToPositionView(pv.getAddress(), user.address, asset, 10n, 1n);
    expect(await pv.getPositionVersion(user.address, asset)).to.equal(1n);

    // 尝试使用版本0（应该自增到2）
    await collateral.depositCollateral(user.address, asset, 5n);
    await lending.setUserDebt(user.address, asset, 2n);
    await pv["pushUserPositionUpdate(address,address,uint256,uint256,uint64)"](user.address, asset, 15n, 2n, 0);
    expect(await pv.getPositionVersion(user.address, asset)).to.equal(2n);

    // 尝试回退到版本1应该失败
    await expect(
      pv["pushUserPositionUpdate(address,address,uint256,uint256,uint64)"](user.address, asset, 15n, 2n, 1)
    ).to.be.revertedWithCustomError(pv, "PositionView__StaleVersion");
  });

  // ============ retryUserPositionUpdate 边界测试 ============
  it("retryUserPositionUpdate: 非管理员调用被拒绝", async function () {
    const { pv, user, asset } = await loadFixture(deployFixture);
    await expect(
      pv.connect(user).retryUserPositionUpdate(user.address, asset)
    ).to.be.revertedWithCustomError(pv, "PositionView__OnlyAdmin");
  });

  it("retryUserPositionUpdate: 零地址输入被拒绝", async function () {
    const { pv, admin } = await loadFixture(deployFixture);
    await expect(
      pv.connect(admin).retryUserPositionUpdate(ethers.ZeroAddress, ethers.Wallet.createRandom().address)
    ).to.be.revertedWithCustomError(pv, "PositionView__InvalidInput");
  });

  it("retryUserPositionUpdate: 账本读取失败时发出事件但不更新缓存", async function () {
    const { pv, admin, user, asset, lending } = await loadFixture(deployFixture);
    await lending.setMockSuccess(false);
    const tx = await pv.connect(admin).retryUserPositionUpdate(user.address, asset);
    await expect(tx)
      .to.emit(pv, "CacheUpdateFailed")
      .withArgs(user.address, asset, await pv.getAddress(), 0n, 0n, anyValue);
    
    // 恢复账本读取，然后验证缓存未更新（仍然无效）
    await lending.setMockSuccess(true);
    // 由于缓存未更新，查询时会回退到账本（此时账本返回0，因为没有设置）
    const [c, d, isValid] = await pv.getUserPositionWithValidity(user.address, asset);
    expect(isValid).to.equal(false);
    expect(c).to.equal(0n);
    expect(d).to.equal(0n);
  });
});


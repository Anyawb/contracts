/**
 * LiquidationManager（方案A）- 端到端测试
 *
 * 目标（对齐 docs/Architecture-Guide.md 方案A 口径）：
 * - 写路径直达账本：CM.seizeCollateralForLiquidation + LE.forceReduceDebt
 * - View 单点推送：通过 KEY_LIQUIDATION_VIEW.pushLiquidationUpdate/Batch（失败 best-effort，不回滚账本）
 * - 不在链上写清算记录/统计（统计由链下消费 DataPushed 聚合）
 */
import { expect } from 'chai';
import hardhat, { upgrades } from 'hardhat';
const { ethers } = hardhat;
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

describe('Liquidation - E2E (Direct ledger + single push)', function () {
  const KEY_CM = ethers.id('COLLATERAL_MANAGER');
  const KEY_LE = ethers.id('LENDING_ENGINE');
  const KEY_ACCESS_CONTROL = ethers.id('ACCESS_CONTROL_MANAGER');
  const KEY_LIQUIDATION_MANAGER = ethers.id('LIQUIDATION_MANAGER');
  const KEY_LIQUIDATION_VIEW = ethers.id('LIQUIDATION_VIEW');

  // 注意：MockAccessControlManager 使用的 role 哈希与 ActionKeys 在测试中可能不同，
  // 但本测试只需要保证 LiquidationManager 的 requireRole 能通过。
  const ACTION_LIQUIDATE = ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATE'));

  async function deployFixture() {
    const [liquidator, user, user2] = await ethers.getSigners();

    const registry = await (await ethers.getContractFactory('MockRegistry')).deploy();
    const acm = await (await ethers.getContractFactory('MockAccessControlManager')).deploy();
    const cm = await (await ethers.getContractFactory('MockCollateralManager')).deploy();
    const le = await (await ethers.getContractFactory('MockLendingEngineBasic')).deploy();
    const eventsView = await (await ethers.getContractFactory('MockLiquidationEventsView')).deploy();

    const liquidationManagerFactory = await ethers.getContractFactory('LiquidationManager');
    const liquidationManager = await upgrades.deployProxy(
      liquidationManagerFactory,
      [await registry.getAddress()],
      { kind: 'uups', initializer: 'initialize', unsafeAllow: ['constructor'] },
    );
    await liquidationManager.waitForDeployment();

    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(KEY_CM, await cm.getAddress());
    await registry.setModule(KEY_LE, await le.getAddress());
    await registry.setModule(KEY_LIQUIDATION_VIEW, await eventsView.getAddress());
    await registry.setModule(KEY_LIQUIDATION_MANAGER, await liquidationManager.getAddress());

    // 授权外部清算人
    await acm.grantRole(ACTION_LIQUIDATE, liquidator.address);
    // 授权模块自身以便向账本/权限链路兼容真实部署
    await acm.grantRole(ACTION_LIQUIDATE, await liquidationManager.getAddress());

    // Seed ledger state
    const asset = ethers.Wallet.createRandom().address;
    await cm.depositCollateral(user.address, asset, ethers.parseUnits('100', 18));
    await le.setUserDebt(user.address, asset, ethers.parseUnits('60', 18));
    await le.setTotalDebtByAsset(asset, ethers.parseUnits('60', 18));

    return { liquidationManager, registry, acm, cm, le, eventsView, liquidator, user, user2, asset };
  }

  it('单笔清算：扣押抵押 + 减债 + 单点推送计数', async function () {
    const { liquidationManager, cm, le, eventsView, liquidator, user, asset } = await loadFixture(deployFixture);

    const initialCollateral = await cm.getCollateral(user.address, asset);
    const initialDebt = await le.getUserDebt(user.address, asset);

    const seizeAmount = ethers.parseUnits('30', 18);
    const reduceAmount = ethers.parseUnits('30', 18);

    await expect(
      liquidationManager.connect(liquidator).liquidate(user.address, asset, asset, seizeAmount, reduceAmount, 0),
    ).to.not.be.reverted;

    const newCollateral = await cm.getCollateral(user.address, asset);
    const newDebt = await le.getUserDebt(user.address, asset);

    expect(newCollateral).to.equal(initialCollateral - seizeAmount);
    expect(newDebt).to.equal(initialDebt - reduceAmount);

    expect(await eventsView.getUserLiquidationCount(user.address)).to.equal(1n);
  });

  it('权限：非清算人调用应回滚', async function () {
    const { liquidationManager, user, asset } = await loadFixture(deployFixture);
    await expect(liquidationManager.connect(user).liquidate(user.address, asset, asset, 1n, 1n, 0)).to.be.reverted;
  });

  it('批量清算：两笔写入 + 批量推送计数', async function () {
    const { liquidationManager, cm, le, eventsView, liquidator, user, user2, asset } = await loadFixture(deployFixture);

    // seed second user
    await cm.depositCollateral(user2.address, asset, ethers.parseUnits('50', 18));
    await le.setUserDebt(user2.address, asset, ethers.parseUnits('20', 18));
    await le.setTotalDebtByAsset(asset, ethers.parseUnits('80', 18));

    const users = [user.address, user2.address];
    const collateralAssets = [asset, asset];
    const debtAssets = [asset, asset];
    const collateralAmounts = [ethers.parseUnits('10', 18), ethers.parseUnits('5', 18)];
    const debtAmounts = [ethers.parseUnits('10', 18), ethers.parseUnits('5', 18)];
    const bonuses = [0n, 0n];

    await expect(
      liquidationManager.connect(liquidator).batchLiquidate(users, collateralAssets, debtAssets, collateralAmounts, debtAmounts, bonuses),
    ).to.not.be.reverted;

    expect(await eventsView.getUserLiquidationCount(user.address)).to.equal(1n);
    expect(await eventsView.getUserLiquidationCount(user2.address)).to.equal(1n);
    expect(await eventsView.getTotalLiquidations()).to.equal(2n);
  });
});


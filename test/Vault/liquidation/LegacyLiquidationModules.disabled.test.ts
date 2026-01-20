import { expect } from 'chai';
import hardhat, { upgrades } from 'hardhat';
const { ethers } = hardhat;
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

/**
 * 目的：把“旧清算模块族/旧 key 不再被依赖”固化成可回归的断言。
 * - 目标清算写路径：KEY_LIQUIDATION_MANAGER → (KEY_CM + KEY_LE) → KEY_LIQUIDATION_VIEW
 * - 旧模块族 key 不应被注册/依赖（应保持为 0 地址）
 */
describe('Liquidation - legacy module keys should stay unset', function () {
  const KEY_ACCESS_CONTROL = ethers.id('ACCESS_CONTROL_MANAGER');
  const KEY_CM = ethers.id('COLLATERAL_MANAGER');
  const KEY_LE = ethers.id('LENDING_ENGINE');
  const KEY_LIQUIDATION_MANAGER = ethers.id('LIQUIDATION_MANAGER');
  const KEY_LIQUIDATION_VIEW = ethers.id('LIQUIDATION_VIEW');

  // Legacy keys (should NOT be registered in Direct-to-Ledger architecture)
  const KEY_LIQUIDATION_COLLATERAL_MANAGER = ethers.id('LIQUIDATION_COLLATERAL_MANAGER');
  const KEY_LIQUIDATION_REWARD_DISTRIBUTOR = ethers.id('LIQUIDATION_REWARD_DISTRIBUTOR');
  const KEY_LIQUIDATION_DEBT_MANAGER = ethers.id('LIQUIDATION_DEBT_MANAGER');
  const KEY_LIQUIDATION_CALCULATOR = ethers.id('LIQUIDATION_CALCULATOR');
  const KEY_LIQUIDATION_CONFIG_MANAGER = ethers.id('LIQUIDATION_CONFIG_MANAGER');

  async function deployFixture() {
    const registry = await (await ethers.getContractFactory("MockRegistry")).deploy();
    const acm = await (await ethers.getContractFactory("MockAccessControlManager")).deploy();
    const cm = await (await ethers.getContractFactory("MockCollateralManager")).deploy();
    const le = await (await ethers.getContractFactory("MockLendingEngineBasic")).deploy();
    const eventsView = await (await ethers.getContractFactory("MockLiquidationEventsView")).deploy();

    const liquidationManagerFactory = await ethers.getContractFactory('LiquidationManager');
    const liquidationManager = await upgrades.deployProxy(
      liquidationManagerFactory,
      [await registry.getAddress()],
      { kind: 'uups', initializer: 'initialize', unsafeAllow: ['constructor'] },
    );
    await liquidationManager.waitForDeployment();

    // bind only the Direct-to-Ledger keys
    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(KEY_CM, await cm.getAddress());
    await registry.setModule(KEY_LE, await le.getAddress());
    await registry.setModule(KEY_LIQUIDATION_VIEW, await eventsView.getAddress());
    await registry.setModule(KEY_LIQUIDATION_MANAGER, await liquidationManager.getAddress());

    return { registry };
  }

  it('legacy liquidation keys are zero', async function () {
    const { registry } = await loadFixture(deployFixture);

    expect(await registry.getModule(KEY_LIQUIDATION_COLLATERAL_MANAGER)).to.equal(ethers.ZeroAddress);
    expect(await registry.getModule(KEY_LIQUIDATION_REWARD_DISTRIBUTOR)).to.equal(ethers.ZeroAddress);
    expect(await registry.getModule(KEY_LIQUIDATION_DEBT_MANAGER)).to.equal(ethers.ZeroAddress);
    expect(await registry.getModule(KEY_LIQUIDATION_CALCULATOR)).to.equal(ethers.ZeroAddress);
    expect(await registry.getModule(KEY_LIQUIDATION_CONFIG_MANAGER)).to.equal(ethers.ZeroAddress);
  });
});


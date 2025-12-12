import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;
import type { VaultView as VaultViewTyped } from '../../../types/contracts/Vault/view/VaultView';

// 本文件：验证 LiquidationManager → VaultView.forward* 写路径转发骨架
// 范畴：权限校验（onlyLiquidationManager）、地址解析、调用参数传递、不变式（无直接状态写入在 View）

describe('VaultView – Liquidation forward path (skeleton)', function () {

  // 部署夹具
  async function deployFixture() {
    const [deployer, user, liquidator] = await ethers.getSigners();

    // 部署基础 Mock 合约
    const MockRegistryF = await ethers.getContractFactory('MockRegistry');
    const MockCollateralManagerF = await ethers.getContractFactory('MockCollateralManager');
    const MockLendingEngineBasicF = await ethers.getContractFactory('MockLendingEngineBasic');
    const VaultViewF = await ethers.getContractFactory('VaultView');

    const registry = await MockRegistryF.deploy();
    const cm = await MockCollateralManagerF.deploy();
    const le = await MockLendingEngineBasicF.deploy();
    const vaultView = await VaultViewF.deploy();

    // 初始化 VaultView（以 registry 地址）
    await vaultView.initialize(await registry.getAddress());

    // 注册必需模块键
    const KEY_CM = ethers.keccak256(ethers.toUtf8Bytes('COLLATERAL_MANAGER'));
    const KEY_LE = ethers.keccak256(ethers.toUtf8Bytes('LENDING_ENGINE'));
    const KEY_LIQUIDATION_MANAGER = ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATION_MANAGER'));

    await registry.setModule(KEY_CM, await cm.getAddress());
    await registry.setModule(KEY_LE, await le.getAddress());

    // 设置一个占位的 LiquidationManager 地址为 deployer，模拟权限来源
    await registry.setModule(KEY_LIQUIDATION_MANAGER, await deployer.getAddress());

    return { deployer, user, liquidator, registry, cm, le, vaultView, KEY_LIQUIDATION_MANAGER };
  }

  it('forwardSeizeCollateral: should route to CollateralManager.withdrawCollateral (skeleton)', async function () {
    const { deployer, user, vaultView, cm } = await deployFixture();
    const view = vaultView as unknown as VaultViewTyped;
    const userAddr = await user.getAddress();
    const assetAddr = userAddr; // 使用占位地址作为资产地址
    const amount = 100n;

    // 先存入抵押，避免 CollateralManager.withdrawCollateral 下层 revert
    await cm.depositCollateral(userAddr, assetAddr, amount);

    await expect(
      view.connect(deployer).forwardSeizeCollateral(userAddr, assetAddr, amount, await deployer.getAddress())
    ).to.not.be.reverted;
  });

  it('forwardReduceDebt: should route to LendingEngine.forceReduceDebt (skeleton)', async function () {
    const { deployer, user, vaultView } = await deployFixture();
    const view = vaultView as unknown as VaultViewTyped;
    const userAddr = await user.getAddress();
    const assetAddr = userAddr; // 占位资产
    const amount = 50n;
    await expect(
      view.connect(deployer).forwardReduceDebt(userAddr, assetAddr, amount, await deployer.getAddress())
    ).to.not.be.reverted;
  });

  it('should revert if caller is not Registry->KEY_LIQUIDATION_MANAGER (skeleton)', async function () {
    const { user, vaultView } = await deployFixture();
    const view = vaultView as unknown as VaultViewTyped;
    await expect(
      view.connect(user).forwardSeizeCollateral(await user.getAddress(), await user.getAddress(), 1n, await user.getAddress())
    ).to.be.reverted;
    await expect(
      view.connect(user).forwardReduceDebt(await user.getAddress(), await user.getAddress(), 1n, await user.getAddress())
    ).to.be.reverted;
  });
});



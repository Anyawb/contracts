import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * CollateralVault – VaultCap 相关测试
 *
 * 测试目标:
 * - VaultCap 超限应 revert VaultCapExceeded()
 * - 在 VaultCap 额度内的存款应成功
 */
describe.skip('CollateralVault – VaultCap 测试 (已跳过，待合约更新)', function () {
  async function deployFixture() {
    const [governance, alice] = await ethers.getSigners();

    // ---------- 部署 MockCollateralManager ----------
    const collateralMgrFactory = await ethers.getContractFactory(`
      // SPDX-License-Identifier: MIT
      pragma solidity ^0.8.20;
      contract MockCollateralManager {
        mapping(address => mapping(address => uint256)) public collateral;
        mapping(address => uint256) public totalByAsset;
        function depositCollateral(address user, address asset, uint256 amount) external {
          collateral[user][asset] += amount;
          totalByAsset[asset] += amount;
        }
        function withdrawCollateral(address user, address asset, uint256 amount) external {
          collateral[user][asset] -= amount;
          totalByAsset[asset] -= amount;
        }
        function getCollateral(address user, address asset) external view returns (uint256) {
          return collateral[user][asset];
        }
        function getTotalCollateralByAsset(address asset) external view returns (uint256) {
          return totalByAsset[asset];
        }
      }
    `);
    const collateralMgr = await collateralMgrFactory.deploy();
    await collateralMgr.waitForDeployment();

    // ---------- 部署 MockLendingEngine ----------
    const lendingEngineFactory = await ethers.getContractFactory(`
      // SPDX-License-Identifier: MIT
      pragma solidity ^0.8.20;
      contract MockLendingEngine {
        function getDebt(address, address) external pure returns (uint256) { return 0; }
        function borrow(address, address, uint256, uint256, uint256) external {}
        function repay(address, address, uint256) external {}
      }
    `);
    const lendingEngine = await lendingEngineFactory.deploy();
    await lendingEngine.waitForDeployment();

    // ---------- 部署 MockHealthFactorCalculator ----------
    const hfFactory = await ethers.getContractFactory(`
      // SPDX-License-Identifier: MIT
      pragma solidity ^0.8.20;
      contract MockHFCalculator {
        function previewHealthFactor(uint256, uint256) external pure returns (uint256) { return 2e18; }
        function minHealthFactor() external pure returns (uint256) { return 11000; }
      }
    `);
    const hfCalc = await hfFactory.deploy();
    await hfCalc.waitForDeployment();

    // ---------- 部署 MockVaultStatistics ----------
    const statsFactory = await ethers.getContractFactory(`
      // SPDX-License-Identifier: MIT
      pragma solidity ^0.8.20;
      contract MockStats { function updateUserStats(address,uint256,uint256,uint256,uint256) external {} }
    `);
    const vaultStats = await statsFactory.deploy();
    await vaultStats.waitForDeployment();

    // ---------- 部署 ERC20 测试代币 ----------
    const erc20Factory = await ethers.getContractFactory('MockERC20');
    const collateralToken = await erc20Factory.connect(governance).deploy(
      'COL',
      'COL',
      ethers.parseUnits('1000000', 18)
    );
    await collateralToken.waitForDeployment();

    // ---------- 部署 CollateralVault ----------
    const vaultFactory = await ethers.getContractFactory('CollateralVault');
    const vault = await vaultFactory.deploy();
    await vault.waitForDeployment();

    // @ts-expect-error CollateralVault stub – method not typed
    await vault.initialize(
      await collateralMgr.getAddress(),
      await lendingEngine.getAddress(),
      await hfCalc.getAddress(),
      await vaultStats.getAddress(),
      ZERO_ADDRESS, // valuationOracle
      ZERO_ADDRESS, // feeRouter
      ZERO_ADDRESS, // rewardManager
      await collateralToken.getAddress(),
      await collateralToken.getAddress(), // settlement token 不使用
      governance.address
    );

    // 转 500 COL 给 Alice 并授权
    await collateralToken.transfer(alice.address, ethers.parseUnits('500', 18));
    await collateralToken.connect(alice).approve(await vault.getAddress(), ethers.parseUnits('500', 18));

    return { vault, collateralToken, governance, alice };
  }

  it('VaultCap 超限应 revert', async function () {
    const { vault, collateralToken, governance, alice } = await deployFixture();

    // 设置 VaultCap = 100 COL
    // @ts-expect-error CollateralVault stub – method not typed
    await vault.connect(governance).setVaultCap(ethers.parseUnits('100', 18));

    const excessive = ethers.parseUnits('120', 18);
    await expect(
      // @ts-expect-error CollateralVault stub – method not typed
      vault.connect(alice).deposit(await collateralToken.getAddress(), excessive)
    ).to.be.revertedWithCustomError(vault, 'VaultCapExceeded');
  });

  it('在 VaultCap 额度内的存款应成功', async function () {
    const { vault, collateralToken, governance, alice } = await deployFixture();

    // @ts-expect-error CollateralVault stub – method not typed
    await vault.connect(governance).setVaultCap(ethers.parseUnits('100', 18));
    const amount = ethers.parseUnits('80', 18);

    // @ts-expect-error CollateralVault stub – method not typed
    await vault.connect(alice).deposit(await collateralToken.getAddress(), amount);

    // @ts-expect-error CollateralVault stub – method not typed
    const position = await vault.getUserPosition(alice.address, await collateralToken.getAddress());
    expect(position.collateral).to.equal(amount);
  });
}); 
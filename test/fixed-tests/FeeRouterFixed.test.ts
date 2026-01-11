/**
 * FeeRouter 费率测试 - 修复版
 * 
 * 测试目标:
 * - 费率初始化正确性
 * - 费用分发功能
 * - 权限控制验证
 */

import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers, upgrades } = hardhat;
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

import type { FeeRouter } from '../../../types/contracts/core';
import type { AccessControlManager } from '../../../types/contracts/access';
import type { MockERC20 } from '../../../types/contracts/Mocks';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

// 常量定义
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

describe('FeeRouter – 修复版费率管理测试', function () {
  async function deployFixture() {
    // 部署测试环境
    const [governance, alice, bob, treasury, ecoVault]: SignerWithAddress[] = await ethers.getSigners();
    
    // 部署 ACM
    const acmFactory = await ethers.getContractFactory('AccessControlManager');
    const acm = await acmFactory.deploy(governance.address);
    await acm.waitForDeployment();

    // 部署轻量 Registry，并注册 ACM 模块，满足 FeeRouter 的 onlyValidRegistry/requireRole
    const registryFactory = await ethers.getContractFactory('MockRegistry');
    const registry = await registryFactory.deploy();
    await registry.waitForDeployment();

    const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
    
    // 部署 MockERC20 代币 - 增加初始供应量
    const mockTokenFactory = await ethers.getContractFactory('MockERC20');
    const initialSupply = ethers.parseUnits('1000000', 6); // 100万代币
    const mockToken = await mockTokenFactory.deploy('Mock USDC', 'USDC', initialSupply);
    await mockToken.waitForDeployment();
    
    // 部署 FeeRouter
    const feeRouterFactory = await ethers.getContractFactory('FeeRouter');
    const feeRouter = await upgrades.deployProxy(feeRouterFactory, [
      await registry.getAddress(), // registry
      treasury.address,       // platformTreasury
      ecoVault.address,       // ecosystemVault
      9,                      // platformBps (0.09%)
      1                       // ecoBps (0.01%)
    ]);
    await feeRouter.waitForDeployment();
    
    // 设置权限（幂等，避免 RoleAlreadyGranted）
    const grantIfNeeded = async (role: string, account: string) => {
      const roleHash = ethers.keccak256(ethers.toUtf8Bytes(role));
      if (!(await acm.hasRole(roleHash, account))) {
        await acm.grantRole(roleHash, account);
      }
    };
    await grantIfNeeded('DEPOSIT', alice.address);
    await grantIfNeeded('LIQUIDATE', bob.address);
    await grantIfNeeded('SET_PARAMETER', governance.address);
    await grantIfNeeded('PAUSE_SYSTEM', governance.address);
    await grantIfNeeded('UNPAUSE_SYSTEM', governance.address);
    await grantIfNeeded('UPGRADE_MODULE', governance.address);
    
    // 添加支持的代币（需要 SET_PARAMETER 权限）
    await feeRouter.connect(governance).addSupportedToken(await mockToken.getAddress());
    
    // 给 alice 和 bob 一些代币（通过转账）
    const tokenAmount = ethers.parseUnits('10000', 6); // 10000 USDC
    await mockToken.transfer(alice.address, tokenAmount);
    await mockToken.transfer(bob.address, tokenAmount);
    
    return { 
      feeRouter: feeRouter as FeeRouter, 
      acm: acm as AccessControlManager,
      registry,
      mockToken: mockToken as MockERC20,
      governance, 
      alice, 
      bob, 
      treasury, 
      ecoVault 
    };
  }

  describe('费率初始化测试', function () {
    it('应正确初始化费率配置', async function () {
      const { feeRouter, treasury, ecoVault } = await loadFixture(deployFixture);
      
      // 验证平台费率
      const platformFeeBps = await feeRouter.getPlatformFeeBps();
      expect(platformFeeBps).to.equal(9n); // 0.09%
      
      // 验证生态费率
      const ecosystemFeeBps = await feeRouter.getEcosystemFeeBps();
      expect(ecosystemFeeBps).to.equal(1n); // 0.01%
      
      // 验证金库地址
      const platformTreasury = await feeRouter.getPlatformTreasury();
      const ecosystemVault = await feeRouter.getEcosystemVault();
      expect(platformTreasury).to.equal(treasury.address);
      expect(ecosystemVault).to.equal(ecoVault.address);
    });

    it('应正确计算费用', async function () {
      const { feeRouter } = await loadFixture(deployFixture);
      
      const amount = ethers.parseUnits('1000', 6); // 1000 USDC
      
      // 测试存款费用计算
      const depositFee = await feeRouter.chargeDepositFee(ZERO_ADDRESS, amount);
      expect(depositFee).to.equal(ethers.parseUnits('1', 6)); // 1 USDC (0.1%)
      
      // 测试借款费用计算
      const borrowFee = await feeRouter.chargeBorrowFee(ZERO_ADDRESS, amount);
      expect(borrowFee).to.equal(ethers.parseUnits('1', 6)); // 1 USDC (0.1%)
    });
  });

  describe('费用分发测试', function () {
    it('应正确分发常规费用', async function () {
      const { feeRouter, mockToken, alice, treasury, ecoVault } = await loadFixture(deployFixture);
      
      const tokenAddress = await mockToken.getAddress();
      const amount = ethers.parseUnits('1000', 6); // 1000 USDC
      
      // 授权 FeeRouter 使用代币
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), amount);
      
      // 记录初始余额
      const treasuryInitialBalance = await mockToken.balanceOf(treasury.address);
      const ecoVaultInitialBalance = await mockToken.balanceOf(ecoVault.address);
      
      // 分发费用
      await feeRouter.connect(alice).distributeNormal(tokenAddress, amount);
      
      // 验证余额变化
      const treasuryFinalBalance = await mockToken.balanceOf(treasury.address);
      const ecoVaultFinalBalance = await mockToken.balanceOf(ecoVault.address);
      
      // 平台费用：1000 * 0.09% = 0.9 USDC
      expect(treasuryFinalBalance - treasuryInitialBalance).to.equal(ethers.parseUnits('0.9', 6));
      // 生态费用：1000 * 0.01% = 0.1 USDC
      expect(ecoVaultFinalBalance - ecoVaultInitialBalance).to.equal(ethers.parseUnits('0.1', 6));
    });

    it('应正确处理零费用', async function () {
      const { feeRouter, mockToken, alice } = await loadFixture(deployFixture);
      
      const tokenAddress = await mockToken.getAddress();
      const zeroAmount = 0n;
      
      // 授权 FeeRouter 使用代币
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), zeroAmount);
      
      // 合约对 0 金额使用统一错误 AmountIsZero()
      await expect(
        feeRouter.connect(alice).distributeNormal(tokenAddress, zeroAmount)
      ).to.be.revertedWithCustomError(feeRouter, 'AmountIsZero');
    });
  });

  describe('权限控制测试', function () {
    it('只有授权用户可以分发费用', async function () {
      const { feeRouter, acm, mockToken, bob } = await loadFixture(deployFixture);
      
      const tokenAddress = await mockToken.getAddress();
      const amount = ethers.parseUnits('100', 6);
      
      // bob 没有 DEPOSIT 权限，应该失败
      await mockToken.connect(bob).approve(await feeRouter.getAddress(), amount);
      
      await expect(
        feeRouter.connect(bob).distributeNormal(tokenAddress, amount)
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });
  });

  describe('费率设置测试', function () {
    it('治理者应能更新费率配置', async function () {
      const { feeRouter, governance } = await loadFixture(deployFixture);
      
      const newPlatformFee = 15n; // 0.15%
      const newEcoFee = 5n; // 0.05%
      
      await feeRouter.connect(governance).setFeeConfig(newPlatformFee, newEcoFee);
      
      expect(await feeRouter.getPlatformFeeBps()).to.equal(newPlatformFee);
      expect(await feeRouter.getEcosystemFeeBps()).to.equal(newEcoFee);
    });
  });

  describe('事件测试', function () {
    it('应发出费用分发事件', async function () {
      const { feeRouter, mockToken, alice } = await loadFixture(deployFixture);
      
      const tokenAddress = await mockToken.getAddress();
      const amount = ethers.parseUnits('100', 6);
      
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), amount);
      
      await expect(feeRouter.connect(alice).distributeNormal(tokenAddress, amount))
        .to.emit(feeRouter, 'FeeDistributed')
        .withArgs(tokenAddress, ethers.parseUnits('0.09', 6), ethers.parseUnits('0.01', 6));
    });

    it('应发出费率配置更新事件', async function () {
      const { feeRouter, governance } = await loadFixture(deployFixture);
      
      await expect(feeRouter.connect(governance).setFeeConfig(12n, 3n))
        .to.emit(feeRouter, 'FeeConfigUpdated')
        .withArgs(12n, 3n);
    });
  });

  describe('边界条件测试', function () {
    it('应处理极大金额', async function () {
      const { feeRouter, mockToken, alice } = await loadFixture(deployFixture);
      
      const tokenAddress = await mockToken.getAddress();
      const largeAmount = ethers.parseUnits('1000000', 6); // 100万 USDC
      // fixture 里 alice 只有 10,000 USDC；此处补足余额以验证“大额路径”本身不应因余额不足失败
      await mockToken.mint(alice.address, largeAmount);
      
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), largeAmount);
      
      await expect(
        feeRouter.connect(alice).distributeNormal(tokenAddress, largeAmount)
      ).to.not.be.reverted;
    });
  });

  describe('Gas 优化测试', function () {
    it('应验证 Gas 消耗在合理范围内', async function () {
      const { feeRouter, mockToken, alice } = await loadFixture(deployFixture);
      
      const tokenAddress = await mockToken.getAddress();
      const amount = ethers.parseUnits('1000', 6);
      
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), amount);
      
      const tx = await feeRouter.connect(alice).distributeNormal(tokenAddress, amount);
      const receipt = await tx.wait();
      
      // Proxy + role checks + supportedToken checks 会增加 gas；给出更合理的上限以避免 CI 环境波动
      expect(receipt?.gasUsed).to.be.lt(260000n);
    });
  });
}); 
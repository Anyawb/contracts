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
    
    // 部署 MockERC20 代币 - 增加初始供应量
    const mockTokenFactory = await ethers.getContractFactory('MockERC20');
    const initialSupply = ethers.parseUnits('1000000', 6); // 100万代币
    const mockToken = await mockTokenFactory.deploy('Mock USDC', 'USDC', initialSupply);
    await mockToken.waitForDeployment();
    
    // 部署 FeeRouter
    const feeRouterFactory = await ethers.getContractFactory('FeeRouter');
    const feeRouter = await upgrades.deployProxy(feeRouterFactory, [
      await acm.getAddress(), // accessControlManager
      treasury.address,       // platformTreasury
      ecoVault.address,       // ecosystemVault
      9,                      // platformBps (0.09%)
      1                       // ecoBps (0.01%)
    ]);
    await feeRouter.waitForDeployment();
    
    // 设置权限
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('DEPOSIT')), alice.address);
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATE')), bob.address);
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('UNPAUSE_SYSTEM')), governance.address);
    
    // 添加支持的代币
    await feeRouter.addSupportedToken(await mockToken.getAddress());
    
    // 给 alice 和 bob 一些代币（通过转账）
    const tokenAmount = ethers.parseUnits('10000', 6); // 10000 USDC
    await mockToken.transfer(alice.address, tokenAmount);
    await mockToken.transfer(bob.address, tokenAmount);
    
    return { 
      feeRouter: feeRouter as FeeRouter, 
      acm: acm as AccessControlManager,
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
      const platformFeeBps = await feeRouter.platformFeeBps();
      expect(platformFeeBps).to.equal(9n); // 0.09%
      
      // 验证生态费率
      const ecosystemFeeBps = await feeRouter.ecosystemFeeBps();
      expect(ecosystemFeeBps).to.equal(1n); // 0.01%
      
      // 验证金库地址
      const platformTreasury = await feeRouter.platformTreasury();
      const ecosystemVault = await feeRouter.ecosystemVault();
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
      
      // 分发零费用应该成功
      await expect(
        feeRouter.connect(alice).distributeNormal(tokenAddress, zeroAmount)
      ).to.not.be.reverted;
    });
  });

  describe('权限控制测试', function () {
    it('只有授权用户可以分发费用', async function () {
      const { feeRouter, mockToken, bob } = await loadFixture(deployFixture);
      
      const tokenAddress = await mockToken.getAddress();
      const amount = ethers.parseUnits('100', 6);
      
      // bob 没有 DEPOSIT 权限，应该失败
      await mockToken.connect(bob).approve(await feeRouter.getAddress(), amount);
      
      await expect(
        feeRouter.connect(bob).distributeNormal(tokenAddress, amount)
      ).to.be.revertedWithCustomError(feeRouter, 'MissingRole');
    });
  });

  describe('费率设置测试', function () {
    it('治理者应能更新费率配置', async function () {
      const { feeRouter, governance } = await loadFixture(deployFixture);
      
      const newPlatformFee = 15n; // 0.15%
      const newEcoFee = 5n; // 0.05%
      
      await feeRouter.connect(governance).setFeeConfig(newPlatformFee, newEcoFee);
      
      expect(await feeRouter.platformFeeBps()).to.equal(newPlatformFee);
      expect(await feeRouter.ecosystemFeeBps()).to.equal(newEcoFee);
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
        .withArgs(tokenAddress, ethers.parseUnits('0.09', 6), ethers.parseUnits('0.01', 6), ethers.keccak256(ethers.toUtf8Bytes('NORMAL')));
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
      
      // 验证 Gas 消耗在合理范围内（通常 < 150,000 gas）
      expect(receipt?.gasUsed).to.be.lt(150000n);
    });
  });
}); 
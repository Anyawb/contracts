/**
 * FeeRouter 费率测试
 * 
 * 测试目标:
 * - 费率初始化正确性
 * - 费用分发功能
 * - 动态费率设置
 * - 权限控制验证
 * - 批量费用分发
 * - 费用统计功能
 */

import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;
const { upgrades } = hardhat;

import type { FeeRouter } from '../../../types/contracts/core';
import type { AccessControlManager } from '../../../types/contracts/access';
import type { MockERC20 } from '../../../types/contracts/Mocks';

import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

// 常量定义
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

describe('FeeRouter – 费率管理测试', function () {
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
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER')), governance.address);
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('PAUSE_SYSTEM')), governance.address);
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('UNPAUSE_SYSTEM')), governance.address);
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE')), governance.address);
    
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
      const { feeRouter, treasury, ecoVault } = await deployFixture();
      
      // 验证平台费率
      const platformFeeBps = await feeRouter.platformFeeBps();
      expect(platformFeeBps).to.equal(9); // 0.09%
      
      // 验证生态费率
      const ecosystemFeeBps = await feeRouter.ecosystemFeeBps();
      expect(ecosystemFeeBps).to.equal(1); // 0.01%
      
      // 验证总费率
      const totalFeeRate = await feeRouter.getFeeRate();
      expect(totalFeeRate).to.equal(10); // 0.1%
      
      // 验证金库地址
      const platformTreasury = await feeRouter.platformTreasury();
      const ecosystemVault = await feeRouter.ecosystemVault();
      expect(platformTreasury).to.equal(treasury.address);
      expect(ecosystemVault).to.equal(ecoVault.address);
    });

    it('应正确计算费用', async function () {
      const { feeRouter } = await deployFixture();
      
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
      const { feeRouter, mockToken, alice, treasury, ecoVault } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const amount = ethers.parseUnits('1000', 6); // 1000 USDC
      
      // 授权 FeeRouter 使用代币
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), amount);
      
      // 记录初始余额
      const treasuryInitialBalance = await mockToken.balanceOf(treasury.address);
      const ecoVaultInitialBalance = await mockToken.balanceOf(ecoVault.address);
      const aliceInitialBalance = await mockToken.balanceOf(alice.address);
      
      // 分发费用
      const tx = await feeRouter.connect(alice).distributeNormal(tokenAddress, amount);
      const receipt = await tx.wait();
      
      // 验证交易成功执行
      expect(receipt?.status).to.equal(1);
      
      // 验证余额变化
      const treasuryFinalBalance = await mockToken.balanceOf(treasury.address);
      const ecoVaultFinalBalance = await mockToken.balanceOf(ecoVault.address);
      const aliceFinalBalance = await mockToken.balanceOf(alice.address);
      
      // 平台应收到 0.9 USDC (0.09%)
      expect(treasuryFinalBalance - treasuryInitialBalance).to.equal(ethers.parseUnits('0.9', 6));
      
      // 生态金库应收到 0.1 USDC (0.01%)
      expect(ecoVaultFinalBalance - ecoVaultInitialBalance).to.equal(ethers.parseUnits('0.1', 6));
      
      // Alice 应收到剩余金额 999 USDC
      expect(aliceFinalBalance - aliceInitialBalance).to.equal(ethers.parseUnits('999', 6));
    });

    it('应正确分发清算费用', async function () {
      const { feeRouter, mockToken, bob, treasury, ecoVault } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const amount = ethers.parseUnits('500', 6); // 500 USDC
      
      // 授权 FeeRouter 使用代币
      await mockToken.connect(bob).approve(await feeRouter.getAddress(), amount);
      
      // 记录初始余额
      const treasuryInitialBalance = await mockToken.balanceOf(treasury.address);
      const ecoVaultInitialBalance = await mockToken.balanceOf(ecoVault.address);
      
      // 分发清算费用
      await feeRouter.connect(bob).distributeLiquidationFee(tokenAddress, amount);
      
      // 验证余额变化
      const treasuryFinalBalance = await mockToken.balanceOf(treasury.address);
      const ecoVaultFinalBalance = await mockToken.balanceOf(ecoVault.address);
      
      // 平台应收到 0.45 USDC (0.09%)
      expect(treasuryFinalBalance - treasuryInitialBalance).to.equal(ethers.parseUnits('0.45', 6));
      
      // 生态金库应收到 0.05 USDC (0.01%)
      expect(ecoVaultFinalBalance - ecoVaultInitialBalance).to.equal(ethers.parseUnits('0.05', 6));
    });
  });

  describe('批量费用分发测试', function () {
    it('应正确执行批量费用分发', async function () {
      const { feeRouter, mockToken, alice } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const amounts = [
        ethers.parseUnits('100', 6),  // 100 USDC
        ethers.parseUnits('200', 6),  // 200 USDC
        ethers.parseUnits('300', 6)   // 300 USDC
      ];
      const feeTypes = [
        ethers.keccak256(ethers.toUtf8Bytes('DEPOSIT')),
        ethers.keccak256(ethers.toUtf8Bytes('BORROW')),
        ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATE'))
      ];
      
      // 授权 FeeRouter 使用代币
      const totalAmount = amounts.reduce((sum, amount) => sum + amount, 0n);
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), totalAmount);
      
      // 执行批量分发
      const tx = await feeRouter.connect(alice).batchDistribute(tokenAddress, amounts, feeTypes);
      const receipt = await tx.wait();
      
      // 验证交易成功执行
      expect(receipt?.status).to.equal(1);
    });
  });

  describe('动态费率测试', function () {
    it('应正确设置和分发动态费率', async function () {
      const { feeRouter, mockToken, governance, alice } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('CUSTOM_FEE'));
      const dynamicFeeBps = 50; // 0.5%
      
      // 设置动态费率
      await feeRouter.connect(governance).setDynamicFee(tokenAddress, feeType, dynamicFeeBps);
      
      // 验证动态费率设置
      const retrievedFee = await feeRouter.getDynamicFee(tokenAddress, feeType);
      expect(retrievedFee).to.equal(dynamicFeeBps);
      
      const amount = ethers.parseUnits('1000', 6); // 1000 USDC
      
      // 授权 FeeRouter 使用代币
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), amount);
      
      // 分发动态费用
      await feeRouter.connect(alice).distributeDynamic(tokenAddress, amount, feeType);
    });
  });

  describe('权限控制测试', function () {
    it('非授权用户应无法分发费用', async function () {
      const { feeRouter, mockToken, bob } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const amount = ethers.parseUnits('100', 6);
      
      // bob 没有 DEPOSIT 权限，应该失败
      await expect(
        feeRouter.connect(bob).distributeNormal(tokenAddress, amount)
      ).to.be.revertedWithCustomError(feeRouter, 'MissingRole');
    });

    it('非授权用户应无法设置费率', async function () {
      const { feeRouter, alice } = await deployFixture();
      
      // alice 没有 SET_PARAMETER 权限，应该失败
      await expect(
        feeRouter.connect(alice).setFeeConfig(10, 2)
      ).to.be.revertedWithCustomError(feeRouter, 'MissingRole');
    });

    it('授权用户应能正确设置费率', async function () {
      const { feeRouter, governance } = await deployFixture();
      
      const newPlatformBps = 10; // 0.1%
      const newEcoBps = 2;        // 0.02%
      
      // governance 有 SET_PARAMETER 权限，应该成功
      await feeRouter.connect(governance).setFeeConfig(newPlatformBps, newEcoBps);
      
      // 验证费率更新
      const platformFeeBps = await feeRouter.platformFeeBps();
      const ecosystemFeeBps = await feeRouter.ecosystemFeeBps();
      
      expect(platformFeeBps).to.equal(newPlatformBps);
      expect(ecosystemFeeBps).to.equal(newEcoBps);
    });
  });

  describe('费用统计测试', function () {
    it('应正确统计费用', async function () {
      const { feeRouter, mockToken, alice } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const amount = ethers.parseUnits('1000', 6);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('DEPOSIT'));
      
      // 授权 FeeRouter 使用代币
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), amount);
      
      // 分发费用
      await feeRouter.connect(alice).distributeNormal(tokenAddress, amount);
      
      // 验证费用统计
      const feeStatistics = await feeRouter.getFeeStatistics(tokenAddress, feeType);
      expect(feeStatistics).to.equal(amount);
      
      // 验证费用缓存
      const feeCache = await feeRouter.getFeeCache(tokenAddress, feeType);
      expect(feeCache).to.equal(amount);
    });
  });

  describe('代币支持测试', function () {
    it('应正确管理支持的代币', async function () {
      const { feeRouter, mockToken, governance } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      
      // 验证代币已支持
      const isSupported = await feeRouter.isTokenSupported(tokenAddress);
      expect(isSupported).to.be.true;
      
      // 获取支持的代币列表
      const supportedTokens = await feeRouter.getSupportedTokens();
      expect(supportedTokens).to.include(tokenAddress);
      
      // 移除代币支持
      await feeRouter.connect(governance).removeSupportedToken(tokenAddress);
      
      // 验证代币已移除
      const isSupportedAfter = await feeRouter.isTokenSupported(tokenAddress);
      expect(isSupportedAfter).to.be.false;
    });

    it('不支持的代币应无法分发费用', async function () {
      const { feeRouter, alice } = await deployFixture();
      
      const unsupportedToken = ZERO_ADDRESS;
      const amount = ethers.parseUnits('100', 6);
      
      // 不支持的代币应该失败
      await expect(
        feeRouter.connect(alice).distributeNormal(unsupportedToken, amount)
      ).to.be.revertedWithCustomError(feeRouter, 'FeeRouter__TokenNotSupported');
    });
  });

  describe('暂停功能测试', function () {
    it('应正确暂停和恢复功能', async function () {
      const { feeRouter, mockToken, alice, governance } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const amount = ethers.parseUnits('100', 6);
      
      // 授权 FeeRouter 使用代币
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), amount);
      
      // 暂停合约
      await feeRouter.connect(governance).pause();
      
      // 暂停后应无法分发费用
      await expect(
        feeRouter.connect(alice).distributeNormal(tokenAddress, amount)
      ).to.be.revertedWithCustomError(feeRouter, 'EnforcedPause');
      
      // 恢复合约
      await feeRouter.connect(governance).unpause();
      
      // 恢复后应能正常分发费用
      await expect(
        feeRouter.connect(alice).distributeNormal(tokenAddress, amount)
      ).to.not.be.reverted;
    });
  });

  describe('边界条件测试', function () {
    it('零金额应无法分发', async function () {
      const { feeRouter, mockToken, alice } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const zeroAmount = 0n;
      
      await expect(
        feeRouter.connect(alice).distributeNormal(tokenAddress, zeroAmount)
      ).to.be.revertedWithCustomError(feeRouter, 'AmountIsZero');
    });

    it('无效费率配置应被拒绝', async function () {
      const { feeRouter, governance } = await deployFixture();
      
      // 总费率超过 100% 应该失败
      await expect(
        feeRouter.connect(governance).setFeeConfig(5000, 5001) // 50% + 50.01% = 100.01%
      ).to.be.revertedWithCustomError(feeRouter, 'FeeRouter__InvalidConfig');
    });
  });
}); 
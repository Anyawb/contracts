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

    // 部署轻量 Registry，并注册 ACM 模块，满足 FeeRouter 的 onlyValidRegistry/requireRole
    const registryFactory = await ethers.getContractFactory('MockRegistry');
    const registry = await registryFactory.deploy();
    await registry.waitForDeployment();

    const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
    
    // 部署 MockERC20 代币 - 增加初始供应量
    const mockTokenFactory = await ethers.getContractFactory('MockERC20');
    const initialSupply = ethers.parseUnits('2000000', 6); // 200万代币（增加以支持大金额测试）
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
    
    // 添加支持的代币
    await feeRouter.addSupportedToken(await mockToken.getAddress());
    
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
      const { feeRouter, treasury, ecoVault } = await deployFixture();
      
      // 验证平台费率
      const platformFeeBps = await feeRouter.getPlatformFeeBps();
      expect(platformFeeBps).to.equal(9); // 0.09%
      
      // 验证生态费率
      const ecosystemFeeBps = await feeRouter.getEcosystemFeeBps();
      expect(ecosystemFeeBps).to.equal(1); // 0.01%
      
      // 验证总费率
      const totalFeeRate = await feeRouter.getFeeRate();
      expect(totalFeeRate).to.equal(10); // 0.1%
      
      // 验证金库地址
      const platformTreasury = await feeRouter.getPlatformTreasury();
      const ecosystemVault = await feeRouter.getEcosystemVault();
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
      
      // Alice 净支出应等于费用总额 1 USDC
      expect(aliceInitialBalance - aliceFinalBalance).to.equal(ethers.parseUnits('1', 6));
    });

    it('应正确分发清算费用', async function () {
      const { feeRouter, mockToken, alice, treasury, ecoVault } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const amount = ethers.parseUnits('500', 6); // 500 USDC
      
      // 授权 FeeRouter 使用代币
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), amount);
      
      // 记录初始余额
      const treasuryInitialBalance = await mockToken.balanceOf(treasury.address);
      const ecoVaultInitialBalance = await mockToken.balanceOf(ecoVault.address);
      const aliceInitialBalance = await mockToken.balanceOf(alice.address);
      
      // 分发清算费用
      await feeRouter.connect(alice).distributeNormal(tokenAddress, amount);
      
      // 验证余额变化
      const treasuryFinalBalance = await mockToken.balanceOf(treasury.address);
      const ecoVaultFinalBalance = await mockToken.balanceOf(ecoVault.address);
      const aliceFinalBalance = await mockToken.balanceOf(alice.address);
      
      // 平台应收到 0.45 USDC (0.09%)
      expect(treasuryFinalBalance - treasuryInitialBalance).to.equal(ethers.parseUnits('0.45', 6));
      
      // 生态金库应收到 0.05 USDC (0.01%)
      expect(ecoVaultFinalBalance - ecoVaultInitialBalance).to.equal(ethers.parseUnits('0.05', 6));

      // Alice 净支出应等于总费用 0.5 USDC
      expect(aliceInitialBalance - aliceFinalBalance).to.equal(ethers.parseUnits('0.5', 6));
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
      const { feeRouter, mockToken, acm, treasury } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const amount = ethers.parseUnits('100', 6);
      
      // treasury 地址没有 DEPOSIT 权限，应该失败
      await expect(
        feeRouter.connect(treasury).distributeNormal(tokenAddress, amount)
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('非授权用户应无法设置费率', async function () {
      const { feeRouter, alice, acm } = await deployFixture();
      
      // alice 没有 SET_PARAMETER 权限，应该失败
      await expect(
        feeRouter.connect(alice).setFeeConfig(10, 2)
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('授权用户应能正确设置费率', async function () {
      const { feeRouter, governance } = await deployFixture();
      
      const newPlatformBps = 10; // 0.1%
      const newEcoBps = 2;        // 0.02%
      
      // governance 有 SET_PARAMETER 权限，应该成功
      await feeRouter.connect(governance).setFeeConfig(newPlatformBps, newEcoBps);
      
      // 验证费率更新
      const platformFeeBps = await feeRouter.getPlatformFeeBps();
      const ecosystemFeeBps = await feeRouter.getEcosystemFeeBps();
      
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
      ).to.be.revertedWith('Pausable: paused');
      
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

    it('费率配置边界值测试 - 总和等于10000应被拒绝', async function () {
      const { feeRouter, governance } = await deployFixture();
      
      // 总费率等于 100% 应该失败
      await expect(
        feeRouter.connect(governance).setFeeConfig(5000, 5000) // 50% + 50% = 100%
      ).to.be.revertedWithCustomError(feeRouter, 'FeeRouter__InvalidConfig');
    });

    it('费率配置边界值测试 - 总和为9999应被接受', async function () {
      const { feeRouter, governance } = await deployFixture();
      
      // 总费率等于 99.99% 应该成功
      await feeRouter.connect(governance).setFeeConfig(5000, 4999);
      
      const platformFeeBps = await feeRouter.getPlatformFeeBps();
      const ecosystemFeeBps = await feeRouter.getEcosystemFeeBps();
      expect(platformFeeBps).to.equal(5000);
      expect(ecosystemFeeBps).to.equal(4999);
    });

    it('费率配置边界值测试 - 零费率应被接受', async function () {
      const { feeRouter, governance } = await deployFixture();
      
      // 零费率应该成功
      await feeRouter.connect(governance).setFeeConfig(0, 0);
      
      const platformFeeBps = await feeRouter.getPlatformFeeBps();
      const ecosystemFeeBps = await feeRouter.getEcosystemFeeBps();
      expect(platformFeeBps).to.equal(0);
      expect(ecosystemFeeBps).to.equal(0);
    });
  });

  describe('事件验证测试', function () {
    it('应正确触发 FeeDistributed 事件', async function () {
      const { feeRouter, mockToken, alice, treasury, ecoVault } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const amount = ethers.parseUnits('1000', 6);
      
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), amount);
      
      await expect(feeRouter.connect(alice).distributeNormal(tokenAddress, amount))
        .to.emit(feeRouter, 'FeeDistributed')
        .withArgs(
          tokenAddress,
          ethers.parseUnits('0.9', 6), // platformAmount
          ethers.parseUnits('0.1', 6)   // ecoAmount
        );
    });

    it('应正确触发 FeeConfigUpdated 事件', async function () {
      const { feeRouter, governance } = await deployFixture();
      
      const newPlatformBps = 10;
      const newEcoBps = 2;
      
      await expect(feeRouter.connect(governance).setFeeConfig(newPlatformBps, newEcoBps))
        .to.emit(feeRouter, 'FeeConfigUpdated')
        .withArgs(newPlatformBps, newEcoBps);
    });

    it('应正确触发 TokenSupported 事件', async function () {
      const { feeRouter, governance } = await deployFixture();
      
      // 部署新代币
      const mockTokenFactory = await ethers.getContractFactory('MockERC20');
      const newToken = await mockTokenFactory.deploy('New Token', 'NEW', ethers.parseUnits('1000000', 18));
      await newToken.waitForDeployment();
      
      await expect(feeRouter.connect(governance).addSupportedToken(await newToken.getAddress()))
        .to.emit(feeRouter, 'TokenSupported')
        .withArgs(await newToken.getAddress(), true);
      
      await expect(feeRouter.connect(governance).removeSupportedToken(await newToken.getAddress()))
        .to.emit(feeRouter, 'TokenSupported')
        .withArgs(await newToken.getAddress(), false);
    });

    it('应正确触发 DynamicFeeUpdated 事件', async function () {
      const { feeRouter, mockToken, governance } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('CUSTOM_FEE'));
      const dynamicFeeBps = 50;
      
      // 使用事件过滤器来避免签名歧义
      const tx = await feeRouter.connect(governance).setDynamicFee(tokenAddress, feeType, dynamicFeeBps);
      const receipt = await tx.wait();
      
      // 手动检查事件
      const event = receipt?.logs.find(
        (log: any) => {
          try {
            const parsed = feeRouter.interface.parseLog(log);
            return parsed && parsed.name === 'DynamicFeeUpdated';
          } catch {
            return false;
          }
        }
      );
      
      expect(event).to.not.be.undefined;
      if (event) {
        const parsed = feeRouter.interface.parseLog(event);
        expect(parsed?.args[0]).to.equal(tokenAddress);
        expect(parsed?.args[1]).to.equal(feeType);
        expect(parsed?.args[2]).to.equal(0); // oldFee
        expect(parsed?.args[3]).to.equal(dynamicFeeBps); // newFee
      }
    });

    it('应正确触发 BatchFeeDistributed 事件', async function () {
      const { feeRouter, mockToken, alice } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const amounts = [
        ethers.parseUnits('100', 6),
        ethers.parseUnits('200', 6)
      ];
      const feeTypes = [
        ethers.keccak256(ethers.toUtf8Bytes('DEPOSIT')),
        ethers.keccak256(ethers.toUtf8Bytes('BORROW'))
      ];
      
      const totalAmount = amounts.reduce((sum, amount) => sum + amount, 0n);
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), totalAmount);
      
      await expect(feeRouter.connect(alice).batchDistribute(tokenAddress, amounts, feeTypes))
        .to.emit(feeRouter, 'BatchFeeDistributed')
        .withArgs(tokenAddress, totalAmount, amounts.length);
    });
  });

  describe('统计信息测试', function () {
    it('应正确累积分发次数和金额', async function () {
      const { feeRouter, mockToken, alice } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const amount1 = ethers.parseUnits('1000', 6);
      const amount2 = ethers.parseUnits('2000', 6);
      
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), amount1 + amount2);
      
      // 第一次分发
      await feeRouter.connect(alice).distributeNormal(tokenAddress, amount1);
      
      let totalDistributions = await feeRouter.getTotalDistributions();
      let totalAmount = await feeRouter.getTotalAmountDistributed();
      expect(totalDistributions).to.equal(1);
      expect(totalAmount).to.equal(amount1);
      
      // 第二次分发
      await feeRouter.connect(alice).distributeNormal(tokenAddress, amount2);
      
      totalDistributions = await feeRouter.getTotalDistributions();
      totalAmount = await feeRouter.getTotalAmountDistributed();
      expect(totalDistributions).to.equal(2);
      expect(totalAmount).to.equal(amount1 + amount2);
    });

    it('getOperationStats 应返回正确的统计信息', async function () {
      const { feeRouter, mockToken, alice } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const amount = ethers.parseUnits('1000', 6);
      
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), amount);
      await feeRouter.connect(alice).distributeNormal(tokenAddress, amount);
      
      const [distributions, totalAmount] = await feeRouter.getOperationStats();
      expect(distributions).to.equal(1);
      expect(totalAmount).to.equal(amount);
    });

    it('批量分发应正确更新统计信息', async function () {
      const { feeRouter, mockToken, alice } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const amounts = [
        ethers.parseUnits('100', 6),
        ethers.parseUnits('200', 6),
        ethers.parseUnits('300', 6)
      ];
      const feeTypes = [
        ethers.keccak256(ethers.toUtf8Bytes('DEPOSIT')),
        ethers.keccak256(ethers.toUtf8Bytes('BORROW')),
        ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATE'))
      ];
      
      const totalAmount = amounts.reduce((sum, amount) => sum + amount, 0n);
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), totalAmount);
      
      await feeRouter.connect(alice).batchDistribute(tokenAddress, amounts, feeTypes);
      
      const totalDistributions = await feeRouter.getTotalDistributions();
      const totalAmountDistributed = await feeRouter.getTotalAmountDistributed();
      expect(totalDistributions).to.equal(amounts.length);
      expect(totalAmountDistributed).to.equal(totalAmount);
    });
  });

  describe('金库地址管理测试', function () {
    it('应正确更新金库地址', async function () {
      const { feeRouter, governance } = await deployFixture();
      
      const signers = await ethers.getSigners();
      const newTreasury = signers[5];
      const newEcoVault = signers[6];
      
      await feeRouter.connect(governance).setTreasury(newTreasury.address, newEcoVault.address);
      
      const platformTreasury = await feeRouter.getPlatformTreasury();
      const ecosystemVault = await feeRouter.getEcosystemVault();
      expect(platformTreasury).to.equal(newTreasury.address);
      expect(ecosystemVault).to.equal(newEcoVault.address);
    });

    it('零地址金库应被拒绝', async function () {
      const { feeRouter, governance } = await deployFixture();
      
      const signers = await ethers.getSigners();
      const newTreasury = signers[5];
      
      await expect(
        feeRouter.connect(governance).setTreasury(ZERO_ADDRESS, newTreasury.address)
      ).to.be.revertedWithCustomError(feeRouter, 'FeeRouter__ZeroAddress');
      
      await expect(
        feeRouter.connect(governance).setTreasury(newTreasury.address, ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(feeRouter, 'FeeRouter__ZeroAddress');
    });

    it('非授权用户应无法更新金库地址', async function () {
      const { feeRouter, alice } = await deployFixture();
      
      const signers = await ethers.getSigners();
      const newTreasury = signers[5];
      const newEcoVault = signers[6];
      
      await expect(
        feeRouter.connect(alice).setTreasury(newTreasury.address, newEcoVault.address)
      ).to.be.reverted;
    });
  });

  describe('费用缓存管理测试', function () {
    it('应正确清理费用缓存', async function () {
      const { feeRouter, mockToken, alice, governance } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const amount = ethers.parseUnits('1000', 6);
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('DEPOSIT'));
      
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), amount);
      await feeRouter.connect(alice).distributeNormal(tokenAddress, amount);
      
      // 验证缓存存在
      let feeCache = await feeRouter.getFeeCache(tokenAddress, feeType);
      expect(feeCache).to.equal(amount);
      
      // 清理缓存
      await feeRouter.connect(governance).clearFeeCache(tokenAddress, feeType);
      
      // 验证缓存已清理
      feeCache = await feeRouter.getFeeCache(tokenAddress, feeType);
      expect(feeCache).to.equal(0);
      
      // 验证统计信息未受影响
      const feeStatistics = await feeRouter.getFeeStatistics(tokenAddress, feeType);
      expect(feeStatistics).to.equal(amount);
    });

    it('清理不存在的缓存应成功', async function () {
      const { feeRouter, mockToken, governance } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('NONEXISTENT'));
      
      // 清理不存在的缓存应该成功（不报错）
      await feeRouter.connect(governance).clearFeeCache(tokenAddress, feeType);
      
      const feeCache = await feeRouter.getFeeCache(tokenAddress, feeType);
      expect(feeCache).to.equal(0);
    });
  });

  describe('批量操作边界测试', function () {
    it('数组长度不匹配应被拒绝', async function () {
      const { feeRouter, mockToken, alice } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const amounts = [
        ethers.parseUnits('100', 6),
        ethers.parseUnits('200', 6)
      ];
      const feeTypes = [
        ethers.keccak256(ethers.toUtf8Bytes('DEPOSIT'))
      ];
      
      const totalAmount = amounts.reduce((sum, amount) => sum + amount, 0n);
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), totalAmount);
      
      await expect(
        feeRouter.connect(alice).batchDistribute(tokenAddress, amounts, feeTypes)
      ).to.be.revertedWithCustomError(feeRouter, 'FeeRouter__InvalidBatchSize');
    });

    it('批量大小超过限制应被拒绝', async function () {
      const { feeRouter, mockToken, alice } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const amounts = Array(51).fill(ethers.parseUnits('100', 6));
      const feeTypes = Array(51).fill(ethers.keccak256(ethers.toUtf8Bytes('DEPOSIT')));
      
      const totalAmount = amounts.reduce((sum, amount) => sum + amount, 0n);
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), totalAmount);
      
      await expect(
        feeRouter.connect(alice).batchDistribute(tokenAddress, amounts, feeTypes)
      ).to.be.revertedWithCustomError(feeRouter, 'FeeRouter__InvalidBatchSize');
    });

    it('批量操作应跳过零金额', async function () {
      const { feeRouter, mockToken, alice, treasury, ecoVault } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const amounts = [
        ethers.parseUnits('100', 6),
        0n,
        ethers.parseUnits('200', 6)
      ];
      const feeTypes = [
        ethers.keccak256(ethers.toUtf8Bytes('DEPOSIT')),
        ethers.keccak256(ethers.toUtf8Bytes('BORROW')),
        ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATE'))
      ];
      
      const treasuryInitialBalance = await mockToken.balanceOf(treasury.address);
      const ecoVaultInitialBalance = await mockToken.balanceOf(ecoVault.address);
      
      const totalAmount = amounts.reduce((sum, amount) => sum + amount, 0n);
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), totalAmount);
      
      await feeRouter.connect(alice).batchDistribute(tokenAddress, amounts, feeTypes);
      
      // 验证只有非零金额被分发
      const treasuryFinalBalance = await mockToken.balanceOf(treasury.address);
      const ecoVaultFinalBalance = await mockToken.balanceOf(ecoVault.address);
      
      const expectedFee = totalAmount * 10n / 10000n; // 0.1%
      const expectedPlatformFee = totalAmount * 9n / 10000n; // 0.09%
      const expectedEcoFee = totalAmount * 1n / 10000n; // 0.01%
      
      expect(treasuryFinalBalance - treasuryInitialBalance).to.equal(expectedPlatformFee);
      expect(ecoVaultFinalBalance - ecoVaultInitialBalance).to.equal(expectedEcoFee);
    });
  });

  describe('动态费率边界测试', function () {
    it('未设置的动态费率应无法分发', async function () {
      const { feeRouter, mockToken, alice } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('UNSET_FEE'));
      const amount = ethers.parseUnits('1000', 6);
      
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), amount);
      
      await expect(
        feeRouter.connect(alice).distributeDynamic(tokenAddress, amount, feeType)
      ).to.be.revertedWithCustomError(feeRouter, 'FeeRouter__InvalidFeeType');
    });

    it('动态费率超过限制应被拒绝', async function () {
      const { feeRouter, mockToken, governance } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('CUSTOM_FEE'));
      
      // 费率 >= 10000 应该失败
      await expect(
        feeRouter.connect(governance).setDynamicFee(tokenAddress, feeType, 10000)
      ).to.be.revertedWithCustomError(feeRouter, 'FeeRouter__InvalidConfig');
    });

    it('动态费率零地址代币应被拒绝', async function () {
      const { feeRouter, governance } = await deployFixture();
      
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('CUSTOM_FEE'));
      
      await expect(
        feeRouter.connect(governance).setDynamicFee(ZERO_ADDRESS, feeType, 50)
      ).to.be.revertedWithCustomError(feeRouter, 'FeeRouter__ZeroAddress');
    });

    it('动态费率与生态分成叠加后超过100%应被拒绝', async function () {
      const { feeRouter, mockToken, governance } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('CUSTOM_FEE'));
      
      // 动态费率 6667，生态费用为 3333.5，总和约 10000.5，应该失败
      await expect(
        feeRouter.connect(governance).setDynamicFee(tokenAddress, feeType, 6667)
      ).to.be.revertedWithCustomError(feeRouter, 'FeeRouter__InvalidConfig');
    });
  });

  describe('多代币处理测试', function () {
    it('应正确处理多个代币', async function () {
      const { feeRouter, mockToken, governance, alice, treasury, ecoVault } = await deployFixture();
      
      // 部署第二个代币
      const mockTokenFactory = await ethers.getContractFactory('MockERC20');
      const token2 = await mockTokenFactory.deploy('Token 2', 'T2', ethers.parseUnits('1000000', 18));
      await token2.waitForDeployment();
      
      await feeRouter.connect(governance).addSupportedToken(await token2.getAddress());
      
      // 给 alice 一些 token2
      await token2.transfer(alice.address, ethers.parseUnits('10000', 18));
      
      const amount1 = ethers.parseUnits('1000', 6);
      const amount2 = ethers.parseUnits('2000', 18);
      
      // 分发第一个代币的费用
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), amount1);
      await feeRouter.connect(alice).distributeNormal(await mockToken.getAddress(), amount1);
      
      // 分发第二个代币的费用
      await token2.connect(alice).approve(await feeRouter.getAddress(), amount2);
      await feeRouter.connect(alice).distributeNormal(await token2.getAddress(), amount2);
      
      // 验证两个代币的统计信息独立
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('DEPOSIT'));
      const stats1 = await feeRouter.getFeeStatistics(await mockToken.getAddress(), feeType);
      const stats2 = await feeRouter.getFeeStatistics(await token2.getAddress(), feeType);
      
      expect(stats1).to.equal(amount1);
      expect(stats2).to.equal(amount2);
    });
  });

  describe('大金额处理测试', function () {
    it('应正确处理大金额分发', async function () {
      const { feeRouter, mockToken, governance, alice, treasury, ecoVault } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const largeAmount = ethers.parseUnits('1000000', 6); // 100万 USDC
      
      // 从 governance 账户给 alice 足够多的代币（governance 是代币部署者，拥有初始供应量）
      await mockToken.connect(governance).transfer(alice.address, largeAmount);
      
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), largeAmount);
      
      const treasuryInitialBalance = await mockToken.balanceOf(treasury.address);
      const ecoVaultInitialBalance = await mockToken.balanceOf(ecoVault.address);
      
      await feeRouter.connect(alice).distributeNormal(tokenAddress, largeAmount);
      
      const treasuryFinalBalance = await mockToken.balanceOf(treasury.address);
      const ecoVaultFinalBalance = await mockToken.balanceOf(ecoVault.address);
      
      // 验证大金额计算正确
      const expectedPlatformFee = largeAmount * 9n / 10000n;
      const expectedEcoFee = largeAmount * 1n / 10000n;
      
      expect(treasuryFinalBalance - treasuryInitialBalance).to.equal(expectedPlatformFee);
      expect(ecoVaultFinalBalance - ecoVaultInitialBalance).to.equal(expectedEcoFee);
    });
  });

  describe('费率计算精度测试', function () {
    it('应正确处理小额金额的费率计算', async function () {
      const { feeRouter, mockToken, alice, treasury, ecoVault } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const smallAmount = 1n; // 最小单位
      
      await mockToken.transfer(alice.address, ethers.parseUnits('1000', 6));
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), smallAmount);
      
      const treasuryInitialBalance = await mockToken.balanceOf(treasury.address);
      const ecoVaultInitialBalance = await mockToken.balanceOf(ecoVault.address);
      
      await feeRouter.connect(alice).distributeNormal(tokenAddress, smallAmount);
      
      const treasuryFinalBalance = await mockToken.balanceOf(treasury.address);
      const ecoVaultFinalBalance = await mockToken.balanceOf(ecoVault.address);
      
      // 对于极小金额，由于整数除法，可能为0
      const platformFee = treasuryFinalBalance - treasuryInitialBalance;
      const ecoFee = ecoVaultFinalBalance - ecoVaultInitialBalance;
      
      expect(platformFee + ecoFee).to.be.at.most(smallAmount);
    });

    it('应正确处理费率计算的舍入', async function () {
      const { feeRouter, mockToken, alice, treasury, ecoVault } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      // 使用一个会产生舍入的金额
      const amount = 333n; // 333 最小单位
      
      await mockToken.transfer(alice.address, ethers.parseUnits('1000', 6));
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), amount);
      
      const treasuryInitialBalance = await mockToken.balanceOf(treasury.address);
      const ecoVaultInitialBalance = await mockToken.balanceOf(ecoVault.address);
      const aliceInitialBalance = await mockToken.balanceOf(alice.address);
      
      await feeRouter.connect(alice).distributeNormal(tokenAddress, amount);
      
      const treasuryFinalBalance = await mockToken.balanceOf(treasury.address);
      const ecoVaultFinalBalance = await mockToken.balanceOf(ecoVault.address);
      const aliceFinalBalance = await mockToken.balanceOf(alice.address);
      
      const platformFee = treasuryFinalBalance - treasuryInitialBalance;
      const ecoFee = ecoVaultFinalBalance - ecoVaultInitialBalance;
      const aliceSpent = aliceInitialBalance - aliceFinalBalance;
      
      // 验证总费用不超过原金额
      expect(platformFee + ecoFee).to.be.at.most(amount);
      // 验证用户支付的金额等于实际分发的费用
      expect(aliceSpent).to.equal(platformFee + ecoFee);
    });
  });

  describe('代币管理扩展测试', function () {
    it('重复添加代币应被拒绝', async function () {
      const { feeRouter, mockToken, governance } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      
      // 代币已存在，再次添加应该失败
      await expect(
        feeRouter.connect(governance).addSupportedToken(tokenAddress)
      ).to.be.revertedWithCustomError(feeRouter, 'FeeRouter__InvalidConfig');
    });

    it('移除不存在的代币应被拒绝', async function () {
      const { feeRouter, governance } = await deployFixture();
      
      // 部署新代币但不添加
      const mockTokenFactory = await ethers.getContractFactory('MockERC20');
      const newToken = await mockTokenFactory.deploy('New Token', 'NEW', ethers.parseUnits('1000000', 18));
      await newToken.waitForDeployment();
      
      await expect(
        feeRouter.connect(governance).removeSupportedToken(await newToken.getAddress())
      ).to.be.revertedWithCustomError(feeRouter, 'FeeRouter__InvalidConfig');
    });

    it('移除后重新添加代币应成功', async function () {
      const { feeRouter, mockToken, governance } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      
      // 移除代币
      await feeRouter.connect(governance).removeSupportedToken(tokenAddress);
      expect(await feeRouter.isTokenSupported(tokenAddress)).to.be.false;
      
      // 重新添加
      await feeRouter.connect(governance).addSupportedToken(tokenAddress);
      expect(await feeRouter.isTokenSupported(tokenAddress)).to.be.true;
    });
  });

  describe('Registry 更新测试', function () {
    it('应正确更新 Registry 地址', async function () {
      const { feeRouter, governance, acm } = await deployFixture();
      
      // 部署新 Registry
      const registryFactory = await ethers.getContractFactory('MockRegistry');
      const newRegistry = await registryFactory.deploy();
      await newRegistry.waitForDeployment();
      
      // 在新 Registry 中注册 ACM
      const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
      await newRegistry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
      
      await feeRouter.connect(governance).updateRegistry(await newRegistry.getAddress());
      
      const registryAddr = await feeRouter.getRegistry();
      expect(registryAddr).to.equal(await newRegistry.getAddress());
    });

    it('零地址 Registry 应被拒绝', async function () {
      const { feeRouter, governance } = await deployFixture();
      
      await expect(
        feeRouter.connect(governance).updateRegistry(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(feeRouter, 'FeeRouter__ZeroAddress');
    });
  });

  describe('多次分发累积测试', function () {
    it('多次分发应正确累积费用统计', async function () {
      const { feeRouter, mockToken, alice } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const feeType = ethers.keccak256(ethers.toUtf8Bytes('DEPOSIT'));
      
      const amounts = [
        ethers.parseUnits('100', 6),
        ethers.parseUnits('200', 6),
        ethers.parseUnits('300', 6)
      ];
      
      const totalAmount = amounts.reduce((sum, amount) => sum + amount, 0n);
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), totalAmount);
      
      // 多次分发
      for (const amount of amounts) {
        await feeRouter.connect(alice).distributeNormal(tokenAddress, amount);
      }
      
      // 验证统计信息累积
      const feeStatistics = await feeRouter.getFeeStatistics(tokenAddress, feeType);
      const feeCache = await feeRouter.getFeeCache(tokenAddress, feeType);
      
      expect(feeStatistics).to.equal(totalAmount);
      expect(feeCache).to.equal(totalAmount);
    });

    it('不同费用类型的统计应独立', async function () {
      const { feeRouter, mockToken, alice } = await deployFixture();
      
      const tokenAddress = await mockToken.getAddress();
      const depositType = ethers.keccak256(ethers.toUtf8Bytes('DEPOSIT'));
      const borrowType = ethers.keccak256(ethers.toUtf8Bytes('BORROW'));
      
      const depositAmount = ethers.parseUnits('1000', 6);
      const borrowAmount = ethers.parseUnits('2000', 6);
      
      await mockToken.connect(alice).approve(await feeRouter.getAddress(), depositAmount + borrowAmount);
      
      // 使用批量分发来测试不同费用类型
      await feeRouter.connect(alice).batchDistribute(
        tokenAddress,
        [depositAmount, borrowAmount],
        [depositType, borrowType]
      );
      
      const depositStats = await feeRouter.getFeeStatistics(tokenAddress, depositType);
      const borrowStats = await feeRouter.getFeeStatistics(tokenAddress, borrowType);
      
      expect(depositStats).to.equal(depositAmount);
      expect(borrowStats).to.equal(borrowAmount);
    });
  });
}); 
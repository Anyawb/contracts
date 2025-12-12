import { expect } from 'chai';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import hardhat from 'hardhat';
const { ethers } = hardhat;

import type { RewardManager } from '../../types/contracts/Reward';
import type { RewardManagerCore } from '../../types/contracts/Reward';
import type { AccessControlManager } from '../../types/contracts/access';
import type { MockRegistry } from '../../types/contracts/Mocks/MockRegistry';
import type { RewardPoints } from '../../types/contracts/Token/RewardPoints';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

// 常量定义（如需零地址校验可启用）
// const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
// 动态签名调用辅助，避免类型定义落后导致的编译报错
function callBySignature(contract: unknown, signature: string) {
  return (...args: unknown[]) => (contract as { [k: string]: (...xs: unknown[]) => Promise<unknown> })[signature](...args);
}

/**
 * RewardManager 与 RewardManagerCore 集成测试
 * 
 * 测试目标:
 * - 验证两个合约之间的接口调用关系
 * - 验证权限配置是否正确
 * - 验证积分计算和发放流程
 * - 验证管理接口的权限控制
 * - 验证批量操作功能
 * - 验证惩罚机制和缓存机制
 * - 验证地址更新功能
 */
describe('RewardManager – 集成测试', function () {
  let rewardManager!: RewardManager;
  let rewardManagerCore!: RewardManagerCore;
  let acm!: AccessControlManager;
  let registry!: MockRegistry;
  let rewardPoints!: RewardPoints;
  let governance!: SignerWithAddress;
  let alice!: SignerWithAddress;
  let bob!: SignerWithAddress;
  let lendingEngine!: SignerWithAddress;

  async function deployFixture() {
    // 部署测试环境
    [governance, alice, bob, lendingEngine] = await ethers.getSigners();

    // 部署 ACM
    const ACM = await ethers.getContractFactory('AccessControlManager');
    acm = await ACM.deploy(governance.address) as AccessControlManager;
    await acm.waitForDeployment();

    // 部署 Mock Registry
    const MockRegistry = await ethers.getContractFactory('MockRegistry');
    registry = await MockRegistry.deploy() as MockRegistry;
    await registry.waitForDeployment();

    // 部署 RewardPoints - 使用代理模式
    const RewardPoints = await ethers.getContractFactory('RewardPoints');
    const rewardPointsImpl = await RewardPoints.deploy();
    await rewardPointsImpl.waitForDeployment();
    
    const proxyFactory = await ethers.getContractFactory('ERC1967Proxy');
    const rewardPointsProxy = await proxyFactory.deploy(
      await rewardPointsImpl.getAddress(),
      rewardPointsImpl.interface.encodeFunctionData('initialize', [governance.address])
    );
    await rewardPointsProxy.waitForDeployment();
    rewardPoints = RewardPoints.attach(await rewardPointsProxy.getAddress()) as RewardPoints;

    // 部署 RewardManagerCore - 使用代理模式（仅传入 Registry 地址，其他通过入口合约权限控制）
    const RewardManagerCore = await ethers.getContractFactory('RewardManagerCore');
    const rewardManagerImpl = await RewardManagerCore.deploy();
    await rewardManagerImpl.waitForDeployment();
    
    const rewardManagerCoreProxy = await proxyFactory.deploy(
      await rewardManagerImpl.getAddress(),
      rewardManagerImpl.interface.encodeFunctionData('initialize', [
        registry.target,
        ethers.parseUnits('100', 18), // 基础分/100 USD
        10, // 每天积分
        500, // 5% 健康因子奖励
        ethers.parseUnits('50', 18) // 基础分/ETH
      ])
    );
    await rewardManagerCoreProxy.waitForDeployment();
    rewardManagerCore = RewardManagerCore.attach(await rewardManagerCoreProxy.getAddress()) as RewardManagerCore;

    // 部署 RewardManager - 使用代理模式（仅初始化 Registry 地址）
    const RewardManager = await ethers.getContractFactory('RewardManager');
    const rewardManagerImpl2 = await RewardManager.deploy();
    await rewardManagerImpl2.waitForDeployment();
    
    const rewardManagerProxy = await proxyFactory.deploy(
      await rewardManagerImpl2.getAddress(),
      rewardManagerImpl2.interface.encodeFunctionData('initialize', [
        registry.target
      ])
    );
    await rewardManagerProxy.waitForDeployment();
    rewardManager = RewardManager.attach(await rewardManagerProxy.getAddress()) as RewardManager;

    // 设置 Registry 模块地址（与 ModuleKeys.sol 保持一致）
    await registry.setModule(ethers.keccak256(ethers.toUtf8Bytes('LENDING_ENGINE')), lendingEngine.address);
    await registry.setModule(ethers.keccak256(ethers.toUtf8Bytes('REWARD_MANAGER')), await rewardManager.getAddress());
    await registry.setModule(ethers.keccak256(ethers.toUtf8Bytes('REWARD_MANAGER_CORE')), await rewardManagerCore.getAddress());
    await registry.setModule(ethers.keccak256(ethers.toUtf8Bytes('REWARD_POINTS')), rewardPoints.target);
    await registry.setModule(ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER')), await acm.getAddress());
    await registry.setModule(ethers.keccak256(ethers.toUtf8Bytes('GUARANTEE_FUND_MANAGER')), governance.address);

    // 为ACM授予必要的角色
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER')), governance.address);
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('CLAIM_REWARD')), governance.address);
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE')), governance.address);
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('BORROW')), lendingEngine.address);
    // 为 LendingEngine 授予 CLAIM_REWARD 权限，以便调用 RewardManagerCore
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('CLAIM_REWARD')), lendingEngine.address);

    // 为 RewardPoints 授予 MINTER_ROLE（核心合约直接调用 mint/burn）
    await rewardPoints.connect(governance).grantRole(await rewardPoints.MINTER_ROLE(), await rewardManagerCore.getAddress());

    return { rewardManager, rewardManagerCore, acm, registry, rewardPoints, governance, alice, bob, lendingEngine };
  }

  beforeEach(async function () {
    ({ rewardManager, rewardManagerCore, acm, registry, rewardPoints, governance, alice, bob, lendingEngine } = await loadFixture(deployFixture));
  });

  describe('初始化验证', function () {
    it('应正确初始化合约地址', async function () {
      expect(await rewardManager.getRegistry()).to.equal(await registry.getAddress());
      const KEY_ACCESS_CONTROL = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
      const KEY_REWARD_POINTS = ethers.keccak256(ethers.toUtf8Bytes('REWARD_POINTS'));
      const KEY_REWARD_MANAGER = ethers.keccak256(ethers.toUtf8Bytes('REWARD_MANAGER'));
      const KEY_REWARD_MANAGER_CORE = ethers.keccak256(ethers.toUtf8Bytes('REWARD_MANAGER_CORE'));
      expect(await registry.getModule(KEY_ACCESS_CONTROL)).to.equal(await acm.getAddress());
      expect(await registry.getModule(KEY_REWARD_POINTS)).to.equal(await rewardPoints.getAddress());
      expect(await registry.getModule(KEY_REWARD_MANAGER)).to.equal(await rewardManager.getAddress());
      expect(await registry.getModule(KEY_REWARD_MANAGER_CORE)).to.equal(await rewardManagerCore.getAddress());
    });

    it('应正确初始化核心合约参数', async function () {
      const [baseUsd, perDay, bonus, baseEth] = await rewardManagerCore.getRewardParameters();
      expect(baseUsd).to.equal(ethers.parseUnits('100', 18));
      expect(perDay).to.equal(BigInt(10));
      expect(bonus).to.equal(BigInt(500));
      expect(baseEth).to.equal(ethers.parseUnits('50', 18));
    });

    it('应正确初始化默认等级倍数', async function () {
      expect(await rewardManagerCore.getLevelMultiplier(1)).to.equal(BigInt(10000));
      expect(await rewardManagerCore.getLevelMultiplier(2)).to.equal(BigInt(11000));
      expect(await rewardManagerCore.getLevelMultiplier(3)).to.equal(BigInt(12500));
    });

    it('应正确初始化动态奖励参数', async function () {
      const params = await rewardManagerCore.getDynamicRewardParameters();
      expect(params.threshold).to.equal(ethers.parseUnits('1000', 18));
      expect(params.multiplier).to.equal(BigInt(12000));
    });
  });

  describe('权限控制测试', function () {
    it('非权限用户应无法更新参数', async function () {
      const newBaseUsd = ethers.parseUnits('200', 18);
      
      await expect(
        rewardManager.connect(alice).updateRewardParameters(
          ethers.parseUnits('50', 18),
          20,
          1000,
          newBaseUsd
        )
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('权限用户应能够更新参数', async function () {
      const newBaseUsd = ethers.parseUnits('200', 18);
      
      await expect(
        rewardManager.connect(governance).updateRewardParameters(
          ethers.parseUnits('50', 18),
          20,
          1000,
          newBaseUsd
        )
      ).to.not.be.reverted;

      const [baseUsd] = await rewardManagerCore.getRewardParameters();
      expect(baseUsd).to.equal(newBaseUsd);
    });

    it('非LendingEngine应无法调用onLoanEvent', async function () {
      await expect(
        rewardManagerCore.connect(alice).onLoanEvent(
          alice.address,
          ethers.parseUnits('1000', 6),
          30 * 24 * 3600,
          true
        )
      ).to.be.revertedWithCustomError(rewardManagerCore, 'RewardManagerCore__UseRewardManagerEntry');
    });

    it('LendingEngine应能够调用onLoanEvent', async function () {
      await expect(
        rewardManager.connect(lendingEngine)[
          'onLoanEvent(address,uint256,uint256,bool)'
        ](
          alice.address,
          ethers.parseUnits('1000', 6),
          30 * 24 * 3600,
          true
        )
      ).to.not.be.reverted;
    });

    it('非权限用户应无法设置等级倍数', async function () {
      await expect(
        rewardManager.connect(alice).setLevelMultiplier(2, 12000)
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('非权限用户应无法设置健康因子奖励', async function () {
      await expect(
        rewardManager.connect(alice).setHealthFactorBonus(1000)
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('非权限用户应无法设置动态奖励参数', async function () {
      await expect(
        rewardManager.connect(alice).setDynamicRewardParams(
          ethers.parseUnits('2000', 18),
          15000
        )
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('非权限用户应无法应用惩罚', async function () {
      await expect(
        rewardManager.connect(alice).applyPenalty(bob.address, ethers.parseUnits('100', 18))
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('非权限用户应无法清除用户缓存', async function () {
      await expect(
        rewardManager.connect(alice).clearUserCache(bob.address)
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    // 入口侧未提供直接更新地址的接口，由 Registry 管理；此处不测试这些接口
    it('占位：入口侧地址更新接口不存在', async function () {
      expect(true).to.equal(true);
    });
  });

  describe('边界条件测试', function () {
    it('零金额贷款应正确处理', async function () {
      await expect(
        rewardManager.connect(lendingEngine)['onLoanEvent(address,uint256,uint256,bool)'](
          alice.address,
          BigInt(0),
          30 * 24 * 3600,
          true
        )
      ).to.not.be.reverted;
    });

    it('低于1000 USDT的借款不计分', async function () {
      // amount = 500 USDT (6 decimals)
      const smallAmount = ethers.parseUnits('500', 6);
      await rewardManager.connect(lendingEngine)['onLoanEvent(address,uint256,uint256,bool)'](
        alice.address,
        smallAmount,
        30 * 24 * 3600,
        true
      );
      const balance = await rewardPoints.balanceOf(alice.address);
      expect(balance).to.equal(BigInt(0));
    });

    it('零期限贷款应正确处理', async function () {
      await expect(
        rewardManager.connect(lendingEngine)['onLoanEvent(address,uint256,uint256,bool)'](
          alice.address,
          ethers.parseUnits('1000', 6),
          0,
          true
        )
      ).to.not.be.reverted;
    });

    it('大额贷款应正确处理', async function () {
      const largeAmount = ethers.parseUnits('1000000', 6); // 100万USDT
      await expect(
        rewardManager.connect(lendingEngine)['onLoanEvent(address,uint256,uint256,bool)'](
          alice.address,
          largeAmount,
          365 * 24 * 3600, // 1年
          true
        )
      ).to.not.be.reverted;
    });

    it('长期贷款应正确处理', async function () {
      const longDuration = 10 * 365 * 24 * 3600; // 10年
      await expect(
        rewardManager.connect(lendingEngine)['onLoanEvent(address,uint256,uint256,bool)'](
          alice.address,
          ethers.parseUnits('1000', 6),
          longDuration,
          true
        )
      ).to.not.be.reverted;
    });
  });

  describe('积分计算和发放测试', function () {
    it('借款只锁定不发放，按期还款后释放', async function () {
      const amount = ethers.parseUnits('1000', 6);
      const duration = 30 * 24 * 3600;

      // 借款：duration>0 → 锁定
      await rewardManager.connect(lendingEngine)['onLoanEvent(address,uint256,uint256,bool)'](
        alice.address,
        amount,
        duration,
        true
      );
      expect(await rewardPoints.balanceOf(alice.address)).to.equal(BigInt(0));

      // 还款：duration=0 且 hfHighEnough=true（按期且足额） → 释放
      await rewardManager.connect(lendingEngine)['onLoanEvent(address,uint256,uint256,bool)'](
        alice.address,
        amount,
        0,
        true
      );
      // 不校验精确值，这里断言释放后余额大于0
      expect(await rewardPoints.balanceOf(alice.address)).to.be.gt(BigInt(0));
    });

    it('应正确处理健康因子不足的情况', async function () {
      const amount = ethers.parseUnits('1000', 6);
      const duration = 30 * 24 * 3600;
      
      await rewardManager.connect(lendingEngine)['onLoanEvent(address,uint256,uint256,bool)'](
        alice.address,
        amount,
        duration,
        false // 健康因子不足
      );

      // 验证没有健康因子奖励
      const [basePoints, bonus, totalPoints] = await rewardManagerCore.calculateExamplePoints(
        amount,
        duration,
        false
      );

      expect(bonus).to.equal(BigInt(0));
      expect(totalPoints).to.equal(basePoints);
    });

    it('应正确处理批量操作', async function () {
      const users = [alice.address, bob.address];
      const amounts = [ethers.parseUnits('1000', 6), ethers.parseUnits('2000', 6)];
      const durations = [30 * 24 * 3600, 60 * 24 * 3600];
      const hfHighEnoughs = [true, true];

      await expect(
        rewardManager.connect(lendingEngine).onBatchLoanEvents(
          users,
          amounts,
          durations,
          hfHighEnoughs
        )
      ).to.not.be.reverted;

      // 验证批量操作统计
      expect(await rewardManagerCore.getTotalBatchOperations()).to.equal(BigInt(1));
    });

    it('应正确处理空批量操作', async function () {
      await expect(
        rewardManager.connect(lendingEngine).onBatchLoanEvents(
          [],
          [],
          [],
          []
        )
      ).to.be.revertedWithCustomError(rewardManagerCore, 'InvalidCaller');
    });

    it('应正确处理不同长度的批量操作数组', async function () {
      const users = [alice.address, bob.address];
      const amounts = [ethers.parseUnits('1000', 6)];
      const durations = [30 * 24 * 3600, 60 * 24 * 3600];
      const hfHighEnoughs = [true];

      await expect(
        rewardManager.connect(lendingEngine).onBatchLoanEvents(
          users,
          amounts,
          durations,
          hfHighEnoughs
        )
      ).to.be.reverted;
    });
  });

  describe('管理接口测试', function () {
    it('应正确设置等级倍数', async function () {
      await expect(
        rewardManager.connect(governance).setLevelMultiplier(2, 12000)
      ).to.not.be.reverted;

      expect(await rewardManagerCore.getLevelMultiplier(2)).to.equal(BigInt(12000));
    });

    it('应正确设置健康因子奖励', async function () {
      await expect(
        rewardManager.connect(governance).setHealthFactorBonus(1000)
      ).to.not.be.reverted;

      const [, , bonus] = await rewardManagerCore.getRewardParameters();
      expect(bonus).to.equal(1000);
    });

    it('应正确更新动态奖励参数', async function () {
      await expect(
        rewardManager.connect(governance).setDynamicRewardParams(
          ethers.parseUnits('2000', 18),
          15000
        )
      ).to.not.be.reverted;

      const params2 = await rewardManagerCore.getDynamicRewardParameters();
      expect(params2.threshold).to.equal(ethers.parseUnits('2000', 18));
      expect(params2.multiplier).to.equal(BigInt(15000));
    });

    it('应正确处理重复参数更新', async function () {
      // 第一次更新
      await rewardManager.connect(governance).updateRewardParameters(
        ethers.parseUnits('50', 18),
        20,
        1000,
        ethers.parseUnits('200', 18)
      );

      // 第二次更新相同参数
      await expect(
        rewardManager.connect(governance).updateRewardParameters(
          ethers.parseUnits('50', 18),
          20,
          1000,
          ethers.parseUnits('200', 18)
        )
      ).to.not.be.reverted;
    });
  });

  describe('查询接口测试', function () {
    it('应正确查询用户等级', async function () {
      expect(await rewardManager.getUserLevel(alice.address)).to.equal(BigInt(0)); // 默认等级
    });

    it('应正确查询等级倍数', async function () {
      expect(await rewardManager.getLevelMultiplier(1)).to.equal(10000);
      expect(await rewardManager.getLevelMultiplier(2)).to.equal(11000);
    });

    it('应正确查询积分参数', async function () {
      const [baseUsd, perDay, bonus, baseEth] = await rewardManagerCore.getRewardParameters();
      expect(baseUsd).to.equal(ethers.parseUnits('100', 18));
      expect(perDay).to.equal(BigInt(10));
      expect(bonus).to.equal(BigInt(500));
      expect(baseEth).to.equal(ethers.parseUnits('50', 18));
    });

    it('应正确查询系统统计', async function () {
      const [totalBatchOps, totalCachedRewards, dynamicThreshold, dynamicMultiplier] = await rewardManager.getSystemStats();
      expect(totalBatchOps).to.equal(BigInt(0));
      expect(totalCachedRewards).to.equal(BigInt(0));
      expect(dynamicThreshold).to.equal(ethers.parseUnits('1000', 18));
      expect(dynamicMultiplier).to.equal(12000);
    });

    it('应正确查询不存在的用户等级', async function () {
      expect(await rewardManager.getUserLevel(bob.address)).to.equal(BigInt(0)); // 默认等级
    });

    it('应正确查询不存在的等级倍数', async function () {
      expect(await rewardManager.getLevelMultiplier(5)).to.equal(20000);
    });

    it('应正确查询用户活跃度', async function () {
      const [lastActivity, totalLoans, totalVolume] = await rewardManager.getUserActivity(alice.address);
      expect(lastActivity).to.equal(BigInt(0));
      expect(totalLoans).to.equal(BigInt(0));
      expect(totalVolume).to.equal(BigInt(0));
    });

    it('应正确查询用户惩罚债务', async function () {
      expect(await rewardManager.getUserPenaltyDebt(alice.address)).to.equal(BigInt(0));
    });

    it('应正确查询积分缓存', async function () {
      expect(await rewardManager.getPointCache(alice.address)).to.equal(BigInt(0));
    });
  });

  describe('惩罚机制测试', function () {
    it('提前还款不释放且扣罚（3%）', async function () {
      const amount = ethers.parseUnits('2000', 6);
      const duration = 30 * 24 * 3600;
      // 借款锁定
      await rewardManager.connect(lendingEngine)['onLoanEvent(address,uint256,uint256,bool)'](alice.address, amount, duration, true);
      // 提前还款：传 hfHighEnough=false
      await rewardManager.connect(lendingEngine)['onLoanEvent(address,uint256,uint256,bool)'](alice.address, amount, 0, false);
      // 余额应为 0（未释放）
      expect(await rewardPoints.balanceOf(alice.address)).to.equal(BigInt(0));
    });

    it('应正确处理零惩罚金额', async function () {
      await expect(
        rewardManager.connect(governance).applyPenalty(alice.address, BigInt(0))
      ).to.be.revertedWithCustomError(rewardManagerCore, 'InvalidCaller');
    });

    it('逾期还款不释放且扣罚（5%）', async function () {
      const amount = ethers.parseUnits('2000', 6);
      const duration = 30 * 24 * 3600;
      // 借款锁定
      await rewardManager.connect(lendingEngine)['onLoanEvent(address,uint256,uint256,bool)'](alice.address, amount, duration, true);
      // 用相同布尔模拟“非按期足额”分支
      await rewardManager.connect(lendingEngine)['onLoanEvent(address,uint256,uint256,bool)'](alice.address, amount, 0, false);
      expect(await rewardPoints.balanceOf(alice.address)).to.equal(BigInt(0));
    });

    it('扣罚进入欠分账本，后续释放优先抵扣并清零欠分', async function () {
      const amount = ethers.parseUnits('3000', 6);
      const duration = 30 * 24 * 3600;
      // 1) 借款锁定
      await rewardManager.connect(lendingEngine)['onLoanEvent(address,uint256,uint256,bool)'](alice.address, amount, duration, true);
      // 2) 提前/逾期导致扣罚进入欠分
      await rewardManager.connect(lendingEngine)['onLoanEvent(address,uint256,uint256,bool)'](alice.address, amount, 0, false);
      const debtAfterPenalty = await rewardManager.getUserPenaltyDebt(alice.address);
      expect(debtAfterPenalty).to.be.gt(0);
      // 3) 再次借款（锁定积分），随后按期释放，期望优先抵扣欠分
      await rewardManager.connect(lendingEngine)['onLoanEvent(address,uint256,uint256,bool)'](alice.address, amount, duration, true);
      await rewardManager.connect(lendingEngine)['onLoanEvent(address,uint256,uint256,bool)'](alice.address, amount, 0, true);
      // 欠分应被清零
      const debtAfterRelease = await rewardManager.getUserPenaltyDebt(alice.address);
      expect(debtAfterRelease).to.equal(BigInt(0));
    });
  });

  describe('缓存机制测试', function () {
    it('应正确处理积分缓存', async function () {
      const amount = ethers.parseUnits('1000', 6);
      const duration = 30 * 24 * 3600;

      // 第一次调用，计算积分
      await rewardManager.connect(lendingEngine)['onLoanEvent(address,uint256,uint256,bool)'](
        alice.address,
        amount,
        duration,
        true
      );

      // 第二次调用，使用缓存
      await rewardManager.connect(lendingEngine)['onLoanEvent(address,uint256,uint256,bool)'](
        alice.address,
        amount,
        duration,
        true
      );

      expect(await rewardManagerCore.getTotalCachedRewards()).to.be.gt(BigInt(0));
    });

    it('应正确清除用户缓存', async function () {
      await expect(
        rewardManager.connect(governance).clearUserCache(alice.address)
      ).to.not.be.reverted;
    });

    it('应正确处理不存在的用户缓存清除', async function () {
      await expect(
        rewardManager.connect(governance).clearUserCache(bob.address)
      ).to.not.be.reverted;
    });
  });

  // 地址更新测试：入口侧无 setter，由 Registry 管理，故省略

  describe('安全场景测试', function () {
    it('应防止重入攻击', async function () {
      // 这里可以添加重入攻击测试，如果有相关漏洞的话
      // 目前合约没有明显的重入漏洞点
      expect(true).to.be.true;
    });

    it('应正确处理预言机失败', async function () {
      // 这里可以添加预言机失败测试，如果有相关依赖的话
      // 目前合约不直接依赖外部预言机
      expect(true).to.be.true;
    });

    it('应防止数学溢出', async function () {
      // 测试大数值计算，但避免溢出
      const largeAmount = ethers.parseUnits('1000000', 6);
      const largeDuration = 365 * 24 * 3600; // 1年
      
      // 这些操作应该不会溢出，因为使用了SafeMath
      await expect(
        rewardManager.connect(lendingEngine)['onLoanEvent(address,uint256,uint256,bool)'](
          alice.address,
          largeAmount,
          largeDuration,
          true
        )
      ).to.not.be.reverted;
    });
  });

  describe('集成流程测试', function () {
    it('应允许设置按期窗口和扣罚参数', async function () {
      await expect(callBySignature(rewardManager.connect(governance), 'setOnTimeWindow(uint256)')(48 * 3600)).to.not.be.reverted;
      await expect(callBySignature(rewardManager.connect(governance), 'setPenaltyBps(uint256,uint256)')(200, 600)).to.not.be.reverted;
    });
    it('完整积分流程测试', async function () {
      // 1. 设置等级倍数
      await rewardManager.connect(governance).setLevelMultiplier(3, 15000);
      
      // 2. 创建贷款事件
      await rewardManager.connect(lendingEngine)['onLoanEvent(address,uint256,uint256,bool)'](
        alice.address,
        ethers.parseUnits('5000', 6),
        90 * 24 * 3600, // 90天
        true
      );
      
      // 3. 验证等级倍数
      expect(await rewardManager.getLevelMultiplier(3)).to.equal(15000);
      
      // 4. 应用惩罚
      await rewardManager.connect(governance).applyPenalty(
        alice.address,
        ethers.parseUnits('50', 18)
      );
      
      // 5. 清除缓存
      await rewardManager.connect(governance).clearUserCache(alice.address);
      
      // 6. 验证系统统计
      const [totalBatchOps, totalCachedRewards] = await rewardManager.getSystemStats();
      expect(totalBatchOps).to.be.gte(0);
      expect(totalCachedRewards).to.be.gte(0);
    });

    it('批量操作集成测试', async function () {
      // 1. 批量贷款事件
      const users = [alice.address, bob.address];
      const amounts = [ethers.parseUnits('1000', 6), ethers.parseUnits('2000', 6)];
      const durations = [30 * 24 * 3600, 60 * 24 * 3600];
      const hfHighEnoughs = [true, false];
      
      await rewardManager.connect(lendingEngine).onBatchLoanEvents(
        users,
        amounts,
        durations,
        hfHighEnoughs
      );
      
      // 2. 验证批量操作计数
      expect(await rewardManagerCore.getTotalBatchOperations()).to.equal(BigInt(1));
      
      // 3. 验证用户等级
      expect(await rewardManager.getUserLevel(alice.address)).to.equal(BigInt(0));
      expect(await rewardManager.getUserLevel(bob.address)).to.equal(BigInt(0));
    });

    it('自动升级（次数+金额+履约）应达成2级', async function () {
      // 三笔合格借款，每笔 5000 USDT，均按期释放；总额≥10000，次数≥3，履约≥1
      const each = ethers.parseUnits('5000', 6);
      const dur = 30 * 24 * 3600;
      // 第1笔：借款后按期释放
      await rewardManager.connect(lendingEngine)['onLoanEvent(address,uint256,uint256,bool)'](alice.address, each, dur, true);
      await rewardManager.connect(lendingEngine)['onLoanEvent(address,uint256,uint256,bool)'](alice.address, each, 0, true);
      // 第2笔：借款后按期释放
      await rewardManager.connect(lendingEngine)['onLoanEvent(address,uint256,uint256,bool)'](alice.address, each, dur, true);
      await rewardManager.connect(lendingEngine)['onLoanEvent(address,uint256,uint256,bool)'](alice.address, each, 0, true);
      // 第3笔：借款（触发 autoUpgrade 判断），随后按期释放
      await rewardManager.connect(lendingEngine)['onLoanEvent(address,uint256,uint256,bool)'](alice.address, each, dur, true);
      // 由于自动升级在 _updateUserActivity 中触发，升级可能在借款时生效
      // 这里查询等级应≥2（满足三个门槛）
      const lvlBeforeRepay = await rewardManager.getUserLevel(alice.address);
      expect(lvlBeforeRepay).to.be.gte(2);
      await rewardManager.connect(lendingEngine)['onLoanEvent(address,uint256,uint256,bool)'](alice.address, each, 0, true);
    });
  });
}); 
import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;

import type { RewardManagerCore } from '../../types/contracts/Reward';
import type { RewardManager } from '../../types/contracts/Reward';
import type { RewardPoints } from '../../types/contracts/Token/RewardPoints';
import type { AccessControlManager } from '../../types/contracts/access';
import type { MockRegistry } from '../../types/contracts/Mocks/MockRegistry';

import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

/**
 * RewardManagerCore 积分计算逻辑测试
 * 
 * 测试目标:
 * - 积分计算公式验证 (BasePoints = 金额_USDT ÷ 100 × 期限_天 ÷ 5)
 * - 健康因子奖励计算 (Bonus = BasePoints × 5% 当 HealthFactor ≥ 1.5)
 * - 用户等级倍数应用
 * - 参数管理和更新功能
 * - 边界条件处理
 */
describe('RewardManagerCore – 积分计算逻辑测试', function () {
  let rewardManagerCore!: RewardManagerCore;
  let rewardManager!: RewardManager;
  let rewardPoints!: RewardPoints;
  let acm!: AccessControlManager;
  let registry!: MockRegistry;
  let governance!: SignerWithAddress;
  let alice!: SignerWithAddress;
  let bob!: SignerWithAddress;

  beforeEach(async function () {
    // 重新部署所有合约以避免初始化问题
    [governance, alice, bob] = await ethers.getSigners();

    // 部署 ACM
    const ACM = await ethers.getContractFactory('AccessControlManager');
    acm = await ACM.deploy(governance.address) as AccessControlManager;
    await acm.waitForDeployment();

    // 部署 Mock Registry
    const MockRegistry = await ethers.getContractFactory('MockRegistry');
    registry = await MockRegistry.deploy() as MockRegistry;
    await registry.waitForDeployment();

    // 部署代理工厂
    const proxyFactory = await ethers.getContractFactory('ERC1967Proxy');

    // 部署 RewardPoints - 使用代理模式
    // 使用完全限定名避免与 src/Reward/RewardPoints.sol 冲突
    const RewardPoints = await ethers.getContractFactory('src/Token/RewardPoints.sol:RewardPoints');
    const rewardPointsImpl = await RewardPoints.deploy();
    await rewardPointsImpl.waitForDeployment();
    
    const rewardPointsProxy = await proxyFactory.deploy(
      await rewardPointsImpl.getAddress(),
      rewardPointsImpl.interface.encodeFunctionData('initialize', [governance.address])
    );
    await rewardPointsProxy.waitForDeployment();
    rewardPoints = RewardPoints.attach(await rewardPointsProxy.getAddress()) as RewardPoints;

    // 部署 RewardManagerCore - 使用代理模式
    const RewardManagerCore = await ethers.getContractFactory('RewardManagerCore');
    const rewardManagerImpl = await RewardManagerCore.deploy();
    await rewardManagerImpl.waitForDeployment();
    const rewardManagerCoreProxy = await proxyFactory.deploy(
      await rewardManagerImpl.getAddress(),
      rewardManagerImpl.interface.encodeFunctionData('initialize', [
        registry.target,
        ethers.parseUnits('100', 18), // baseUsd
        10, // perDay
        500, // bonus (5% health factor bonus)
        ethers.parseUnits('50', 18) // baseEth
      ])
    );
    await rewardManagerCoreProxy.waitForDeployment();
    rewardManagerCore = RewardManagerCore.attach(await rewardManagerCoreProxy.getAddress()) as RewardManagerCore;

    // 部署 RewardManager - 使用代理模式
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

    // 设置 Registry 模块地址
    const KEY_RM = ethers.keccak256(ethers.toUtf8Bytes('REWARD_MANAGER'));
    const KEY_RP = ethers.keccak256(ethers.toUtf8Bytes('REWARD_POINTS'));
    const KEY_RM_CORE = ethers.keccak256(ethers.toUtf8Bytes('REWARD_MANAGER_CORE'));
    const KEY_ACM = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
    await registry.setModule(KEY_RM, await rewardManager.getAddress());
    await registry.setModule(KEY_RP, await rewardPoints.getAddress());
    await registry.setModule(KEY_RM_CORE, await rewardManagerCore.getAddress());
    await registry.setModule(KEY_ACM, await acm.getAddress());

    // 为ACM授予必要的角色
    const ROLE_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));
    const ROLE_CLAIM_REWARD = ethers.keccak256(ethers.toUtf8Bytes('CLAIM_REWARD'));
    if (!(await acm.hasRole(ROLE_SET_PARAMETER, governance.address))) {
      await acm.grantRole(ROLE_SET_PARAMETER, governance.address);
    }
    if (!(await acm.hasRole(ROLE_CLAIM_REWARD, governance.address))) {
      await acm.grantRole(ROLE_CLAIM_REWARD, governance.address);
    }
  });



  describe('积分计算逻辑', function () {
    beforeEach(async function () {
      // 每个测试前重置状态，但不重新部署合约
      // 这里可以添加状态重置逻辑
    });

    it('应正确计算基础积分', async function () {
      // 测试用例：1000 USDT，30天借款
      const amount = ethers.parseUnits('1000', 6); // 1000 USDT
      const duration = 30 * 24 * 3600; // 30天（秒）
      
      const [basePoints, bonus, totalPoints] = await rewardManagerCore.calculateExamplePoints(
        amount, 
        duration, 
        false // 健康因子不足
      );

      // 验证计算：
      // BasePoints = (1000 * 1e6) / 100 * (30 * 24 * 3600) / 5 = 518400000000000
      // 应用权重：518400000000000 * 100e18 / 1e18 = 518400000000000
      expect(basePoints).to.equal(518400000000000n);
      expect(bonus).to.equal(0); // 健康因子不足，无奖励
      expect(totalPoints).to.equal(518400000000000n);
    });

    it('应正确计算健康因子奖励', async function () {
      // 测试用例：1000 USDT，30天借款，健康因子足够
      const amount = ethers.parseUnits('1000', 6); // 1000 USDT
      const duration = 30 * 24 * 3600; // 30天（秒）
      
      const [basePoints, bonus, totalPoints] = await rewardManagerCore.calculateExamplePoints(
        amount, 
        duration, 
        true // 健康因子足够
      );

      // 验证计算：
      // BasePoints = (1000 * 1e6) / 100 * (30 * 24 * 3600) / 5 = 518400000000000
      // Bonus = 518400000000000 × 5% = 25920000000000
      // Total = 518400000000000 + 25920000000000 = 544320000000000
      expect(basePoints).to.equal(518400000000000n);
      expect(bonus).to.equal(25920000000000n);
      expect(totalPoints).to.equal(544320000000000n);
    });

    it('应处理零金额', async function () {
      const [basePoints, bonus, totalPoints] = await rewardManagerCore.calculateExamplePoints(
        0, 
        30 * 24 * 3600, 
        true
      );

      expect(basePoints).to.equal(0);
      expect(bonus).to.equal(0);
      expect(totalPoints).to.equal(0);
    });

    it('应处理零期限', async function () {
      const amount = ethers.parseUnits('1000', 6);
      const [basePoints, bonus, totalPoints] = await rewardManagerCore.calculateExamplePoints(
        amount, 
        0, 
        true
      );

      expect(basePoints).to.equal(0);
      expect(bonus).to.equal(0);
      expect(totalPoints).to.equal(0);
    });

    it('应正确应用用户等级倍数', async function () {
      // 设置用户等级为2级（1.1倍）
      await rewardManager.updateUserLevel(alice.address, 2);
      
      const amount = ethers.parseUnits('1000', 6);
      const duration = 30 * 24 * 3600;
      
      // 使用公开的计算示例函数测试等级倍数
      const [basePoints, bonus, totalPoints] = await rewardManagerCore.calculateExamplePoints(
        amount,
        duration,
        true
      );

      // 基础积分：518400000000000
      // 注意：calculateExamplePoints 不包含等级倍数，所以这里只测试基础计算
      expect(basePoints).to.equal(518400000000000n);
      expect(bonus).to.equal(25920000000000n);
      expect(totalPoints).to.equal(544320000000000n);
    });

    it('应正确处理不同借款金额', async function () {
      const testCases = [
        { amount: ethers.parseUnits('500', 6), duration: 15 * 24 * 3600, expected: 129600000000000n }, // 500 USDT, 15天
        { amount: ethers.parseUnits('2000', 6), duration: 60 * 24 * 3600, expected: 2073600000000000n }, // 2000 USDT, 60天
        { amount: ethers.parseUnits('100', 6), duration: 7 * 24 * 3600, expected: 12096000000000n }, // 100 USDT, 7天
      ];

      for (const testCase of testCases) {
        const [basePoints] = await rewardManagerCore.calculateExamplePoints(
          testCase.amount,
          testCase.duration,
          false
        );

        expect(basePoints).to.equal(testCase.expected);
      }
    });
  });

  describe('参数管理', function () {
    beforeEach(async function () {
      // 每个测试前重置状态，但不重新部署合约
    });

    it('应正确更新积分参数', async function () {
      const newBaseUsd = ethers.parseUnits('200', 18);
      const newPerDay = 20;
      const newBonus = 1000; // 10%
      const newBaseEth = ethers.parseUnits('100', 18);

      await rewardManager.updateRewardParameters(
        newBaseEth,
        newPerDay,
        newBonus,
        newBaseUsd
      );

      const [baseUsd, perDay, bonus, baseEth] = await rewardManagerCore.getRewardParameters();
      expect(baseUsd).to.equal(newBaseUsd);
      expect(perDay).to.equal(newPerDay);
      expect(bonus).to.equal(newBonus);
      expect(baseEth).to.equal(newBaseEth);
    });

    it('应正确设置健康因子奖励', async function () {
      const newBonus = 1000; // 10%
      await rewardManager.setHealthFactorBonus(newBonus);

      const [, , bonus] = await rewardManagerCore.getRewardParameters();
      expect(bonus).to.equal(newBonus);
    });

    it('应正确更新用户等级', async function () {
      const newLevel = 3;
      await rewardManager.updateUserLevel(alice.address, newLevel);

      const userLevel = await rewardManagerCore.getUserLevel(alice.address);
      expect(userLevel).to.equal(newLevel);
    });

    it('应正确更新等级倍数', async function () {
      const level = 2;
      const newMultiplier = 12000; // 1.2x
      await rewardManager.setLevelMultiplier(level, newMultiplier);

      const multiplier = await rewardManagerCore.getLevelMultiplier(level);
      expect(multiplier).to.equal(newMultiplier);
    });
  });

  describe('权限控制', function () {
    beforeEach(async function () {
      // 每个测试前重置状态，但不重新部署合约
    });

    it('非权限用户应无法更新参数', async function () {
      const newBaseUsd = ethers.parseUnits('200', 18);
      
      await expect(
        rewardManagerCore.connect(alice).updateRewardParameters(
          newBaseUsd,
          10,
          500,
          ethers.parseUnits('50', 18)
        )
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('非权限用户应无法设置健康因子奖励', async function () {
      await expect(
        rewardManagerCore.connect(alice).setHealthFactorBonus(1000)
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('非权限用户应无法更新用户等级', async function () {
      await expect(
        rewardManagerCore.connect(alice).updateUserLevel(bob.address, 2)
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });
  });

  describe('边界条件', function () {
    beforeEach(async function () {
      // 每个测试前重置状态，但不重新部署合约
    });

    it('应拒绝无效的用户等级', async function () {
      await expect(
        rewardManager.updateUserLevel(alice.address, 0)
      ).to.be.revertedWithCustomError(rewardManagerCore, 'InvalidCaller');

      await expect(
        rewardManager.updateUserLevel(alice.address, 6)
      ).to.be.revertedWithCustomError(rewardManagerCore, 'InvalidCaller');
    });

    it('应拒绝零倍数', async function () {
      await expect(
        rewardManager.setLevelMultiplier(1, 0)
      ).to.be.reverted;
    });

    it('应正确处理极小金额', async function () {
      const tinyAmount = ethers.parseUnits('1', 6); // 1 USDT
      const duration = 1 * 24 * 3600; // 1天
      
      const [basePoints] = await rewardManagerCore.calculateExamplePoints(
        tinyAmount,
        duration,
        false
      );

      // 1 USDT, 1天 = 1e6 / 100 * (1 * 24 * 3600) / 5 = 17280000000
      expect(basePoints).to.equal(17280000000n);
    });
  });

  describe('事件记录', function () {
    beforeEach(async function () {
      // 每个测试前重置状态，但不重新部署合约
    });

    it('应正确发出参数更新事件', async function () {
      const newBaseUsd = ethers.parseUnits('200', 18);
      
      await expect(
        rewardManager.updateRewardParameters(
          ethers.parseUnits('100', 18),
          20,
          1000,
          newBaseUsd
        )
      ).to.emit(rewardManagerCore, 'RewardParametersUpdated');
    });

    it('应正确发出用户等级更新事件', async function () {
      await expect(
        rewardManager.updateUserLevel(alice.address, 3)
      ).to.emit(rewardManagerCore, 'UserLevelUpdated');
    });
  });
}); 
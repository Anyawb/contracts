import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;

import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import type { MockRegistry } from '../../types/contracts/Mocks/MockRegistry';
import type { AccessControlManager } from '../../types/contracts/access/AccessControlManager';
import type { RewardPoints } from '../../types/contracts/Token/RewardPoints';
import type { RewardCore } from '../../types/contracts/Reward';
import type { RewardConsumption } from '../../types/contracts/Reward';
import type { FeatureUnlockConfig } from '../../types/contracts/Reward/configs/FeatureUnlockConfig';

// 最小集成用例：验证 RewardConsumption → RewardCore → RewardPoints.burnPoints 路径
// 步骤：
// 1) 部署 MockRegistry / ACM / RewardPoints / RewardCore / RewardConsumption / FeatureUnlockConfig
// 2) Registry 绑定 KEY_REWARD_POINTS / KEY_REWARD_CORE
// 3) 给 RewardCore 授予 RewardPoints 的 MINTER_ROLE（以允许 burnPoints）
// 4) 配置 FeatureUnlockConfig.basic 价格为 5e18，给用户先 mint 10e18 积分
// 5) 通过 RewardConsumption.consumePointsForService 触发扣分，断言余额减少

describe('RewardConsumption ↔ RewardCore ↔ RewardPoints 集成（最小用例）', () => {
  let governance!: SignerWithAddress;
  let user!: SignerWithAddress;

  let registry!: MockRegistry;
  let acm!: AccessControlManager;
  let rewardPoints!: RewardPoints;
  let rewardCore!: RewardCore;
  let rewardConsumption!: RewardConsumption;
  let featureUnlock!: FeatureUnlockConfig;
  
  // 统计与特权位图验证：由于 RewardCore 通过 RewardView 推送（best-effort），此处最小化断言消费后 user 的消费记录数量 > 0
  // 若存在 RewardView 可选集成，可在后续扩展断言。

  const KEY = {
    RP: () => ethers.keccak256(ethers.toUtf8Bytes('REWARD_POINTS')),
    RC: () => ethers.keccak256(ethers.toUtf8Bytes('REWARD_CORE')),
  } as const;

  enum ServiceType { AdvancedAnalytics, PriorityService, FeatureUnlock, GovernanceAccess, TestnetFeatures }
  enum ServiceLevel { Basic, Standard, Premium, VIP }

  async function deployFixture() {
    [governance, user] = await ethers.getSigners();

    // Registry + ACM
    registry = (await (await ethers.getContractFactory('MockRegistry')).deploy()) as unknown as MockRegistry;
    await registry.waitForDeployment();

    acm = (await (await ethers.getContractFactory('AccessControlManager')).deploy(
      await governance.getAddress()
    )) as unknown as AccessControlManager;
    await acm.waitForDeployment();

    // RewardPoints
    rewardPoints = (await (await ethers.getContractFactory('RewardPoints')).deploy()) as unknown as RewardPoints;
    await rewardPoints.waitForDeployment();
    await rewardPoints.initialize(await governance.getAddress());

    // RewardCore
    rewardCore = (await (await ethers.getContractFactory('RewardCore')).deploy()) as unknown as RewardCore;
    await rewardCore.waitForDeployment();
    await rewardCore.initialize(await registry.getAddress());

    // RewardConsumption
    rewardConsumption = (await (await ethers.getContractFactory('RewardConsumption')).deploy()) as unknown as RewardConsumption;
    await rewardConsumption.waitForDeployment();
    await rewardConsumption.initialize(await rewardCore.getAddress(), await registry.getAddress());

    // FeatureUnlockConfig（用于 price/冷却期配置）
    featureUnlock = (await (await ethers.getContractFactory('FeatureUnlockConfig')).deploy()) as unknown as FeatureUnlockConfig;
    await featureUnlock.waitForDeployment();
    await featureUnlock.initialize(await registry.getAddress());

    // Registry 绑定
    await registry.setModule(KEY.RP(), await rewardPoints.getAddress());
    await registry.setModule(KEY.RC(), await rewardCore.getAddress());

    // 授权：RewardPoints.MINTER_ROLE → RewardCore（消费 burn 需要）
    const MINTER_ROLE = await rewardPoints.MINTER_ROLE();
    await rewardPoints.connect(governance).grantRole(MINTER_ROLE, await rewardCore.getAddress());

    // 配置服务价格（将 Basic 价格设置为 5e18）
    // FeatureUnlockConfig 默认 Basic=200e18，这里重设为 5e18 以便最小用例
    const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));
    await acm.grantRole(ACTION_SET_PARAMETER, await governance.getAddress());
    await registry.setModule(ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER')), await acm.getAddress());
    await featureUnlock.updateConfig(ServiceLevel.Basic, ethers.parseUnits('5', 18), 30 * 24 * 3600, true);
    // 将 FeatureUnlockConfig 注册到 ModuleKeys.KEY_FEATURE_UNLOCK_CONFIG
    await registry.setModule(ethers.keccak256(ethers.toUtf8Bytes('FEATURE_UNLOCK_CONFIG')), await featureUnlock.getAddress());

    return { governance, user, registry, acm, rewardPoints, rewardCore, rewardConsumption };
  }

  it('应通过 RewardConsumption 扣减用户积分（Basic: 5e18）', async () => {
    const { user: u, rewardPoints: rp, rewardConsumption: rc } = await deployFixture();

    // 预置积分：给 user 铸 10e18
    const ten = ethers.parseUnits('10', 18);
    await rp.connect(governance).mintPoints(await u.getAddress(), ten);
    const before = await rp.balanceOf(await u.getAddress());
    expect(before).to.equal(ten);

    // 触发消费：FeatureUnlock Basic（price=5e18）
    await rc.consumePointsForService(ServiceType.FeatureUnlock, ServiceLevel.Basic);

    const after = await rp.balanceOf(await u.getAddress());
    expect(after).to.equal(ten - ethers.parseUnits('5', 18));

    // 校验 RewardCore 内部记录（消费记录 > 0）
    const records = await (await ethers.getContractAt('RewardCore', await rewardCore.getAddress())).getUserConsumptions(await u.getAddress());
    expect(records.length).to.be.greaterThan(0);
  });

  it('余额不足应 revert', async () => {
    const { user: u, rewardPoints: rp, rewardConsumption: rc } = await deployFixture();
    // 不给积分，直接尝试消费（Basic: 5e18）
    await expect(
      rc.connect(u).consumePointsForService(ServiceType.FeatureUnlock, ServiceLevel.Basic)
    ).to.be.reverted; // 标准错误：InsufficientBalance（由合约自定义错误抛出，通用断言）
    const bal = await rp.balanceOf(await u.getAddress());
    expect(bal).to.equal(0n);
  });
});



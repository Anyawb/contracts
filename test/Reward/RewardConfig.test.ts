import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;

import type { RewardConfig } from '../types/contracts/Reward/RewardConfig';
import type { AccessControlManager } from '../types/contracts/access';
import type { MockRegistry } from '../types/contracts/Mocks/MockRegistry';
import type {
  AdvancedAnalyticsConfig
} from '../types/contracts/Reward/configs/AdvancedAnalyticsConfig';
import type {
  PriorityServiceConfig
} from '../types/contracts/Reward/configs/PriorityServiceConfig';
import type {
  FeatureUnlockConfig
} from '../types/contracts/Reward/configs/FeatureUnlockConfig';
import type {
  GovernanceAccessConfig
} from '../types/contracts/Reward/configs/GovernanceAccessConfig';
import type {
  TestnetFeaturesConfig
} from '../types/contracts/Reward/configs/TestnetFeaturesConfig';

/// @title RewardConfig 模块化架构测试
/// @notice 测试奖励配置模块的拆分和功能
/// @dev 验证模块化架构的正确性和可升级性
describe('RewardConfig Modular Architecture', () => {
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const ONE_ETH = ethers.parseUnits('1', 18);

  let rewardConfig: RewardConfig;
  let advancedAnalyticsConfig: AdvancedAnalyticsConfig;
  let priorityServiceConfig: PriorityServiceConfig;
  let featureUnlockConfig: FeatureUnlockConfig;
  let governanceAccessConfig: GovernanceAccessConfig;
  let testnetFeaturesConfig: TestnetFeaturesConfig;
  let owner: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let user: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  let acm: AccessControlManager;
  let registry: MockRegistry;

  beforeEach(async () => {
    [owner, user] = await ethers.getSigners();

    // Registry + ACM
    const MockRegistry = await ethers.getContractFactory('MockRegistry');
    registry = (await MockRegistry.deploy()) as MockRegistry;
    await registry.waitForDeployment();

    const ACM = await ethers.getContractFactory('AccessControlManager');
    acm = (await ACM.deploy(owner.address)) as AccessControlManager;
    await acm.waitForDeployment();

    const KEY_ACM = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
    await registry.setModule(KEY_ACM, await acm.getAddress());

    // 部署子模块 - 使用代理模式避免重复初始化
    const AdvancedAnalyticsConfig = await ethers.getContractFactory('AdvancedAnalyticsConfig');
    const advancedAnalyticsImpl = await AdvancedAnalyticsConfig.deploy();
    await advancedAnalyticsImpl.waitForDeployment();
    
    const proxyFactory = await ethers.getContractFactory('ERC1967Proxy');
    const advancedAnalyticsProxy = await proxyFactory.deploy(
      await advancedAnalyticsImpl.getAddress(),
      advancedAnalyticsImpl.interface.encodeFunctionData('initialize', [await registry.getAddress()])
    );
    await advancedAnalyticsProxy.waitForDeployment();
    advancedAnalyticsConfig = AdvancedAnalyticsConfig.attach(await advancedAnalyticsProxy.getAddress()) as AdvancedAnalyticsConfig;

    const PriorityServiceConfig = await ethers.getContractFactory('PriorityServiceConfig');
    const priorityServiceImpl = await PriorityServiceConfig.deploy();
    await priorityServiceImpl.waitForDeployment();
    
    const priorityServiceProxy = await proxyFactory.deploy(
      await priorityServiceImpl.getAddress(),
      priorityServiceImpl.interface.encodeFunctionData('initialize', [await registry.getAddress()])
    );
    await priorityServiceProxy.waitForDeployment();
    priorityServiceConfig = PriorityServiceConfig.attach(await priorityServiceProxy.getAddress()) as PriorityServiceConfig;

    const FeatureUnlockConfig = await ethers.getContractFactory('FeatureUnlockConfig');
    const featureUnlockImpl = await FeatureUnlockConfig.deploy();
    await featureUnlockImpl.waitForDeployment();
    
    const featureUnlockProxy = await proxyFactory.deploy(
      await featureUnlockImpl.getAddress(),
      featureUnlockImpl.interface.encodeFunctionData('initialize', [await registry.getAddress()])
    );
    await featureUnlockProxy.waitForDeployment();
    featureUnlockConfig = FeatureUnlockConfig.attach(await featureUnlockProxy.getAddress()) as FeatureUnlockConfig;

    const GovernanceAccessConfig = await ethers.getContractFactory('GovernanceAccessConfig');
    const governanceAccessImpl = await GovernanceAccessConfig.deploy();
    await governanceAccessImpl.waitForDeployment();
    
    const governanceAccessProxy = await proxyFactory.deploy(
      await governanceAccessImpl.getAddress(),
      governanceAccessImpl.interface.encodeFunctionData('initialize', [await registry.getAddress()])
    );
    await governanceAccessProxy.waitForDeployment();
    governanceAccessConfig = GovernanceAccessConfig.attach(await governanceAccessProxy.getAddress()) as GovernanceAccessConfig;

    const TestnetFeaturesConfig = await ethers.getContractFactory('TestnetFeaturesConfig');
    const testnetFeaturesImpl = await TestnetFeaturesConfig.deploy();
    await testnetFeaturesImpl.waitForDeployment();
    
    const testnetFeaturesProxy = await proxyFactory.deploy(
      await testnetFeaturesImpl.getAddress(),
      testnetFeaturesImpl.interface.encodeFunctionData('initialize', [await registry.getAddress()])
    );
    await testnetFeaturesProxy.waitForDeployment();
    testnetFeaturesConfig = TestnetFeaturesConfig.attach(await testnetFeaturesProxy.getAddress()) as TestnetFeaturesConfig;

    // 部署主配置合约（使用代理，避免重复初始化）
    const RewardConfig = await ethers.getContractFactory('RewardConfig');
    const rewardConfigImpl = await RewardConfig.deploy();
    await rewardConfigImpl.waitForDeployment();
    const rewardConfigProxy = await proxyFactory.deploy(
      await rewardConfigImpl.getAddress(),
      rewardConfigImpl.interface.encodeFunctionData('initialize', [await registry.getAddress()])
    );
    await rewardConfigProxy.waitForDeployment();
    rewardConfig = RewardConfig.attach(await rewardConfigProxy.getAddress()) as RewardConfig;

    // 授权 SET_PARAMETER 给 owner
    const ROLE_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));
    if (!(await acm.hasRole(ROLE_SET_PARAMETER, owner.address))) {
      await acm.grantRole(ROLE_SET_PARAMETER, owner.address);
    }
    // 授权 RewardConfig 合约本身（内部调用子模块需要角色）
    if (!(await acm.hasRole(ROLE_SET_PARAMETER, await rewardConfig.getAddress()))) {
      await acm.grantRole(ROLE_SET_PARAMETER, await rewardConfig.getAddress());
    }

    // 设置服务配置模块
    await rewardConfig.setServiceConfigModule(0, await advancedAnalyticsConfig.getAddress()); // AdvancedAnalytics
    await rewardConfig.setServiceConfigModule(1, await priorityServiceConfig.getAddress()); // PriorityService
    await rewardConfig.setServiceConfigModule(2, await featureUnlockConfig.getAddress()); // FeatureUnlock
    await rewardConfig.setServiceConfigModule(3, await governanceAccessConfig.getAddress()); // GovernanceAccess
    await rewardConfig.setServiceConfigModule(4, await testnetFeaturesConfig.getAddress()); // TestnetFeatures
  });

  describe('部署和初始化', () => {
    it('应该正确部署所有配置模块', async () => {
      expect(await advancedAnalyticsConfig.getAddress()).to.not.equal(ZERO_ADDRESS);
      expect(await rewardConfig.getAddress()).to.not.equal(ZERO_ADDRESS);
    });

    it('应该正确设置服务配置模块', async () => {
      const configModule = await rewardConfig.serviceConfigModules(0); // AdvancedAnalytics
      expect(configModule).to.equal(await advancedAnalyticsConfig.getAddress());
    });

    it('应该正确初始化默认配置', async () => {
      // 验证高级数据分析基础配置
      const analyticsConfig = await rewardConfig.getServiceConfig(0, 0); // AdvancedAnalytics, Basic
      expect(analyticsConfig.price).to.be.gt(0);
      expect(analyticsConfig.duration).to.equal(30 * 24 * 60 * 60); // 30 days
      expect(analyticsConfig.isActive).to.be.true;
      expect(analyticsConfig.description).to.equal('Basic data analysis report with market trends');
    });
  });

  describe('配置查询', () => {
    it('应该正确查询服务配置', async () => {
      // 测试不同服务类型和等级
      const configs = [
        { serviceType: 0, level: 0 }, // AdvancedAnalytics Basic
        { serviceType: 1, level: 1 }, // PriorityService Standard
        { serviceType: 2, level: 2 }, // FeatureUnlock Premium
        { serviceType: 3, level: 3 }, // GovernanceAccess VIP
        { serviceType: 4, level: 0 }  // TestnetFeatures Basic
      ];

      for (const config of configs) {
        const serviceConfig = await rewardConfig.getServiceConfig(config.serviceType, config.level);
        expect(serviceConfig.price).to.be.gt(0);
        expect(serviceConfig.isActive).to.be.true;
      }
    });

    it('应该正确查询服务冷却期', async () => {
      const cooldowns = [
        { serviceType: 0, expectedCooldown: 24 * 60 * 60 }, // AdvancedAnalytics: 1 day
        { serviceType: 1, expectedCooldown: 12 * 60 * 60 }, // PriorityService: 12 hours
        { serviceType: 2, expectedCooldown: 7 * 24 * 60 * 60 }, // FeatureUnlock: 7 days
        { serviceType: 3, expectedCooldown: 30 * 24 * 60 * 60 }, // GovernanceAccess: 30 days
        { serviceType: 4, expectedCooldown: 60 * 60 } // TestnetFeatures: 1 hour
      ];

      for (const cooldown of cooldowns) {
        const actualCooldown = await rewardConfig.serviceCooldowns(cooldown.serviceType);
        expect(actualCooldown).to.equal(cooldown.expectedCooldown);
      }
    });
  });

  describe('配置更新', () => {
    it('应该允许治理者更新服务配置', async () => {
      const newPrice = ethers.parseEther('200');
      const newDuration = 60 * 24 * 60 * 60; // 60 days
      const newIsActive = false;

      await rewardConfig.updateServiceConfig(0, 0, newPrice, newDuration, newIsActive); // AdvancedAnalytics Basic

      const updatedConfig = await rewardConfig.getServiceConfig(0, 0);
      expect(updatedConfig.price).to.equal(newPrice);
      expect(updatedConfig.duration).to.equal(newDuration);
      expect(updatedConfig.isActive).to.equal(newIsActive);
    });

    it('应该允许治理者更新服务冷却期', async () => {
      const newCooldown = 48 * 60 * 60; // 48 hours
      await rewardConfig.setServiceCooldown(0, newCooldown); // AdvancedAnalytics

      const updatedCooldown = await rewardConfig.serviceCooldowns(0);
      expect(updatedCooldown).to.equal(newCooldown);
    });

    it('应该允许治理者更新升级倍数', async () => {
      const newMultiplier = 20000; // 2x
      await rewardConfig.setUpgradeMultiplier(newMultiplier);

      expect(await rewardConfig.upgradeMultiplier()).to.equal(newMultiplier);
    });

    it('应该允许治理者更新测试网模式', async () => {
      await rewardConfig.setTestnetMode(false);
      expect(await rewardConfig.isTestnetMode()).to.be.false;

      await rewardConfig.setTestnetMode(true);
      expect(await rewardConfig.isTestnetMode()).to.be.true;
    });
  });

  describe('权限控制', () => {
    it('应该只允许治理者更新配置', async () => {
      await expect(
        rewardConfig.connect(user).updateServiceConfig(0, 0, ONE_ETH, 30 * 24 * 60 * 60, true)
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('应该只允许治理者设置服务配置模块', async () => {
      await expect(
        rewardConfig.connect(user).setServiceConfigModule(0, ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });
  });

  describe('错误处理', () => {
    it('应该拒绝无效的服务配置模块地址', async () => {
      await expect(
        rewardConfig.setServiceConfigModule(0, ZERO_ADDRESS)
      ).to.be.revertedWith('Invalid config module address');
    });

    it('应该拒绝查询未配置的服务类型', async () => {
      await expect(
        rewardConfig.getServiceConfig(99, 0)
      ).to.be.reverted;
    });
  });

  describe('模块化架构优势', () => {
    it('应该支持独立升级子模块', async () => {
      // 部署新的高级数据分析配置合约
      const NewAdvancedAnalyticsConfig = await ethers.getContractFactory('AdvancedAnalyticsConfig');
      const newAdvancedAnalyticsImpl = await NewAdvancedAnalyticsConfig.deploy() as AdvancedAnalyticsConfig;

      const proxyFactory = await ethers.getContractFactory('ERC1967Proxy');
      const newAdvancedAnalyticsProxy = await proxyFactory.deploy(
        await newAdvancedAnalyticsImpl.getAddress(),
        newAdvancedAnalyticsImpl.interface.encodeFunctionData('initialize', [await registry.getAddress()])
      );
      await newAdvancedAnalyticsProxy.waitForDeployment();
      const newAdvancedAnalyticsConfig = NewAdvancedAnalyticsConfig.attach(
        await newAdvancedAnalyticsProxy.getAddress()
      ) as AdvancedAnalyticsConfig;

      // 更新主配置合约中的模块引用
      await rewardConfig.setServiceConfigModule(0, await newAdvancedAnalyticsConfig.getAddress());

      // 验证新模块正常工作
      const config = await rewardConfig.getServiceConfig(0, 0);
      expect(config.price).to.equal(ethers.parseEther('200'));
    });

    it('应该保持向后兼容性', async () => {
      // 验证所有原有的服务类型仍然可用
      const serviceTypes = [0, 1, 2, 3, 4]; // 所有服务类型
      
      for (const serviceType of serviceTypes) {
        const config = await rewardConfig.getServiceConfig(serviceType, 0);
        expect(config.isActive).to.be.true;
        expect(config.price).to.be.gt(0);
      }
    });
  });
}); 
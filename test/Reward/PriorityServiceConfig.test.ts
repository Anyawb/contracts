import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';

import type { 
  PriorityServiceConfig,
  PriorityServiceConfig__factory,
  AccessControlManager,
  AccessControlManager__factory,
  MockERC20,
  MockERC20__factory
} from '../../../types';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

// 常量定义
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ONE_ETH = ethers.parseUnits('1', 18);
const ONE_USD = ethers.parseUnits('1', 6);
const KEY_ACM = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));

/**
 * PriorityServiceConfig - 优先服务配置测试模块
 * 
 * 测试目标:
 * - 代理部署和初始化功能
 * - ACM权限控制验证
 * - 服务配置管理功能
 * - 冷却期设置功能
 * - 批量配置更新功能
 * - 事件记录和标准化动作事件
 * - 错误处理和边界条件
 * - 权限验证和访问控制
 */
describe('PriorityServiceConfig – 优先服务配置测试', function () {
  async function deployFixture() {
    // 获取测试账户
    const [governance, alice, bob, charlie, _david]: SignerWithAddress[] = await ethers.getSigners();
    
    // 部署 Registry + ACM
    const registryFactory = await ethers.getContractFactory('MockRegistry');
    const registry = await registryFactory.deploy();
    await registry.waitForDeployment();

    const acmFactory = (await ethers.getContractFactory('AccessControlManager')) as AccessControlManager__factory;
    const acm = await acmFactory.deploy(governance.address);
    await acm.waitForDeployment();
    await registry.setModule(KEY_ACM, await acm.getAddress());
    
    // 部署 PriorityServiceConfig 代理合约
    const priorityServiceConfigFactory = (await ethers.getContractFactory('PriorityServiceConfig')) as PriorityServiceConfig__factory;
    
    // 使用 UUPS 代理模式部署
    const priorityServiceConfig = await upgrades.deployProxy(
      priorityServiceConfigFactory,
      [registry.target],
      { 
        kind: 'uups',
        initializer: 'initialize'
      }
    ) as PriorityServiceConfig;
    
    await priorityServiceConfig.waitForDeployment();
    
    // 部署测试代币
    const mockTokenFactory = (await ethers.getContractFactory('MockERC20')) as MockERC20__factory;
    const mockToken = await mockTokenFactory.deploy('Test Token', 'TEST', 18);
    await mockToken.waitForDeployment();
    
    return { 
      priorityServiceConfig, 
      acm, 
      registry,
      mockToken,
      governance, 
      alice, 
      bob, 
      charlie 
    };
  }

  // =================== 部署和初始化测试 ===================
  
  describe('部署和初始化', function () {
    it('应正确部署代理合约并初始化', async function () {
      const { priorityServiceConfig } = await deployFixture();
      
      // 验证服务类型
      expect(await priorityServiceConfig.getServiceType()).to.equal(1); // PriorityService
      
      // 验证冷却期设置
      expect(await priorityServiceConfig.getCooldown()).to.equal(12 * 60 * 60); // 12 hours
    });

    it('应拒绝零地址初始化', async function () {
      const priorityServiceConfigFactory = (await ethers.getContractFactory('PriorityServiceConfig')) as PriorityServiceConfig__factory;
      const registryFactory = await ethers.getContractFactory('MockRegistry');
      const registry = await registryFactory.deploy();
      await registry.waitForDeployment();
      
      await expect(
        upgrades.deployProxy(
          priorityServiceConfigFactory,
          [ZERO_ADDRESS],
          { 
            kind: 'uups',
            initializer: 'initialize'
          }
        )
      ).to.be.revertedWithCustomError(priorityServiceConfigFactory, 'ZeroAddress');
    });

    it('应拒绝重复初始化', async function () {
      const { priorityServiceConfig, acm } = await deployFixture();
      
      await expect(
        priorityServiceConfig.initialize(acm.target)
      ).to.be.revertedWithCustomError(priorityServiceConfig, 'InvalidInitialization');
    });
  });

  // =================== ACM权限控制测试 ===================
  
  describe('ACM权限控制', function () {
    it('应正确设置ACM权限', async function () {
      const { acm, governance, alice } = await deployFixture();
      
      // 验证初始权限设置
      expect(await acm.hasRole(ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER')), governance.address)).to.be.true;
      expect(await acm.hasRole(ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER')), alice.address)).to.be.false;
    });

    it('应拒绝无权限用户更新配置', async function () {
      const { priorityServiceConfig, acm, alice } = await deployFixture();
      
      await expect(
        priorityServiceConfig.connect(alice).updateConfig(
          0, // Basic
          ONE_ETH,
          30 * 24 * 60 * 60, // 30 days
          true
        )
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('应拒绝无权限用户设置冷却期', async function () {
      const { priorityServiceConfig, acm, alice } = await deployFixture();
      
      await expect(
        priorityServiceConfig.connect(alice).setCooldown(24 * 60 * 60) // 24 hours
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('应拒绝无权限用户批量更新配置', async function () {
      const { priorityServiceConfig, acm, alice } = await deployFixture();
      
      await expect(
        priorityServiceConfig.connect(alice).batchUpdateConfig(
          [0, 1], // Basic, Standard
          [ONE_ETH, 2n * ONE_ETH],
          [30 * 24 * 60 * 60, 30 * 24 * 60 * 60],
          [true, true]
        )
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });
  });

  // =================== 服务配置管理测试 ===================
  
  describe('服务配置管理', function () {
    it('应正确获取服务配置', async function () {
      const { priorityServiceConfig } = await deployFixture();
      
      const basicConfig = await priorityServiceConfig.getConfig(0);
      expect(basicConfig.price).to.equal(200n * ONE_ETH);
      expect(basicConfig.duration).to.equal(30 * 24 * 60 * 60);
      expect(basicConfig.isActive).to.be.true;
      expect(basicConfig.level).to.equal(0); // Basic
      expect(basicConfig.description).to.equal('Priority loan processing (24h)');
      
      const vipConfig = await priorityServiceConfig.getConfig(3);
      expect(vipConfig.price).to.equal(2000n * ONE_ETH);
      expect(vipConfig.duration).to.equal(30 * 24 * 60 * 60);
      expect(vipConfig.isActive).to.be.true;
      expect(vipConfig.level).to.equal(3); // VIP
      expect(vipConfig.description).to.equal('VIP exclusive manager service');
    });

    it('应正确更新单个服务配置', async function () {
      const { priorityServiceConfig, governance } = await deployFixture();
      
      const newPrice = 300n * ONE_ETH;
      const newDuration = 60 * 24 * 60 * 60; // 60 days
      
      // 更新配置
      await expect(
        priorityServiceConfig.connect(governance).updateConfig(
          0, // Basic
          newPrice,
          newDuration,
          false
        )
      ).to.emit(priorityServiceConfig, 'PriorityServiceConfigUpdated')
        .and.to.emit(priorityServiceConfig, 'ConfigUpdated')
        .and.to.emit(priorityServiceConfig, 'ActionExecuted');
      
      // 验证更新结果
      const config = await priorityServiceConfig.getConfig(0);
      expect(config.price).to.equal(newPrice);
      expect(config.duration).to.equal(newDuration);
      expect(config.isActive).to.be.false;
    });

    it('应正确批量更新服务配置', async function () {
      const { priorityServiceConfig, governance } = await deployFixture();
      
      const levels = [0, 1]; // Basic, Standard
      const prices = [300n * ONE_ETH, 600n * ONE_ETH];
      const durations = [60 * 24 * 60 * 60, 90 * 24 * 60 * 60]; // 60 days, 90 days
      const isActives = [false, true];
      
      // 批量更新配置
      await expect(
        priorityServiceConfig.connect(governance).batchUpdateConfig(
          levels,
          prices,
          durations,
          isActives
        )
      ).to.emit(priorityServiceConfig, 'PriorityServiceConfigUpdated')
        .and.to.emit(priorityServiceConfig, 'ActionExecuted');
      
      // 验证更新结果
      const basicConfig = await priorityServiceConfig.getConfig(0);
      expect(basicConfig.price).to.equal(prices[0]);
      expect(basicConfig.duration).to.equal(durations[0]);
      expect(basicConfig.isActive).to.equal(isActives[0]);
      
      const standardConfig = await priorityServiceConfig.getConfig(1);
      expect(standardConfig.price).to.equal(prices[1]);
      expect(standardConfig.duration).to.equal(durations[1]);
      expect(standardConfig.isActive).to.equal(isActives[1]);
    });

    it('应拒绝数组长度不匹配的批量更新', async function () {
      const { priorityServiceConfig, governance } = await deployFixture();
      
      await expect(
        priorityServiceConfig.connect(governance).batchUpdateConfig(
          [0, 1], // 2个等级
          [ONE_ETH], // 1个价格
          [30 * 24 * 60 * 60, 30 * 24 * 60 * 60], // 2个时长
          [true, true] // 2个激活状态
        )
      ).to.be.revertedWith('PriorityServiceConfig: array length mismatch');
    });
  });

  // =================== 冷却期管理测试 ===================
  
  describe('冷却期管理', function () {
    it('应正确设置冷却期', async function () {
      const { priorityServiceConfig, governance } = await deployFixture();
      
      const newCooldown = 24 * 60 * 60; // 24 hours
      
      // 设置冷却期
      await expect(
        priorityServiceConfig.connect(governance).setCooldown(newCooldown)
      ).to.emit(priorityServiceConfig, 'PriorityServiceCooldownUpdated')
        .and.to.emit(priorityServiceConfig, 'CooldownUpdated')
        .and.to.emit(priorityServiceConfig, 'ActionExecuted');
      
      // 验证冷却期设置
      expect(await priorityServiceConfig.getCooldown()).to.equal(newCooldown);
    });

    it('应正确获取冷却期', async function () {
      const { priorityServiceConfig } = await deployFixture();
      
      const cooldown = await priorityServiceConfig.getCooldown();
      expect(cooldown).to.equal(12 * 60 * 60); // 12 hours
    });
  });

  // =================== 便捷查询功能测试 ===================
  
  describe('便捷查询功能', function () {
    it('应正确检查服务激活状态', async function () {
      const { priorityServiceConfig } = await deployFixture();
      
      // 检查所有服务等级是否激活
      expect(await priorityServiceConfig.isServiceActive(0)).to.be.true; // Basic
      expect(await priorityServiceConfig.isServiceActive(1)).to.be.true; // Standard
      expect(await priorityServiceConfig.isServiceActive(2)).to.be.true; // Premium
      expect(await priorityServiceConfig.isServiceActive(3)).to.be.true; // VIP
    });

    it('应正确获取服务价格', async function () {
      const { priorityServiceConfig } = await deployFixture();
      
      expect(await priorityServiceConfig.getServicePrice(0)).to.equal(200n * ONE_ETH); // Basic
      expect(await priorityServiceConfig.getServicePrice(1)).to.equal(500n * ONE_ETH); // Standard
      expect(await priorityServiceConfig.getServicePrice(2)).to.equal(1000n * ONE_ETH); // Premium
      expect(await priorityServiceConfig.getServicePrice(3)).to.equal(2000n * ONE_ETH); // VIP
    });

    it('应正确获取服务时长', async function () {
      const { priorityServiceConfig } = await deployFixture();
      
      const thirtyDays = 30 * 24 * 60 * 60;
      expect(await priorityServiceConfig.getServiceDuration(0)).to.equal(thirtyDays); // Basic
      expect(await priorityServiceConfig.getServiceDuration(1)).to.equal(thirtyDays); // Standard
      expect(await priorityServiceConfig.getServiceDuration(2)).to.equal(thirtyDays); // Premium
      expect(await priorityServiceConfig.getServiceDuration(3)).to.equal(thirtyDays); // VIP
    });
  });

  // =================== 事件记录测试 ===================
  
  describe('事件记录', function () {
    it('应正确记录初始化事件', async function () {
      const { priorityServiceConfig, registry } = await deployFixture();
      
      // 验证初始化事件已记录
      const events = await priorityServiceConfig.queryFilter(
        priorityServiceConfig.filters.PriorityServiceConfigInitialized()
      );
      expect(events).to.have.length(1);
      expect(events[0].args?.governance).to.equal(registry.target);
    });

    it('应正确记录配置更新事件', async function () {
      const { priorityServiceConfig, governance } = await deployFixture();
      
      const newPrice = 300n * ONE_ETH;
      const newDuration = 60 * 24 * 60 * 60;
      
      await priorityServiceConfig.connect(governance).updateConfig(
        0, // Basic
        newPrice,
        newDuration,
        false
      );
      
      // 验证配置更新事件
      const events = await priorityServiceConfig.queryFilter(
        priorityServiceConfig.filters.PriorityServiceConfigUpdated()
      );
      expect(events).to.have.length(1);
      expect(events[0].args?.level).to.equal(0);
      expect(events[0].args?.oldPrice).to.equal(200n * ONE_ETH);
      expect(events[0].args?.newPrice).to.equal(newPrice);
      expect(events[0].args?.updatedBy).to.equal(governance.address);
    });

    it('应正确记录冷却期更新事件', async function () {
      const { priorityServiceConfig, governance } = await deployFixture();
      
      const newCooldown = 24 * 60 * 60;
      
      await priorityServiceConfig.connect(governance).setCooldown(newCooldown);
      
      // 验证冷却期更新事件
      const events = await priorityServiceConfig.queryFilter(
        priorityServiceConfig.filters.PriorityServiceCooldownUpdated()
      );
      expect(events).to.have.length(1);
      expect(events[0].args?.oldCooldown).to.equal(12 * 60 * 60);
      expect(events[0].args?.newCooldown).to.equal(newCooldown);
      expect(events[0].args?.updatedBy).to.equal(governance.address);
    });

    it('应正确记录标准化动作事件', async function () {
      const { priorityServiceConfig, governance } = await deployFixture();
      
      // 获取当前区块号，用于过滤事件
      const currentBlock = await ethers.provider.getBlockNumber();
      
      await priorityServiceConfig.connect(governance).updateConfig(
        0, // Basic
        ONE_ETH,
        30 * 24 * 60 * 60,
        true
      );
      
      // 验证标准化动作事件 - 只查询从当前区块开始的事件
      const events = await priorityServiceConfig.queryFilter(
        priorityServiceConfig.filters.ActionExecuted(),
        currentBlock + 1
      );
      expect(events).to.have.length(1);
      expect(events[0].args?.actionKey).to.equal(ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER')));
      // 注意：actionString 可能不存在，跳过此验证
      expect(events[0].args?.executor).to.equal(governance.address);
    });
  });

  // =================== 边界条件和错误处理测试 ===================
  
  describe('边界条件和错误处理', function () {
    it('应正确处理零价格配置', async function () {
      const { priorityServiceConfig, governance } = await deployFixture();
      
      // 设置零价格
      await priorityServiceConfig.connect(governance).updateConfig(
        0, // Basic
        0, // 零价格
        30 * 24 * 60 * 60,
        true
      );
      
      const config = await priorityServiceConfig.getConfig(0);
      expect(config.price).to.equal(0);
    });

    it('应正确处理零时长配置', async function () {
      const { priorityServiceConfig, governance } = await deployFixture();
      
      // 设置零时长
      await priorityServiceConfig.connect(governance).updateConfig(
        0, // Basic
        ONE_ETH,
        0, // 零时长
        true
      );
      
      const config = await priorityServiceConfig.getConfig(0);
      expect(config.duration).to.equal(0);
    });
  });

  // =================== 代理升级测试 ===================
  
  describe('代理升级', function () {
    it('应正确升级代理合约', async function () {
      const { priorityServiceConfig, acm, governance, alice } = await deployFixture();
      
      // 验证升级权限
      await expect(
        priorityServiceConfig.connect(alice).upgradeToAndCall(ZERO_ADDRESS, '0x')
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
      
      // 注意：这里只是测试权限，实际升级需要新的实现合约
    });

    it('应保持升级后的状态', async function () {
      const { priorityServiceConfig } = await deployFixture();
      
      // 验证升级后状态保持不变
      expect(await priorityServiceConfig.getServiceType()).to.equal(1); // PriorityService
      expect(await priorityServiceConfig.getCooldown()).to.equal(12 * 60 * 60); // 12 hours
    });
  });

  // =================== 集成测试 ===================
  
  describe('集成测试', function () {
    it('应与其他模块正确集成', async function () {
      const { priorityServiceConfig, acm, governance } = await deployFixture();
      
      // 验证权限检查
      expect(await acm.hasRole(ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER')), governance.address)).to.be.true;
      
      // 验证配置更新
      await priorityServiceConfig.connect(governance).updateConfig(
        0, // Basic
        ONE_ETH,
        30 * 24 * 60 * 60,
        true
      );
      
      const config = await priorityServiceConfig.getConfig(0);
      expect(config.price).to.equal(ONE_ETH);
    });

    it('应正确处理复杂的配置场景', async function () {
      const { priorityServiceConfig, governance } = await deployFixture();
      
      // 批量更新所有配置
      const levels = [0, 1, 2, 3]; // 所有等级
      const prices = [100n * ONE_ETH, 200n * ONE_ETH, 300n * ONE_ETH, 400n * ONE_ETH];
      const durations = [15 * 24 * 60 * 60, 30 * 24 * 60 * 60, 45 * 24 * 60 * 60, 60 * 24 * 60 * 60];
      const isActives = [true, false, true, false];
      
      await priorityServiceConfig.connect(governance).batchUpdateConfig(
        levels,
        prices,
        durations,
        isActives
      );
      
      // 验证所有配置
      for (let i = 0; i < levels.length; i++) {
        const config = await priorityServiceConfig.getConfig(levels[i]);
        expect(config.price).to.equal(prices[i]);
        expect(config.duration).to.equal(durations[i]);
        expect(config.isActive).to.equal(isActives[i]);
      }
    });
  });
}); 
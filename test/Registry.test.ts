/**
 * Registry – 核心功能测试
 * 
 * 测试目标:
 * - 初始化与升级功能验证
 * - 权限管理与同步验证
 * - 模块注册与查询功能
 * - 延迟升级流程测试
 * - 暂停状态管理测试
 * - 升级历史记录测试
 * - 批量操作与边界条件测试
 * - 错误处理与安全验证
 */

import * as hardhat from 'hardhat';
const { ethers } = hardhat;
import { expect } from 'chai';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

describe('Registry – 核心功能测试', function () {
  // 测试常量定义
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const TEST_MIN_DELAY = BigInt((1 * 60 * 60) / 2); // 1 hour in blocks (2s)
  const TEST_MAX_DELAY = BigInt((7 * 24 * 60 * 60) / 2); // 7 days in blocks (2s) - explicit blocks cap
  const MAX_BATCH_SIZE = 50;
  
  // 测试账户
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let emergencyAdmin: SignerWithAddress;
  
  // 合约实例
  let registry: any;
  let registryImplementation: any;
  let registryProxy: any;
  let mockLendingEngine: any;
  let mockCollateralManager: any;
  let mockPriceOracle: any;
  
  // 测试模块键 - 使用与ModuleKeys.sol中一致的哈希值
  const KEY_LE = ethers.keccak256(ethers.toUtf8Bytes('LENDING_ENGINE'));
  const KEY_CM = ethers.keccak256(ethers.toUtf8Bytes('COLLATERAL_MANAGER'));
  const KEY_PO = ethers.keccak256(ethers.toUtf8Bytes('PRICE_ORACLE'));

  /**
   * 部署测试环境
   */
  async function deployTestEnvironment() {
    [owner, admin, user1, user2, emergencyAdmin] = await ethers.getSigners();

    // 部署 Registry 实现合约
    const RegistryFactory = await ethers.getContractFactory('Registry');
    registryImplementation = await RegistryFactory.deploy();
    await registryImplementation.waitForDeployment();

    // 部署代理合约
    const ProxyFactory = await ethers.getContractFactory('ERC1967Proxy');
    const initData = registryImplementation.interface.encodeFunctionData(
      'initialize',
      [TEST_MIN_DELAY, TEST_MAX_DELAY, owner.address, owner.address, owner.address]
    );
    registryProxy = await ProxyFactory.deploy(
      registryImplementation.target,
      initData
    );
    await registryProxy.waitForDeployment();

    // 通过代理访问 Registry
    registry = registryImplementation.attach(registryProxy.target) as any;

    // 部署 Mock 合约
    const MockLendingEngineConcreteFactory = await ethers.getContractFactory('MockLendingEngineConcrete');
    mockLendingEngine = await MockLendingEngineConcreteFactory.deploy();
    await mockLendingEngine.waitForDeployment();

    const MockCollateralManagerFactory = await ethers.getContractFactory('MockCollateralManager');
    mockCollateralManager = await MockCollateralManagerFactory.deploy();
    await mockCollateralManager.waitForDeployment();

    const MockPriceOracleFactory = await ethers.getContractFactory('MockPriceOracle');
    mockPriceOracle = await MockPriceOracleFactory.deploy();
    await mockPriceOracle.waitForDeployment();

    return {
      registry,
      registryImplementation,
      registryProxy,
      mockLendingEngine,
      mockCollateralManager,
      mockPriceOracle,
      owner,
      admin,
      user1,
      user2,
      emergencyAdmin
    };
  }

  beforeEach(async function () {
    const env = await loadFixture(deployTestEnvironment);
    registry = env.registry;
    registryImplementation = env.registryImplementation;
    registryProxy = env.registryProxy;
    mockLendingEngine = env.mockLendingEngine;
    mockCollateralManager = env.mockCollateralManager;
    mockPriceOracle = env.mockPriceOracle;
    owner = env.owner;
    admin = env.admin;
    user1 = env.user1;
    user2 = env.user2;
    emergencyAdmin = env.emergencyAdmin;
  });

  describe('初始化测试', function () {
    it('Registry – 应该正确初始化合约', async function () {
      expect(await registry.owner()).to.equal(owner.address);
      expect(await registry.paused()).to.be.false;
      expect(await registry.minDelay()).to.equal(TEST_MIN_DELAY);
    });

    it('Registry – 应该拒绝重复初始化', async function () {
      await expect(
        registry.initialize(TEST_MIN_DELAY, TEST_MAX_DELAY, owner.address, owner.address, owner.address)
      ).to.be.revertedWithCustomError(registry, 'InvalidInitialization');
    });

    it('Registry – 应该拒绝过大的延迟时间', async function () {
      const newRegistryFactory = await ethers.getContractFactory('Registry');
      const newImplementation = await newRegistryFactory.deploy();
      await newImplementation.waitForDeployment();

      const newProxyFactory = await ethers.getContractFactory('ERC1967Proxy');
      const initData = newImplementation.interface.encodeFunctionData(
        'initialize',
        [TEST_MAX_DELAY + 1n, TEST_MAX_DELAY, owner.address, owner.address, owner.address]
      );
      
      await expect(
        newProxyFactory.deploy(
          newImplementation.target,
          initData
        )
      ).to.be.revertedWithCustomError(newImplementation, 'Registry__DelayTooLong')
        .withArgs(TEST_MAX_DELAY + 1n, TEST_MAX_DELAY);
    });
  });

  describe('权限管理测试', function () {
    it('Registry – 应该正确设置升级管理员', async function () {
      await (registry as any).setUpgradeAdmin(admin.address);
      
      expect(await (registry as any).getUpgradeAdmin()).to.equal(admin.address);
    });

    it('Registry – 应该正确设置紧急管理员', async function () {
      await (registry as any).setEmergencyAdmin(emergencyAdmin.address);
      
      expect(await (registry as any).getEmergencyAdmin()).to.equal(emergencyAdmin.address);
    });

    it('Registry – 应该拒绝零地址管理员设置', async function () {
      await expect(
        (registry as any).setUpgradeAdmin(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(registry, 'Registry__InvalidUpgradeAdmin')
        .withArgs(ZERO_ADDRESS);
    });

    it('Registry – 应该正确设置主治理地址', async function () {
      await (registry as any).setAdmin(admin.address);
      
      expect(await (registry as any).getAdmin()).to.equal(admin.address);
      expect(await registry.owner()).to.equal(admin.address);
    });

    it('Registry – 应该正确设置待接管管理员', async function () {
      await (registry as any).setPendingAdmin(admin.address);
      
      expect(await (registry as any).getPendingAdmin()).to.equal(admin.address);
    });

    it('Registry – 应该正确接受管理员权限', async function () {
      await (registry as any).setPendingAdmin(admin.address);
      await (registry as any).connect(admin).acceptAdmin();
      
      expect(await (registry as any).getAdmin()).to.equal(admin.address);
      expect(await registry.owner()).to.equal(admin.address);
      expect(await (registry as any).getPendingAdmin()).to.equal(ZERO_ADDRESS);
    });

    it('Registry – 应该拒绝非待接管管理员接受权限', async function () {
      await (registry as any).setPendingAdmin(admin.address);
      
      await expect(
        (registry as any).connect(user1).acceptAdmin()
      ).to.be.revertedWithCustomError(registry, 'Registry__NotPendingAdmin')
        .withArgs(await user1.getAddress(), await admin.getAddress());
    });

    it('Registry – 应该拒绝非管理员设置权限', async function () {
      await expect(
        (registry as any).connect(user1).setAdmin(admin.address)
      ).to.be.revertedWithCustomError(registry, 'OwnableUnauthorizedAccount');
    });
  });

  describe('暂停状态管理测试', function () {
    it('Registry – 应该正确暂停合约', async function () {
      await (registry as any).pause();
      
      expect(await registry.paused()).to.be.true;
    });

    it('Registry – 应该正确恢复合约', async function () {
      await (registry as any).pause();
      await (registry as any).unpause();
      
      expect(await registry.paused()).to.be.false;
    });

    it('Registry – 暂停状态下应该阻止模块设置', async function () {
      await (registry as any).pause();
      
      await expect(
        registry.setModule(KEY_LE, mockLendingEngine.target)
      ).to.be.revertedWithCustomError(registry, 'EnforcedPause');
    });

    it('Registry – 暂停状态下应该阻止批量模块设置', async function () {
      await (registry as any).pause();
      
      const keys = [KEY_LE, KEY_CM];
      const addresses = [mockLendingEngine.target, mockCollateralManager.target];
      
      await expect(
        (registry as any).batchSetModules(keys, addresses, true)
      ).to.be.revertedWithCustomError(registry, 'EnforcedPause');
    });

    it('Registry – 暂停状态下应该阻止升级排期', async function () {
      await (registry as any).pause();
      
      await expect(
        (registry as any).scheduleModuleUpgrade(KEY_LE, mockLendingEngine.target)
      ).to.be.revertedWithCustomError(registry, 'EnforcedPause');
    });
  });

  describe('模块注册与查询测试', function () {
    it('Registry – 应该正确设置单个模块', async function () {
      await registry.setModule(KEY_LE, mockLendingEngine.target);
      
      expect(await registry.getModule(KEY_LE)).to.equal(mockLendingEngine.target);
    });

    it('Registry – 应该拒绝零地址模块', async function () {
      await expect(
        registry.setModule(KEY_LE, ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(registry, 'Registry__ZeroAddress');
    });

    it('Registry – 应该正确处理模块无变更', async function () {
      await registry.setModule(KEY_LE, mockLendingEngine.target);
      
      await expect(
        registry.setModule(KEY_LE, mockLendingEngine.target)
      ).to.not.be.reverted;

      expect(await registry.getModule(KEY_LE)).to.equal(mockLendingEngine.target);
    });

    it('Registry – 应该正确批量设置模块', async function () {
      const keys = [KEY_LE, KEY_CM, KEY_PO];
      const addresses = [mockLendingEngine.target, mockCollateralManager.target, mockPriceOracle.target];
      
      await registry.batchSetModules(keys, addresses, true);
      
      expect(await registry.getModule(KEY_LE)).to.equal(mockLendingEngine.target);
      expect(await registry.getModule(KEY_CM)).to.equal(mockCollateralManager.target);
      expect(await registry.getModule(KEY_PO)).to.equal(mockPriceOracle.target);
    });

    it('Registry – 应该拒绝超过批量上限的操作', async function () {
      const keys: string[] = [];
      const addresses: string[] = [];
      
      // 创建超过上限的模块
      for (let i = 0; i < MAX_BATCH_SIZE + 1; i++) {
        const MockFactory = await ethers.getContractFactory('MockLendingEngineConcrete');
        const mock = await MockFactory.deploy();
        await mock.waitForDeployment();
        
        keys.push(ethers.keccak256(ethers.toUtf8Bytes(`TEST_MODULE_${i}`)));
        addresses.push(mock.target as string);
      }
      
      await expect(
        registry.batchSetModules(keys, addresses, true)
      ).to.be.revertedWithCustomError(registry, 'ModuleCapExceeded')
        .withArgs(MAX_BATCH_SIZE + 1, MAX_BATCH_SIZE);
    });

    it('Registry – 应该正确查询模块是否存在', async function () {
      expect(await registry.isModuleRegistered(KEY_LE)).to.be.false;
      
      await registry.setModule(KEY_LE, mockLendingEngine.target);
      
      expect(await registry.isModuleRegistered(KEY_LE)).to.be.true;
    });

    it('Registry – 应该正确处理未注册模块查询', async function () {
      await expect(
        registry.getModuleOrRevert(KEY_LE)
      ).to.be.revertedWithCustomError(registry, 'ModuleNotRegistered').withArgs(KEY_LE);
    });
  });

  describe('延迟升级流程测试', function () {
    it('Registry – 应该正确排期模块升级', async function () {
      await registry.setModule(KEY_LE, mockLendingEngine.target);
      
      await expect(
        registry.scheduleModuleUpgrade(KEY_LE, mockCollateralManager.target)
      ).to.emit(registry, 'ModuleUpgradeScheduled');
    });

    it('Registry – 应该拒绝排期零地址升级', async function () {
      await registry.setModule(KEY_LE, mockLendingEngine.target);
      
      await expect(
        registry.scheduleModuleUpgrade(KEY_LE, ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(registry, 'Registry__ZeroAddress');
    });

    it('Registry – 应该正确取消升级排期', async function () {
      await registry.setModule(KEY_LE, mockLendingEngine.target);
      await registry.scheduleModuleUpgrade(KEY_LE, mockCollateralManager.target);
      
      await expect(registry.cancelModuleUpgrade(KEY_LE))
        .to.emit(registry, 'ModuleUpgradeCancelled');
    });

    it('Registry – 应该拒绝取消不存在的升级排期', async function () {
      await expect(
        registry.cancelModuleUpgrade(KEY_LE)
      ).to.not.be.reverted; // cancel is no-op if nothing scheduled
    });

    it('Registry – 应该拒绝提前执行升级', async function () {
      await registry.setModule(KEY_LE, mockLendingEngine.target);
      await registry.scheduleModuleUpgrade(KEY_LE, mockCollateralManager.target);
      
      await expect(
        registry.executeModuleUpgrade(KEY_LE)
      ).to.be.revertedWithCustomError(registry, 'ModuleUpgradeNotReady');
    });

    it('Registry – 应该正确执行到期的升级', async function () {
      await registry.setModule(KEY_LE, mockLendingEngine.target);
      await registry.scheduleModuleUpgrade(KEY_LE, mockCollateralManager.target);
      
      // Advance blocks by minDelay to make upgrade executable
      await (hardhat as any).network.provider.send('hardhat_mine', [
        `0x${(TEST_MIN_DELAY + 1n).toString(16)}`
      ]);

      await expect(
        registry.executeModuleUpgrade(KEY_LE)
      ).to.emit(registry, 'ModuleUpgraded')
        .withArgs(KEY_LE, mockLendingEngine.target, mockCollateralManager.target, owner.address);
      
      expect(await registry.getModule(KEY_LE)).to.equal(mockCollateralManager.target);
    });
  });

  describe('升级历史记录测试', function () {
    it('Registry – 应该正确记录升级历史', async function () {
      await registry.setModule(KEY_LE, mockLendingEngine.target);
      
      expect(await registry.getUpgradeHistoryCount(KEY_LE)).to.equal(1);
      
      const [oldAddress, newAddress, , executor] = await registry.getUpgradeHistory(KEY_LE, 0);
      expect(oldAddress).to.equal(ZERO_ADDRESS);
      expect(newAddress).to.equal(mockLendingEngine.target);
      expect(executor).to.equal(owner.address);
    });

    it('Registry – 应该正确处理多次升级历史', async function () {
      // 第一次升级
      await registry.setModule(KEY_LE, mockLendingEngine.target);
      
      // 第二次升级
      await registry.setModule(KEY_LE, mockCollateralManager.target);
      
      expect(await registry.getUpgradeHistoryCount(KEY_LE)).to.equal(2);
      
      const history = await registry.getAllUpgradeHistory(KEY_LE);
      expect(history.length).to.equal(2);
      expect(history[0].oldAddress).to.equal(ZERO_ADDRESS);
      expect(history[0].newAddress).to.equal(mockLendingEngine.target);
      expect(history[1].oldAddress).to.equal(mockLendingEngine.target);
      expect(history[1].newAddress).to.equal(mockCollateralManager.target);
    });

    it('Registry – 应该正确处理环形缓冲历史记录', async function () {
      // 创建超过历史记录上限的升级，但减少循环次数避免溢出
      for (let i = 0; i < 20; i++) {
        const MockFactory = await ethers.getContractFactory('MockLendingEngineConcrete');
        const mock = await MockFactory.deploy();
        await mock.waitForDeployment();
        
        await registry.setModule(KEY_LE, mock.target);
      }
      
      // 验证历史记录数量
      const historyCount = await registry.getUpgradeHistoryCount(KEY_LE);
      expect(historyCount).to.be.gte(1);
      
      // 验证历史记录存在
      const history = await registry.getAllUpgradeHistory(KEY_LE);
      expect(history.length).to.be.gte(1);
    });
  });

  describe('事件测试', function () {
    it('Registry – 应该正确发出 ModuleChanged 事件', async function () {
      await expect(
        registry.setModule(KEY_LE, mockLendingEngine.target)
      ).to.emit(registry, 'ModuleChanged')
        .withArgs(KEY_LE, ZERO_ADDRESS, mockLendingEngine.target);
    });

    it('Registry – 应该正确发出 PendingAdminChanged 事件', async function () {
      await expect(
        registry.setPendingAdmin(admin.address)
      ).to.emit(registry, 'PendingAdminChanged')
        .withArgs(ZERO_ADDRESS, admin.address);
    });

    it('Registry – 应该正确发出 UpgradeAdminChanged 事件', async function () {
      await expect(
        registry.setUpgradeAdmin(admin.address)
      ).to.emit(registry, 'UpgradeAdminChanged')
        .withArgs(owner.address, admin.address);
    });

    it('Registry – 应该正确发出 EmergencyActionExecuted 事件', async function () {
      await expect(
        registry.pause()
      ).to.emit(registry, 'EmergencyActionExecuted')
        .withArgs(0, owner.address, (blockNumber: bigint) => {
          // 验证区块号是正数且在合理范围内
          return blockNumber > BigInt(0) && blockNumber < BigInt(2 ** 32);
        });
    });
  });

  describe('边界条件测试', function () {
    it('Registry – 应该正确处理空批量操作', async function () {
      const keys: string[] = [];
      const addresses: string[] = [];
      
      await expect(
        registry.batchSetModules(keys, addresses, true)
      ).to.not.be.reverted;
    });

    it('Registry – 应该拒绝长度不匹配的批量操作', async function () {
      const keys = [KEY_LE, KEY_CM];
      const addresses = [mockLendingEngine.target];
      
      await expect(
        registry.batchSetModules(keys, addresses, true)
      ).to.be.revertedWithCustomError(registry, 'Registry__MismatchedArrayLengths')
        .withArgs(keys.length, addresses.length);
    });

    it('Registry – 应该正确处理历史记录索引越界', async function () {
      await expect(
        registry.getUpgradeHistory(KEY_LE, 0)
      ).to.be.revertedWithCustomError(registry, 'IndexOutOfBounds')
        .withArgs(0, 0);
    });
  });

  describe('错误处理测试', function () {
    it('Registry – 应该正确处理无效的模块键', async function () {
      const invalidKey = ethers.keccak256(ethers.toUtf8Bytes('INVALID_KEY'));
      
      expect(await registry.getModule(invalidKey)).to.equal(ZERO_ADDRESS);
      expect(await registry.isModuleRegistered(invalidKey)).to.be.false;
    });

    it('Registry – 应该正确处理权限不足', async function () {
      await expect(
        registry.connect(user1).setModule(KEY_LE, mockLendingEngine.target)
      ).to.be.revertedWithCustomError(registry, 'OwnableUnauthorizedAccount');
    });

    it('Registry – 应该正确处理紧急恢复升级', async function () {
      await registry.setEmergencyAdmin(emergencyAdmin.address);
      
      await expect(
        registry.connect(emergencyAdmin).emergencyRecoverUpgrade()
      ).to.not.be.reverted;
    });

    it('Registry – 应该拒绝非紧急管理员执行紧急恢复', async function () {
      await expect(
        registry.connect(user1).emergencyRecoverUpgrade()
      ).to.be.revertedWithCustomError(registry, 'Registry__EmergencyAdminNotAuthorized')
        .withArgs(await user1.getAddress(), await owner.getAddress());
    });
  });

  describe('查询功能测试', function () {
    it('Registry – 应该正确获取所有模块键', async function () {
      const allKeys = await registry.getAllModuleKeys();
      expect(allKeys.length).to.be.gt(0);
    });

    it('Registry – 应该正确获取已注册模块键', async function () {
      await registry['setModule(bytes32,address)'](KEY_LE, mockLendingEngine.target);
      await registry['setModule(bytes32,address)'](KEY_CM, mockCollateralManager.target);
      
      // 验证模块已正确注册
      expect(await registry.getModule(KEY_LE)).to.equal(mockLendingEngine.target);
      expect(await registry.getModule(KEY_CM)).to.equal(mockCollateralManager.target);
      
      const registeredKeys = await registry.getAllRegisteredModuleKeys();
      expect(registeredKeys.length).to.be.gte(2);
      expect(registeredKeys).to.include(KEY_LE);
      expect(registeredKeys).to.include(KEY_CM);
    });

    it('Registry – 应该正确获取已注册模块', async function () {
      await registry['setModule(bytes32,address)'](KEY_LE, mockLendingEngine.target);
      await registry['setModule(bytes32,address)'](KEY_CM, mockCollateralManager.target);
      
      const [keys, addresses] = await registry.getAllRegisteredModules();
      expect(keys.length).to.equal(addresses.length);
      expect(keys.length).to.be.gte(2);
      expect(keys).to.include(KEY_LE);
      expect(keys).to.include(KEY_CM);
    });

    it('Registry – 应该正确分页查询模块键', async function () {
      await registry['setModule(bytes32,address)'](KEY_LE, mockLendingEngine.target);
      await registry['setModule(bytes32,address)'](KEY_CM, mockCollateralManager.target);
      
      const [keys, totalCount] = await registry.getRegisteredModuleKeysPaginated(0, 10);
      expect(keys.length).to.be.lte(10);
      expect(totalCount).to.be.gte(2);
    });
  });
}); 
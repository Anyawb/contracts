/**
 * LiquidationCollateralManager 动态模块键功能测试
 * 
 * 测试目标:
 * - 动态模块键注册、注销、查询功能验证
 * - 批量动态模块键操作测试
 * - 模块键缓存和刷新功能
 * - 权限控制和访问管理
 * - 错误处理和边界条件
 */

import * as hardhat from 'hardhat';
const { ethers } = hardhat;
import { expect } from 'chai';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

// 导入合约类型
import type { 
  LiquidationCollateralManager,
  MockAccessControlManager,
  RegistryDynamicModuleKey,
  Registry
} from '../../../types';

describe('LiquidationCollateralManager - 动态模块键功能测试', function () {
  // 测试常量定义
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  
  // 角色定义
  const ROLES = {
    UPGRADE_MODULE: ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE')),
    SET_PARAMETER: ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER')),
    PAUSE_SYSTEM: ethers.keccak256(ethers.toUtf8Bytes('PAUSE_SYSTEM')),
    UNPAUSE_SYSTEM: ethers.keccak256(ethers.toUtf8Bytes('UNPAUSE_SYSTEM')),
    VIEW_SYSTEM_DATA: ethers.keccak256(ethers.toUtf8Bytes('VIEW_SYSTEM_DATA')),
  } as const;

  // 模块键定义
  const MODULE_KEYS = {
    ACCESS_CONTROL_MANAGER: ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER')),
    LIQUIDATION_COLLATERAL_MANAGER: ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATION_COLLATERAL_MANAGER')),
    DYNAMIC_MODULE_REGISTRY: ethers.keccak256(ethers.toUtf8Bytes('DYNAMIC_MODULE_REGISTRY')),
  } as const;

  // 合约实例
  let liquidationCollateralManager: LiquidationCollateralManager;
  let registry: Registry;
  let accessControlManager: MockAccessControlManager;
  let dynamicModuleRegistry: RegistryDynamicModuleKey;
  
  // 账户
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let admin: SignerWithAddress;

  /**
   * 标准代理合约部署函数
   */
  async function deployProxyContract(contractName: string, initData: string = '0x') {
    // 1. 部署实现合约
    const ImplementationFactory = await ethers.getContractFactory(contractName);
    const implementation = await ImplementationFactory.deploy();
    await implementation.waitForDeployment();

    // 2. 部署代理合约
    const ProxyFactory = await ethers.getContractFactory('ERC1967Proxy');
    const proxy = await ProxyFactory.deploy(
      implementation.target,
      initData
    );
    await proxy.waitForDeployment();

    // 3. 通过代理访问合约
    const proxyContract = implementation.attach(proxy.target);
    
    return {
      implementation,
      proxy,
      proxyContract
    };
  }

  /**
   * Registry 系统完整部署流程
   */
  async function deployRegistrySystem() {
    // 1. 部署 Registry 实现和代理
    const RegistryFactory = await ethers.getContractFactory('Registry');
    const registryImplementation = await RegistryFactory.deploy();
    await registryImplementation.waitForDeployment();

    const ProxyFactory = await ethers.getContractFactory('ERC1967Proxy');
    const registryProxy = await ProxyFactory.deploy(
      registryImplementation.target,
      '0x'
    );
    await registryProxy.waitForDeployment();

    const registry = registryImplementation.attach(registryProxy.target) as Registry;
    
    // Registry 初始化需要参数
    const minDelay = 86400; // 1 day
    const upgradeAdmin = await owner.getAddress();
    const emergencyAdmin = await owner.getAddress();
    await registry.connect(owner).initialize(minDelay, upgradeAdmin, emergencyAdmin);

    return registry;
  }

  /**
   * 权限设置函数
   */
  async function setupPermissions() {
    const ownerAddress = await owner.getAddress();
    
    // 分配所有必要的权限
    await accessControlManager.grantRole(ROLES.UPGRADE_MODULE, ownerAddress);
    await accessControlManager.grantRole(ROLES.SET_PARAMETER, ownerAddress);
    await accessControlManager.grantRole(ROLES.PAUSE_SYSTEM, ownerAddress);
    await accessControlManager.grantRole(ROLES.UNPAUSE_SYSTEM, ownerAddress);
    await accessControlManager.grantRole(ROLES.VIEW_SYSTEM_DATA, ownerAddress);
    
    // 验证权限设置
    expect(await accessControlManager.hasRole(ROLES.UPGRADE_MODULE, ownerAddress)).to.be.true;
    expect(await accessControlManager.hasRole(ROLES.SET_PARAMETER, ownerAddress)).to.be.true;
    expect(await accessControlManager.hasRole(ROLES.VIEW_SYSTEM_DATA, ownerAddress)).to.be.true;
  }

  /**
   * 部署测试夹具
   */
  async function deployFixture() {
    [owner, user, admin] = await ethers.getSigners();
    
    // 1. 部署 Registry 系统
    registry = await deployRegistrySystem();
    
    // 2. 部署 MockAccessControlManager
    const AccessControlFactory = await ethers.getContractFactory('MockAccessControlManager');
    accessControlManager = await AccessControlFactory.deploy();
    await accessControlManager.waitForDeployment();
    
    // 3. 部署 RegistryDynamicModuleKey
    const { proxyContract: dynamicModuleProxy } = await deployProxyContract('RegistryDynamicModuleKey');
    dynamicModuleRegistry = dynamicModuleProxy as RegistryDynamicModuleKey;
    await dynamicModuleRegistry.initialize(await admin.getAddress(), await admin.getAddress());
    
    // 4. 部署 LiquidationCollateralManager
    const { proxyContract: liquidationProxy } = await deployProxyContract('LiquidationCollateralManager');
    liquidationCollateralManager = liquidationProxy as LiquidationCollateralManager;
    await liquidationCollateralManager.initialize(
      await registry.getAddress(),
      await accessControlManager.getAddress()
    );
    
    // 5. 注册模块到 Registry
    await registry.setModule(
      MODULE_KEYS.ACCESS_CONTROL_MANAGER,
      await accessControlManager.getAddress()
    );
    
    await registry.setModule(
      MODULE_KEYS.DYNAMIC_MODULE_REGISTRY,
      await dynamicModuleRegistry.getAddress()
    );
    
    await registry.setModule(
      MODULE_KEYS.LIQUIDATION_COLLATERAL_MANAGER,
      await liquidationCollateralManager.getAddress()
    );
    
    // 6. 设置权限
    await setupPermissions();
    
    return {
      liquidationCollateralManager,
      registry,
      accessControlManager,
      dynamicModuleRegistry,
      owner,
      user,
      admin
    };
  }

  beforeEach(async function () {
    const fixture = await loadFixture(deployFixture);
    Object.assign(this.currentTest?.ctx || {}, fixture);
  });

  describe('动态模块键注册功能', function () {
    it('应该能够注册单个动态模块键', async function () {
      const moduleKey = ethers.keccak256(ethers.toUtf8Bytes('TEST_MODULE'));
      const moduleName = 'test_module';

      await expect(
        liquidationCollateralManager.registerDynamicModuleKey(moduleKey, moduleName)
      ).to.emit(liquidationCollateralManager, 'DynamicModuleKeyRegistered')
        .withArgs(moduleKey, moduleName, await owner.getAddress(), (timestamp: unknown) => {
          return typeof timestamp === 'bigint' && timestamp > BigInt(0);
        });

      // 验证模块键已注册
      expect(await liquidationCollateralManager.isDynamicModuleKeyRegistered(moduleKey)).to.be.true;
    });

    it('应该能够批量注册动态模块键', async function () {
      const moduleNames = ['module1', 'module2', 'module3'];

      const tx = await liquidationCollateralManager.batchRegisterDynamicModuleKeys(moduleNames);
      const receipt = await tx.wait();
      
      // 审查批量注册是否成功
      expect(receipt).to.not.be.null;
      
      // 验证模块键数量
      const allDynamicKeys = await liquidationCollateralManager.getAllDynamicModuleKeys();
      expect(allDynamicKeys.length).to.be.greaterThan(0);
    });

    it('应该拒绝重复注册相同的模块键', async function () {
      const moduleKey = ethers.keccak256(ethers.toUtf8Bytes('DUPLICATE_MODULE'));
      const moduleName = 'duplicate_module';

      // 第一次注册应该成功
      await liquidationCollateralManager.registerDynamicModuleKey(moduleKey, moduleName);

      // 第二次注册应该失败
      await expect(
        liquidationCollateralManager.registerDynamicModuleKey(moduleKey, moduleName)
      ).to.be.reverted;
    });
  });

  describe('动态模块键查询功能', function () {
    beforeEach(async function () {
      // 注册一些测试模块键
      const moduleNames = ['query_test1', 'query_test2', 'query_test3'];
      await liquidationCollateralManager.batchRegisterDynamicModuleKeys(moduleNames);
    });

    it('应该能够获取所有动态模块键', async function () {
      const dynamicKeys = await liquidationCollateralManager.getAllDynamicModuleKeys();
      expect(dynamicKeys.length).to.be.greaterThan(0);
    });

    it('应该能够获取所有模块键（包括静态和动态）', async function () {
      const allKeys = await liquidationCollateralManager.getAllModuleKeys();
      expect(allKeys.length).to.be.greaterThan(0);
    });

    it('应该能够检查模块键是否为动态模块键', async function () {
      const dynamicKeys = await liquidationCollateralManager.getAllDynamicModuleKeys();
      if (dynamicKeys.length > 0) {
        const isDynamic = await liquidationCollateralManager.isDynamicModuleKey(dynamicKeys[0]);
        expect(isDynamic).to.be.true;
      }
    });

    it('应该能够检查模块键是否有效', async function () {
      const dynamicKeys = await liquidationCollateralManager.getAllDynamicModuleKeys();
      if (dynamicKeys.length > 0) {
        const isValid = await liquidationCollateralManager.isValidModuleKey(dynamicKeys[0]);
        expect(isValid).to.be.true;
      }
    });

    it('应该能够根据名称获取模块键', async function () {
      const moduleName = 'name_test';
      await liquidationCollateralManager.batchRegisterDynamicModuleKeys([moduleName]);
      
      const retrievedKey = await liquidationCollateralManager.getModuleKeyByName(moduleName);
      expect(retrievedKey).to.not.equal(ethers.ZeroHash);
    });

    it('应该能够获取模块键总数', async function () {
      const totalCount = await liquidationCollateralManager.getTotalModuleKeyCount();
      expect(totalCount).to.be.greaterThan(BigInt(0));
    });
  });

  describe('动态模块键注销功能', function () {
    let registeredModuleKey: string;

    beforeEach(async function () {
      // 注册一个测试模块键
      const moduleNames = ['unregister_test'];
      await liquidationCollateralManager.batchRegisterDynamicModuleKeys(moduleNames);
      const allKeys = await liquidationCollateralManager.getAllDynamicModuleKeys();
      registeredModuleKey = allKeys[allKeys.length - 1]; // 使用最后一个注册的键
    });

    it('应该能够注销动态模块键', async function () {
      await expect(
        liquidationCollateralManager.unregisterDynamicModuleKey(registeredModuleKey)
      ).to.emit(liquidationCollateralManager, 'DynamicModuleKeyUnregistered')
        .withArgs(registeredModuleKey, '', await owner.getAddress(), (timestamp: unknown) => {
          return typeof timestamp === 'bigint' && timestamp > BigInt(0);
        });

      // 验证模块键已注销
      expect(await liquidationCollateralManager.isDynamicModuleKeyRegistered(registeredModuleKey)).to.be.false;
    });

    it('应该拒绝注销不存在的模块键', async function () {
      const nonExistentKey = ethers.keccak256(ethers.toUtf8Bytes('NON_EXISTENT'));

      await expect(
        liquidationCollateralManager.unregisterDynamicModuleKey(nonExistentKey)
      ).to.be.reverted;
    });
  });

  describe('动态模块键缓存功能', function () {
    it('应该能够刷新动态模块键缓存', async function () {
      const moduleNames = ['cache_test1', 'cache_test2'];
      await liquidationCollateralManager.batchRegisterDynamicModuleKeys(moduleNames);

      // 获取已注册的模块键
      const allKeys = await liquidationCollateralManager.getAllDynamicModuleKeys();
      
      // 刷新缓存
      await liquidationCollateralManager.refreshDynamicModuleKeyCache(allKeys);

      // 验证缓存已更新
      for (const moduleKey of allKeys) {
        expect(await liquidationCollateralManager.isDynamicModuleKeyRegistered(moduleKey)).to.be.true;
      }
    });

    it('应该能够清理过期的动态模块键缓存', async function () {
      // 这个功能主要是为了接口完整性，实际实现可能有限制
      await expect(
        liquidationCollateralManager.clearExpiredDynamicModuleKeyCache()
      ).to.not.be.reverted;
    });
  });

  describe('权限控制', function () {
    it('应该拒绝非授权用户注册动态模块键', async function () {
      const moduleKey = ethers.keccak256(ethers.toUtf8Bytes('UNAUTHORIZED_MODULE'));
      const moduleName = 'unauthorized_module';

      await expect(
        liquidationCollateralManager.connect(user).registerDynamicModuleKey(moduleKey, moduleName)
      ).to.be.reverted;
    });

    it('应该拒绝非授权用户注销动态模块键', async function () {
      // 先注册一个模块键
      const moduleNames = ['auth_test'];
      await liquidationCollateralManager.batchRegisterDynamicModuleKeys(moduleNames);
      const allKeys = await liquidationCollateralManager.getAllDynamicModuleKeys();

      // 尝试用非授权用户注销
      await expect(
        liquidationCollateralManager.connect(user).unregisterDynamicModuleKey(allKeys[0])
      ).to.be.reverted;
    });

    it('应该拒绝非授权用户刷新缓存', async function () {
      const moduleKeys = [ethers.keccak256(ethers.toUtf8Bytes('CACHE_TEST'))];

      await expect(
        liquidationCollateralManager.connect(user).refreshDynamicModuleKeyCache(moduleKeys)
      ).to.be.reverted;
    });
  });

  describe('错误处理', function () {
    it('应该拒绝注册零地址模块键', async function () {
      const moduleName = 'zero_key_test';

      await expect(
        liquidationCollateralManager.registerDynamicModuleKey(ethers.ZeroHash, moduleName)
      ).to.be.reverted;
    });

    it('应该拒绝注册空名称的模块键', async function () {
      const moduleKey = ethers.keccak256(ethers.toUtf8Bytes('EMPTY_NAME'));

      await expect(
        liquidationCollateralManager.registerDynamicModuleKey(moduleKey, '')
      ).to.be.reverted;
    });

    it('应该拒绝批量注册空数组', async function () {
      await expect(
        liquidationCollateralManager.batchRegisterDynamicModuleKeys([])
      ).to.be.reverted;
    });
  });
});
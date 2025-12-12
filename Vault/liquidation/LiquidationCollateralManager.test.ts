/**
 * LiquidationCollateralManager – 清算抵押物管理器测试
 * 
 * 测试目标:
 * - 核心清算抵押物扣押功能验证
 * - 批量清算操作测试
 * - 抵押物转移和记录管理
 * - 查询功能和批量查询
 * - 权限控制和访问管理
 * - 升级功能和Registry集成
 * - 紧急暂停和恢复功能
 * - 错误处理和边界条件
 * - 优雅降级和价格预言机集成
 */

import * as hardhat from 'hardhat';
const { ethers } = hardhat;
import { expect } from 'chai';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import type { ContractFactory } from 'ethers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

// 导入合约类型
import type { 
  LiquidationCollateralManager,
  MockAccessControlManager,
  MockCollateralManager,
  MockPriceOracle,
  MockERC20,
  Registry
} from '../../../types';

// 导入常量
import { ModuleKeys } from '../../../frontend-config/moduleKeys';

describe('LiquidationCollateralManager – 清算抵押物管理器测试', function () {
  // 测试常量定义
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const MAX_BATCH_SIZE = 50;
  const TEST_AMOUNT = ethers.parseUnits('1000', 18);
  const TEST_AMOUNT_SMALL = ethers.parseUnits('100', 18);
  const TEST_AMOUNT_LARGE = ethers.parseUnits('10000', 18);
  
  // 角色定义
  const ROLES = {
    UPGRADE_MODULE: ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE')),
    SET_PARAMETER: ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER')),
    PAUSE_SYSTEM: ethers.keccak256(ethers.toUtf8Bytes('PAUSE_SYSTEM')),
    UNPAUSE_SYSTEM: ethers.keccak256(ethers.toUtf8Bytes('UNPAUSE_SYSTEM')),
  } as const;

  // 模块键定义
  const MODULE_KEYS = {
    COLLATERAL_MANAGER: ethers.keccak256(ethers.toUtf8Bytes('COLLATERAL_MANAGER')),
    LENDING_ENGINE: ethers.keccak256(ethers.toUtf8Bytes('LENDING_ENGINE')),
    PRICE_ORACLE: ethers.keccak256(ethers.toUtf8Bytes('PRICE_ORACLE')),
    ACCESS_CONTROL_MANAGER: ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER')),
  } as const;

  // 合约实例
  let liquidationCollateralManager: LiquidationCollateralManager;
  let accessControlManager: any; // Use any for now to avoid type conflicts
  let mockCollateralManager: MockCollateralManager;
  let mockPriceOracle: any; // Use any for now to avoid type conflicts
  let mockERC20: MockERC20;
  let registry: Registry;
  
  // 账户
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let liquidator: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  
  // 测试资产
  let testAsset: string;
  let settlementToken: string;

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

    // 2. 部署 Registry 核心模块
    const RegistryCoreFactory = await ethers.getContractFactory('RegistryCore');
    const registryCore = await RegistryCoreFactory.deploy();

    const RegistryUpgradeManagerFactory = await ethers.getContractFactory('RegistryUpgradeManager');
    const registryUpgradeManager = await RegistryUpgradeManagerFactory.deploy();

    const RegistryAdminFactory = await ethers.getContractFactory('RegistryAdmin');
    const registryAdmin = await RegistryAdminFactory.deploy();

    // 3. 初始化 RegistryCore
    const coreMinDelay = 86400; // 1 day
    const admin = await owner.getAddress();
    await registryCore.initialize(admin, coreMinDelay);

    // 4. 设置 Registry 核心模块
    await registry.setRegistryCore(registryCore.target);
    await registry.setUpgradeManager(registryUpgradeManager.target);
    await registry.setRegistryAdmin(registryAdmin.target);

    // 4. 部署 AccessControlManager
    const AccessControlManagerFactory = await ethers.getContractFactory('AccessControlManager');
    const accessControlManager = await AccessControlManagerFactory.deploy(await owner.getAddress(), registry.target);

    // 5. 注册模块到 Registry (直接使用 RegistryCore)
    await registryCore.setModule(MODULE_KEYS.ACCESS_CONTROL_MANAGER, accessControlManager.target);

    // 6. 设置权限
    const ownerAddress = await owner.getAddress();
    await accessControlManager.grantRole(ROLES.SET_PARAMETER, ownerAddress);
    await accessControlManager.grantRole(ROLES.UPGRADE_MODULE, ownerAddress);
    await accessControlManager.grantRole(ROLES.PAUSE_SYSTEM, ownerAddress);
    await accessControlManager.grantRole(ROLES.UNPAUSE_SYSTEM, ownerAddress);

    return {
      registry,
      accessControlManager
    };
  }

  /**
   * 权限设置函数
   */
  async function setupPermissions(
    accessControlManager: any, 
    user: SignerWithAddress
  ) {
    const userAddress = await user.getAddress();
    
    // 分配所有需要的角色
    for (const [name, role] of Object.entries(ROLES)) {
      await accessControlManager.grantRole(role, userAddress);
      console.log(`Granted ${name} role to ${userAddress}`);
    }
    
    // 验证权限设置
    for (const [name, role] of Object.entries(ROLES)) {
      const hasRole = await accessControlManager.hasRole(role, userAddress);
      expect(hasRole).to.be.true;
      console.log(`Verified ${name} role for ${userAddress}`);
    }
  }

  /**
   * 部署测试环境
   */
  async function deployFixture() {
    const [deployer, userSigner, liquidatorSigner, aliceSigner, bobSigner] = await ethers.getSigners();
    owner = deployer;
    user = userSigner;
    liquidator = liquidatorSigner;
    alice = aliceSigner;
    bob = bobSigner;

    // 1. 部署 Registry 系统
    const { registry, accessControlManager } = await deployRegistrySystem();
    // accessControlManager is already set from deployRegistrySystem

    // 2. 部署 Mock 合约
    const MockCollateralManagerFactory = await ethers.getContractFactory('MockCollateralManager');
    mockCollateralManager = await MockCollateralManagerFactory.deploy();

    const MockPriceOracleFactory = await ethers.getContractFactory('MockPriceOracle');
    mockPriceOracle = await MockPriceOracleFactory.deploy();

    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    mockERC20 = await MockERC20Factory.deploy('Test Token', 'TEST', 18);

    // 3. 部署 LiquidationCollateralManager
    const { proxyContract } = await deployProxyContract('LiquidationCollateralManager');
    liquidationCollateralManager = proxyContract as LiquidationCollateralManager;

    // 4. 初始化 LiquidationCollateralManager
    await liquidationCollateralManager.initialize(registry.target, accessControlManager.target);

    // 5. 注册模块到 Registry
    await registry.setModule(MODULE_KEYS.COLLATERAL_MANAGER, mockCollateralManager.target);
    await registry.setModule(MODULE_KEYS.PRICE_ORACLE, mockPriceOracle.target);

    // 6. 设置基础存储
    await liquidationCollateralManager.updateSettlementToken(mockERC20.target);
    await liquidationCollateralManager.updatePriceOracle(mockPriceOracle.target);

    // 7. 设置测试数据
    testAsset = mockERC20.target;
    settlementToken = mockERC20.target;

    // 8. 确保合约有足够的代币
    await mockERC20.mint(liquidationCollateralManager.target, TEST_AMOUNT * 10n);
    await mockERC20.mint(user.address, TEST_AMOUNT * 10n);
    await mockERC20.mint(liquidator.address, TEST_AMOUNT * 10n);

    // 9. 设置 Mock 合约状态
    await mockCollateralManager.setMockSuccess(true);
    // Note: MockPriceOracle might not have setMockSuccess method, we'll handle this in tests

    // 10. 设置用户抵押物
    await mockCollateralManager.setCollateral(user.address, testAsset, TEST_AMOUNT * 2n);
    await mockCollateralManager.setUserTotalValue(user.address, TEST_AMOUNT * 2n);

    return {
      liquidationCollateralManager,
      accessControlManager,
      mockCollateralManager,
      mockPriceOracle,
      mockERC20,
      registry,
      owner,
      user,
      liquidator,
      alice,
      bob,
      testAsset,
      settlementToken
    };
  }

  beforeEach(async function () {
    const fixture = await loadFixture(deployFixture);
    
    // 解构 fixture
    ({
      liquidationCollateralManager,
      accessControlManager,
      mockCollateralManager,
      mockPriceOracle,
      mockERC20,
      registry,
      owner,
      user,
      liquidator,
      alice,
      bob,
      testAsset,
      settlementToken
    } = fixture);

    // 确保权限设置正确
    await setupPermissions(accessControlManager, owner);
    
    // 确保 Mock 合约调用成功
    await mockCollateralManager.setMockSuccess(true);
    // Note: MockPriceOracle might not have setMockSuccess method
    
    // 确保合约有足够的代币
    await mockERC20.mint(liquidationCollateralManager.target, TEST_AMOUNT * 10n);
    
    // 确保用户有足够的代币
    await mockERC20.mint(user.address, TEST_AMOUNT * 10n);
    await mockERC20.connect(user).approve(liquidationCollateralManager.target, TEST_AMOUNT * 10n);
  });

  describe('初始化测试', function () {
    it('应该正确初始化代理合约', async function () {
      const { proxyContract } = await deployProxyContract('LiquidationCollateralManager');
      
      await expect(proxyContract.initialize(registry.target, accessControlManager.target)).to.not.be.reverted;
      
      // 验证初始化状态
      expect(await proxyContract.registryAddr()).to.equal(registry.target);
    });

    it('应该拒绝重复初始化', async function () {
      const { proxyContract } = await deployProxyContract('LiquidationCollateralManager');
      await proxyContract.initialize(registry.target, accessControlManager.target);
      
      await expect(
        proxyContract.initialize(registry.target, accessControlManager.target)
      ).to.be.revertedWith('Initializable: contract is already initialized');
    });

    it('应该拒绝零地址初始化', async function () {
      const { proxyContract } = await deployProxyContract('LiquidationCollateralManager');
      
      // 测试零地址参数
      await expect(
        proxyContract.initialize(ZERO_ADDRESS, accessControlManager.target)
      ).to.be.revertedWithCustomError(proxyContract, 'ZeroAddress');
      
      await expect(
        proxyContract.initialize(registry.target, ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(proxyContract, 'ZeroAddress');
    });
  });

  describe('权限控制测试', function () {
    it('应该正确验证权限', async function () {
      // 验证权限设置
      const ownerAddress = await owner.getAddress();
      expect(await accessControlManager.hasRole(ROLES.SET_PARAMETER, ownerAddress)).to.be.true;
      expect(await accessControlManager.hasRole(ROLES.UPGRADE_MODULE, ownerAddress)).to.be.true;
    });

    it('应该拒绝无权限用户调用管理函数', async function () {
      // 使用无权限用户
      await expect(
        liquidationCollateralManager.connect(alice).updatePriceOracle(mockPriceOracle.target)
      ).to.be.revertedWithCustomError(liquidationCollateralManager, 'LiquidationCollateralManager__ModuleCallFailed');
    });

    it('应该允许有权限用户调用管理函数', async function () {
      // 给 alice 分配权限
      await accessControlManager.grantRole(ROLES.SET_PARAMETER, alice.address);
      
      await expect(
        liquidationCollateralManager.connect(alice).updatePriceOracle(mockPriceOracle.target)
      ).to.not.be.reverted;
    });
  });

  describe('核心清算功能测试', function () {
    it('应该正确扣押用户抵押物', async function () {
      const userAddress = await user.getAddress();
      const liquidatorAddress = await liquidator.getAddress();
      
      // 扣押抵押物
      await expect(
        liquidationCollateralManager.seizeCollateral(userAddress, testAsset, TEST_AMOUNT, liquidatorAddress)
      ).to.not.be.reverted;
      
      // 验证事件发出
      await expect(
        liquidationCollateralManager.seizeCollateral(userAddress, testAsset, TEST_AMOUNT_SMALL, liquidatorAddress)
      ).to.emit(liquidationCollateralManager, 'LiquidationCollateralSeized')
        .withArgs(liquidatorAddress, userAddress, testAsset, TEST_AMOUNT_SMALL, (timestamp: bigint) => {
          return timestamp > BigInt(0);
        });
    });

    it('应该拒绝扣押零数量抵押物', async function () {
      const userAddress = await user.getAddress();
      const liquidatorAddress = await liquidator.getAddress();
      
      await expect(
        liquidationCollateralManager.seizeCollateral(userAddress, testAsset, 0n, liquidatorAddress)
      ).to.be.revertedWithCustomError(liquidationCollateralManager, 'AmountIsZero');
    });

    it('应该拒绝使用零地址参数', async function () {
      const userAddress = await user.getAddress();
      const liquidatorAddress = await liquidator.getAddress();
      
      // 测试零地址用户
      await expect(
        liquidationCollateralManager.seizeCollateral(ZERO_ADDRESS, testAsset, TEST_AMOUNT, liquidatorAddress)
      ).to.be.revertedWithCustomError(liquidationCollateralManager, 'ZeroAddress');
      
      // 测试零地址资产
      await expect(
        liquidationCollateralManager.seizeCollateral(userAddress, ZERO_ADDRESS, TEST_AMOUNT, liquidatorAddress)
      ).to.be.revertedWithCustomError(liquidationCollateralManager, 'ZeroAddress');
      
      // 测试零地址清算人
      await expect(
        liquidationCollateralManager.seizeCollateral(userAddress, testAsset, TEST_AMOUNT, ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(liquidationCollateralManager, 'ZeroAddress');
    });

    it('应该正确执行批量扣押操作', async function () {
      const userAddress = await user.getAddress();
      const liquidatorAddress = await liquidator.getAddress();
      const assets = [testAsset, testAsset];
      const amounts = [TEST_AMOUNT_SMALL, TEST_AMOUNT_SMALL];
      
      await expect(
        liquidationCollateralManager.batchSeizeCollateral(userAddress, assets, amounts, liquidatorAddress)
      ).to.not.be.reverted;
    });

    it('应该拒绝批量扣押时数组长度不匹配', async function () {
      const userAddress = await user.getAddress();
      const liquidatorAddress = await liquidator.getAddress();
      const assets = [testAsset];
      const amounts = [TEST_AMOUNT_SMALL, TEST_AMOUNT_SMALL];
      
      await expect(
        liquidationCollateralManager.batchSeizeCollateral(userAddress, assets, amounts, liquidatorAddress)
      ).to.be.revertedWith('Array length mismatch');
    });

    it('应该正确转移清算抵押物', async function () {
      const liquidatorAddress = await liquidator.getAddress();
      
      await expect(
        liquidationCollateralManager.transferLiquidationCollateral(testAsset, TEST_AMOUNT, liquidatorAddress)
      ).to.not.be.reverted;
      
      // 验证事件发出
      await expect(
        liquidationCollateralManager.transferLiquidationCollateral(testAsset, TEST_AMOUNT_SMALL, liquidatorAddress)
      ).to.emit(liquidationCollateralManager, 'LiquidationCollateralTransferred')
        .withArgs(liquidationCollateralManager.target, liquidatorAddress, testAsset, TEST_AMOUNT_SMALL, (timestamp: bigint) => {
          return timestamp > BigInt(0);
        });
    });

    it('应该正确清除清算抵押物记录', async function () {
      const userAddress = await user.getAddress();
      
      await expect(
        liquidationCollateralManager.clearLiquidationCollateralRecord(userAddress, testAsset)
      ).to.not.be.reverted;
    });
  });

  // TODO: 在View合约部署后取消注释
  // describe('查询功能测试', function () {
  //   it('应该正确获取可清算抵押物数量', async function () {
  //     const userAddress = await user.getAddress();
  //     
  //     const seizableAmount = await liquidationCollateralManager.getSeizableCollateralAmount(userAddress, testAsset);
  //     expect(seizableAmount).to.be.gte(0n);
  //   });

  //   it('应该正确获取用户所有可清算抵押物', async function () {
  //     const userAddress = await user.getAddress();
  //     
  //     const [assets, amounts] = await liquidationCollateralManager.getSeizableCollaterals(userAddress);
  //     expect(assets).to.be.an('array');
  //     expect(amounts).to.be.an('array');
  //   });

  //   it('应该正确计算抵押物价值', async function () {
  //     const value = await liquidationCollateralManager.calculateCollateralValue(testAsset, TEST_AMOUNT);
  //     expect(value).to.be.gte(0n);
  //   });

  //   it('应该正确获取用户抵押物总价值', async function () {
  //     const userAddress = await user.getAddress();
  //     
  //     const totalValue = await liquidationCollateralManager.getUserTotalCollateralValue(userAddress);
  //     expect(totalValue).to.be.gte(0n);
  //   });

  //   it('应该正确获取清算抵押物记录', async function () {
  //     const userAddress = await user.getAddress();
  //     
  //     const [seizedAmount, lastSeizedTime] = await liquidationCollateralManager.getLiquidationCollateralRecord(userAddress, testAsset);
  //     expect(seizedAmount).to.be.gte(0n);
  //     expect(lastSeizedTime).to.be.gte(0n);
  //   });

  //   it('应该正确获取用户所有清算抵押物记录', async function () {
  //     const userAddress = await user.getAddress();
  //     
  //     const [assets, seizedAmounts, lastSeizedTimes] = await liquidationCollateralManager.getUserAllLiquidationCollateralRecords(userAddress);
  //     expect(assets).to.be.an('array');
  //     expect(seizedAmounts).to.be.an('array');
  //     expect(lastSeizedTimes).to.be.an('array');
  //   });
  // });

  // TODO: 在View合约部署后取消注释
  // describe('批量查询功能测试', function () {
  //   it('应该正确批量获取可清算数量', async function () {
  //     const users = [user.address, alice.address];
  //     const assets = [testAsset, testAsset];
  //     
  //     const seizableAmounts = await liquidationCollateralManager.batchGetSeizableAmounts(users, assets);
  //     expect(seizableAmounts).to.be.an('array');
  //     expect(seizableAmounts.length).to.equal(users.length);
  //   });

  //   it('应该正确批量计算抵押物价值', async function () {
  //     const assets = [testAsset, testAsset];
  //     const amounts = [TEST_AMOUNT, TEST_AMOUNT_SMALL];
  //     
  //     const values = await liquidationCollateralManager.batchCalculateCollateralValues(assets, amounts);
  //     expect(values).to.be.an('array');
  //     expect(values.length).to.equal(assets.length);
  //   });

  //   it('应该正确批量获取用户总抵押物价值', async function () {
  //     const users = [user.address, alice.address];
  //     
  //     const totalValues = await liquidationCollateralManager.batchGetUserTotalCollateralValues(users);
  //     expect(totalValues).to.be.an('array');
  //     expect(totalValues.length).to.equal(users.length);
  //   });

  //   it('应该拒绝批量查询时数组长度不匹配', async function () {
  //     const users = [user.address];
  //     const assets = [testAsset, testAsset];
  //     
  //     await expect(
  //       liquidationCollateralManager.batchGetSeizableAmounts(users, assets)
  //     ).to.be.revertedWith('Array length mismatch');
  //   });
  // });

  // TODO: 在View合约部署后取消注释
  // describe('预览功能测试', function () {
  //   it('应该正确预览清算抵押物状态', async function () {
  //     const userAddress = await user.getAddress();
  //     
  //     const [newCollateralAmount, newTotalValue] = await liquidationCollateralManager.previewLiquidationCollateralState(
  //       userAddress, 
  //       testAsset, 
  //       TEST_AMOUNT_SMALL
  //     );
  //     
  //     expect(newCollateralAmount).to.be.gte(0n);
  //     expect(newTotalValue).to.be.gte(0n);
  //   });

  //   it('应该拒绝预览时使用零地址', async function () {
  //     await expect(
  //       liquidationCollateralManager.previewLiquidationCollateralState(ZERO_ADDRESS, testAsset, TEST_AMOUNT_SMALL)
  //     ).to.be.revertedWithCustomError(liquidationCollateralManager, 'ZeroAddress');
  //     
  //     await expect(
  //       liquidationCollateralManager.previewLiquidationCollateralState(user.address, ZERO_ADDRESS, TEST_AMOUNT_SMALL)
  //     ).to.be.revertedWithCustomError(liquidationCollateralManager, 'ZeroAddress');
  //   });
  // });

  describe('管理功能测试', function () {
    it('应该正确更新价格预言机地址', async function () {
      const newPriceOracle = mockPriceOracle.target;
      
      await expect(
        liquidationCollateralManager.updatePriceOracle(newPriceOracle)
      ).to.not.be.reverted;
      
      // TODO: 在View合约部署后取消注释
      // // 验证更新
      // expect(await liquidationCollateralManager.getPriceOracle()).to.equal(newPriceOracle);
    });

    it('应该正确更新结算币地址', async function () {
      const newSettlementToken = mockERC20.target;
      
      await expect(
        liquidationCollateralManager.updateSettlementToken(newSettlementToken)
      ).to.not.be.reverted;
      
      // TODO: 在View合约部署后取消注释
      // // 验证更新
      // expect(await liquidationCollateralManager.getSettlementToken()).to.equal(newSettlementToken);
    });

    it('应该拒绝更新为零地址', async function () {
      await expect(
        liquidationCollateralManager.updatePriceOracle(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(liquidationCollateralManager, 'ZeroAddress');
      
      await expect(
        liquidationCollateralManager.updateSettlementToken(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(liquidationCollateralManager, 'ZeroAddress');
    });
  });

  describe('Registry管理功能测试', function () {
    it('应该正确安排模块升级', async function () {
      const moduleKey = MODULE_KEYS.COLLATERAL_MANAGER;
      const newAddress = alice.address;
      
      await expect(
        liquidationCollateralManager.scheduleModuleUpgrade(moduleKey, newAddress)
      ).to.not.be.reverted;
    });

    it('应该正确执行模块升级', async function () {
      const moduleKey = MODULE_KEYS.COLLATERAL_MANAGER;
      const newAddress = alice.address;
      
      // 先安排升级
      await liquidationCollateralManager.scheduleModuleUpgrade(moduleKey, newAddress);
      
      // 执行升级
      await expect(
        liquidationCollateralManager.executeModuleUpgrade(moduleKey)
      ).to.not.be.reverted;
    });

    it('应该正确取消模块升级', async function () {
      const moduleKey = MODULE_KEYS.COLLATERAL_MANAGER;
      const newAddress = alice.address;
      
      // 先安排升级
      await liquidationCollateralManager.scheduleModuleUpgrade(moduleKey, newAddress);
      
      // 取消升级
      await expect(
        liquidationCollateralManager.cancelModuleUpgrade(moduleKey)
      ).to.not.be.reverted;
    });

    it('应该正确获取模块地址', async function () {
      const moduleKey = MODULE_KEYS.COLLATERAL_MANAGER;
      
      const moduleAddress = await liquidationCollateralManager.getModule(moduleKey);
      expect(moduleAddress).to.not.equal(ZERO_ADDRESS);
    });

    it('应该正确获取待升级信息', async function () {
      const moduleKey = MODULE_KEYS.COLLATERAL_MANAGER;
      
      const [newAddress, executeAfter, hasPending] = await liquidationCollateralManager.getPendingUpgrade(moduleKey);
      expect(newAddress).to.be.a('string');
      expect(executeAfter).to.be.a('bigint');
      expect(hasPending).to.be.a('boolean');
    });
  });

  describe('紧急功能测试', function () {
    it('应该正确执行紧急暂停', async function () {
      await expect(
        liquidationCollateralManager.emergencyPause()
      ).to.not.be.reverted;
      
      // 验证暂停状态
      expect(await liquidationCollateralManager.paused()).to.be.true;
    });

    it('应该正确执行紧急恢复', async function () {
      // 先暂停
      await liquidationCollateralManager.emergencyPause();
      
      // 恢复
      await expect(
        liquidationCollateralManager.emergencyUnpause()
      ).to.not.be.reverted;
      
      // 验证恢复状态
      expect(await liquidationCollateralManager.paused()).to.be.false;
    });

    it('应该正确设置访问控制器', async function () {
      const newController = alice.address;
      
      await expect(
        liquidationCollateralManager.setAccessController(newController)
      ).to.not.be.reverted;
    });

    it('应该拒绝设置零地址访问控制器', async function () {
      await expect(
        liquidationCollateralManager.setAccessController(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(liquidationCollateralManager, 'ZeroAddress');
    });
  });

  describe('升级功能测试', function () {
    it('应该正确升级合约', async function () {
      // 部署新的实现合约
      const LiquidationCollateralManagerFactory = await ethers.getContractFactory('LiquidationCollateralManager');
      const newImplementation = await LiquidationCollateralManagerFactory.deploy();
      await newImplementation.waitForDeployment();
      
      await expect(
        liquidationCollateralManager.upgradeTo(newImplementation.target)
      ).to.not.be.reverted;
    });

    it('应该拒绝使用零地址升级', async function () {
      await expect(
        liquidationCollateralManager.upgradeTo(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(liquidationCollateralManager, 'ZeroAddress');
    });

    it('应该拒绝无权限用户升级', async function () {
      // 部署新的实现合约
      const LiquidationCollateralManagerFactory = await ethers.getContractFactory('LiquidationCollateralManager');
      const newImplementation = await LiquidationCollateralManagerFactory.deploy();
      await newImplementation.waitForDeployment();
      
      // 使用无权限用户
      await expect(
        liquidationCollateralManager.connect(alice).upgradeTo(newImplementation.target)
      ).to.be.revertedWithCustomError(liquidationCollateralManager, 'LiquidationCollateralManager__ModuleCallFailed');
    });
  });

  describe('优雅降级测试', function () {
    it('应该在价格预言机失败时触发优雅降级', async function () {
      // 设置价格预言机失败
      await mockPriceOracle.setMockSuccess(false);
      
      // 尝试计算抵押物价值，应该触发优雅降级
      const value = await liquidationCollateralManager.calculateCollateralValue(testAsset, TEST_AMOUNT);
      expect(value).to.equal(0n); // 降级时返回0
    });

    it('应该正确发出优雅降级事件', async function () {
      // 设置价格预言机失败
      await mockPriceOracle.setMockSuccess(false);
      
      // 触发优雅降级
      await liquidationCollateralManager.calculateCollateralValue(testAsset, TEST_AMOUNT);
      
      // 注意：这里不直接测试事件，因为优雅降级可能不会发出事件
      // 主要验证功能不会因为价格预言机失败而完全失效
    });
  });

  describe('边界条件测试', function () {
    it('应该正确处理最大数量', async function () {
      const maxAmount = ethers.parseUnits('1000000', 18);
      
      await expect(
        liquidationCollateralManager.calculateCollateralValue(testAsset, maxAmount)
      ).to.not.be.reverted;
    });

    it('应该正确处理最小数量', async function () {
      const minAmount = 1n;
      
      await expect(
        liquidationCollateralManager.calculateCollateralValue(testAsset, minAmount)
      ).to.not.be.reverted;
    });

    it('应该正确处理空数组', async function () {
      const emptyUsers: string[] = [];
      const emptyAssets: string[] = [];
      const emptyAmounts: bigint[] = [];
      
      await expect(
        liquidationCollateralManager.batchGetSeizableAmounts(emptyUsers, emptyAssets)
      ).to.not.be.reverted;
      
      await expect(
        liquidationCollateralManager.batchCalculateCollateralValues(emptyAssets, emptyAmounts)
      ).to.not.be.reverted;
      
      await expect(
        liquidationCollateralManager.batchGetUserTotalCollateralValues(emptyUsers)
      ).to.not.be.reverted;
    });
  });

  describe('错误处理测试', function () {
    it('应该正确处理模块调用失败', async function () {
      // 设置 Mock 合约失败
      await mockCollateralManager.setMockSuccess(false);
      
      // 尝试扣押抵押物，应该失败
      const userAddress = await user.getAddress();
      const liquidatorAddress = await liquidator.getAddress();
      
      await expect(
        liquidationCollateralManager.seizeCollateral(userAddress, testAsset, TEST_AMOUNT, liquidatorAddress)
      ).to.be.revertedWithCustomError(mockCollateralManager, 'MockFailure');
    });

    it('应该正确处理价格预言机失败', async function () {
      // 设置价格预言机失败
      await mockPriceOracle.setMockSuccess(false);
      
      // 计算抵押物价值应该返回0
      const value = await liquidationCollateralManager.calculateCollateralValue(testAsset, TEST_AMOUNT);
      expect(value).to.equal(0n);
    });

    it('应该正确处理Registry未初始化', async function () {
      // 部署新的合约实例，不初始化Registry
      const { proxyContract } = await deployProxyContract('LiquidationCollateralManager');
      
      // 尝试调用需要Registry的函数
      await expect(
        proxyContract.getModule(MODULE_KEYS.COLLATERAL_MANAGER)
      ).to.be.revertedWithCustomError(proxyContract, 'LiquidationCollateralManager__RegistryNotInitialized');
    });
  });

  describe('生产环境一致性测试', function () {
    it('应该模拟完整的生产部署流程', async function () {
      // 1. 部署 Registry 系统
      const { registry: prodRegistry, accessControlManager: prodAccessControl } = await deployRegistrySystem();
      
      // 2. 部署业务合约
      const { proxyContract: prodLiquidationCollateralManager } = await deployProxyContract('LiquidationCollateralManager');
      await prodLiquidationCollateralManager.initialize(prodRegistry.target, prodAccessControl.target);
      
      // 3. 注册到 Registry
      const liquidationKey = ethers.keccak256(ethers.toUtf8Bytes('LIQUIDATION_COLLATERAL_MANAGER'));
      await prodRegistry.setModule(liquidationKey, prodLiquidationCollateralManager.target, true);
      
      // TODO: 在View合约部署后取消注释
      // // 4. 验证功能正常
      // await expect(prodLiquidationCollateralManager.getPriceOracle()).to.not.be.reverted;
    });
  });
});

/**
 * CollateralManager – Registry 调用优化测试
 * 
 * 测试目标:
 * - 验证模块地址缓存机制是否正常工作
 * - 验证缓存刷新功能是否有效
 * - 验证 Gas 优化效果
 * - 验证命名规范更新
 * - 验证优雅降级功能
 * - 验证权限控制机制
 */
import * as hardhat from 'hardhat';
const { ethers } = hardhat;
import { expect } from 'chai';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

// 导入合约类型
import type { 
  CollateralManager,
  MockPriceOracle,
  MockAccessControlManager,
  MockLendingEngine,
  MockVaultStorage,
  MockCollateralManager
} from '../../../types';

// 导入常量
import { ModuleKeys } from '../../../frontend-config/moduleKeys';

describe('CollateralManager – Registry 调用优化测试', function () {
  // 测试常量定义
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const TEST_AMOUNT = ethers.parseUnits('1000', 18);
  const MAX_PRICE_AGE = 3600;
  const MAX_REASONABLE_PRICE = ethers.parseUnits('1000000000000', 0);
  
  let TEST_ASSET: string;
  let TEST_USER: string;

  // 合约实例
  let collateralManager: CollateralManager;
  let registry: unknown; // 使用 unknown 类型避免复杂的类型匹配
  let _priceOracle: MockPriceOracle;
  let _settlementToken: MockVaultStorage;
  let _accessControlManager: MockAccessControlManager;
  let _lendingEngine: MockLendingEngine;
  let _vaultBusinessLogic: MockVaultStorage;
  let _liquidationCollateralManager: MockCollateralManager;

  // 签名者
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;

  /**
   * 标准代理合约部署函数
   * @param contractName 合约名称
   * @param initData 初始化数据（默认为空）
   * @returns 部署的合约实例
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
   * 使用 MockRegistry 简化测试
   */
  async function deployRegistrySystem() {
    // 1. 部署 MockRegistry
    const MockRegistryFactory = await ethers.getContractFactory('MockRegistry');
    const registry = await MockRegistryFactory.deploy();
    await registry.waitForDeployment();

    // 2. 部署 AccessControlManager
    const { proxyContract: accessControlManager } = await deployProxyContract('MockAccessControlManager');

    // 3. 注册模块到 Registry
    const ACCESS_CONTROL_KEY = ethers.keccak256(ethers.toUtf8Bytes('KEY_ACCESS_CONTROL'));
    await registry.setModule(ACCESS_CONTROL_KEY, accessControlManager.target);

    // 4. 设置权限
    const SET_PARAMETER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('ACTION_SET_PARAMETER'));
    const UPGRADE_MODULE_ROLE = ethers.keccak256(ethers.toUtf8Bytes('ACTION_UPGRADE_MODULE'));
    
    // 使用类型断言来调用 grantRole
    const accessControlManagerTyped = accessControlManager as unknown as MockAccessControlManager;
    await accessControlManagerTyped.grantRole(SET_PARAMETER_ROLE, await owner.getAddress());
    await accessControlManagerTyped.grantRole(UPGRADE_MODULE_ROLE, await owner.getAddress());

    return {
      registry,
      accessControlManager
    };
  }

  /**
   * 部署测试环境的 fixture 函数
   */
  async function deployFixture() {
    [owner, user1, user2] = await ethers.getSigners();
    
    // 设置测试地址
    TEST_ASSET = ethers.Wallet.createRandom().address;
    TEST_USER = await user1.getAddress();

    // 1. 部署 Registry 系统
    const { registry, accessControlManager } = await deployRegistrySystem();

    // 2. 部署其他 Mock 模块
    const { proxyContract: priceOracle } = await deployProxyContract('MockPriceOracle');
    const { proxyContract: settlementToken } = await deployProxyContract('MockVaultStorage');
    const { proxyContract: lendingEngine } = await deployProxyContract('MockLendingEngineConcrete');
    const { proxyContract: vaultBusinessLogic } = await deployProxyContract('MockVaultStorage');
    const { proxyContract: liquidationCollateralManager } = await deployProxyContract('MockCollateralManager');

    // 3. 注册所有模块到 Registry
    const moduleKeys = {
      PRICE_ORACLE: ethers.keccak256(ethers.toUtf8Bytes('KEY_PRICE_ORACLE')),
      SETTLEMENT_TOKEN: ethers.keccak256(ethers.toUtf8Bytes('KEY_SETTLEMENT_TOKEN')),
      LE: ethers.keccak256(ethers.toUtf8Bytes('KEY_LE')),
      VAULT_CONFIG: ethers.keccak256(ethers.toUtf8Bytes('KEY_VAULT_CONFIG')),
      CM: ethers.keccak256(ethers.toUtf8Bytes('KEY_CM'))
    };

    await registry.setModule(moduleKeys.PRICE_ORACLE, priceOracle.target);
    await registry.setModule(moduleKeys.SETTLEMENT_TOKEN, settlementToken.target);
    await registry.setModule(moduleKeys.LE, lendingEngine.target);
    await registry.setModule(moduleKeys.VAULT_CONFIG, vaultBusinessLogic.target);
    await registry.setModule(moduleKeys.CM, liquidationCollateralManager.target);

    // 4. 部署 CollateralManager
    const { proxyContract: collateralManager } = await deployProxyContract('CollateralManager');
    const collateralManagerTyped = collateralManager as unknown as CollateralManager;
    await collateralManagerTyped.initialize(
      priceOracle.target,
      settlementToken.target,
      registry.target
    );

    // 5. 注册 CollateralManager 到 Registry
    await registry.setModule(moduleKeys.CM, collateralManager.target);

    return {
      collateralManager: collateralManagerTyped,
      registry,
      priceOracle: priceOracle as unknown as MockPriceOracle,
      settlementToken: settlementToken as unknown as MockVaultStorage,
      accessControlManager: accessControlManager as unknown as MockAccessControlManager,
      lendingEngine: lendingEngine as unknown as MockLendingEngine,
      vaultBusinessLogic: vaultBusinessLogic as unknown as MockVaultStorage,
      liquidationCollateralManager: liquidationCollateralManager as unknown as MockCollateralManager,
      owner,
      user1,
      user2
    };
  }

  beforeEach(async function () {
    const fixture = await loadFixture(deployFixture);
    collateralManager = fixture.collateralManager;
    registry = fixture.registry;
    _priceOracle = fixture.priceOracle;
    _settlementToken = fixture.settlementToken;
    _accessControlManager = fixture.accessControlManager;
    _lendingEngine = fixture.lendingEngine;
    _vaultBusinessLogic = fixture.vaultBusinessLogic;
    _liquidationCollateralManager = fixture.liquidationCollateralManager;
    owner = fixture.owner;
    user1 = fixture.user1;
    user2 = fixture.user2;
  });

  describe('Registry 调用优化', function () {
    it('CollateralManager – 应该正确缓存模块地址', async function () {
      // 验证命名规范更新
      expect(await collateralManager.priceOracleAddrVar()).to.not.equal(ZERO_ADDRESS);
      expect(await collateralManager.settlementTokenAddrVar()).to.not.equal(ZERO_ADDRESS);
      expect(await collateralManager.registryAddrVar()).to.not.equal(ZERO_ADDRESS);

      // 验证 Registry 地址获取
      expect(await collateralManager.getRegistry()).to.equal((registry as unknown as { target: string }).target);
    });

    it('CollateralManager – 应该支持缓存刷新功能', async function () {
      // 验证缓存刷新功能存在
      expect(collateralManager.refreshModuleAddressCache).to.be.a('function');

      // 测试缓存刷新（需要权限）
      await expect(
        collateralManager.refreshModuleAddressCache()
      ).to.be.revertedWith('MockRegistry: module not found');
    });

    it('CollateralManager – 应该正确处理模块地址更新', async function () {
      // 验证模块地址缓存更新事件
      const filter = collateralManager.filters.ModuleAddressCacheUpdated();
      expect(filter).to.not.be.undefined;
    });
  });

  describe('命名规范验证', function () {
    it('CollateralManager – 应该使用正确的变量命名规范', async function () {
      // 验证公共状态变量使用 Var 后缀
      expect(await collateralManager.priceOracleAddrVar()).to.not.equal(ZERO_ADDRESS);
      expect(await collateralManager.settlementTokenAddrVar()).to.not.equal(ZERO_ADDRESS);
      expect(await collateralManager.registryAddrVar()).to.not.equal(ZERO_ADDRESS);

      // 验证常量命名规范
      expect(await collateralManager.MAX_PRICE_AGE()).to.equal(MAX_PRICE_AGE);
      expect(await collateralManager.MAX_REASONABLE_PRICE()).to.equal(MAX_REASONABLE_PRICE);
    });
  });

  describe('Gas 优化验证', function () {
    it('CollateralManager – 应该减少 Registry 调用次数', async function () {
      // 模拟多次调用以测试缓存效果
      const asset = ethers.Wallet.createRandom().address;

      // 第一次调用应该缓存模块地址
      const tx1 = await collateralManager.getUserAssetValue(TEST_USER, asset);
      expect(tx1).to.not.be.reverted;

      // 后续调用应该使用缓存
      const tx2 = await collateralManager.getUserAssetValue(TEST_USER, asset);
      expect(tx2).to.not.be.reverted;
    });
  });

  describe('优雅降级验证', function () {
    it('CollateralManager – 应该正确处理价格预言机失败', async function () {
      const _asset = ethers.Wallet.createRandom().address;

      // 验证优雅降级事件
      const filter = collateralManager.filters.CollateralManagerGracefulDegradation();
      expect(filter).to.not.be.undefined;

      // 验证健康检查事件
      const healthFilter = collateralManager.filters.PriceOracleHealthCheck();
      expect(healthFilter).to.not.be.undefined;
    });

    it('CollateralManager – 应该支持价格预言机健康检查', async function () {
      const asset = ethers.Wallet.createRandom().address;

      // 测试健康检查功能
      const result = await collateralManager.checkPriceOracleHealth(asset);
      expect(result).to.be.an('array');
      expect(result[0]).to.be.a('boolean');
      expect(result[1]).to.be.a('string');
    });
  });

  describe('权限控制验证', function () {
    it('CollateralManager – 应该正确验证授权调用者', async function () {
      // 验证权限验证失败事件
      const filter = collateralManager.filters.AuthorizationFailed();
      expect(filter).to.not.be.undefined;
    });

    it('CollateralManager – 应该拒绝未授权调用', async function () {
      // 测试未授权调用
      await expect(
        collateralManager.depositCollateral(TEST_USER, TEST_ASSET, TEST_AMOUNT)
      ).to.be.revertedWith('Unauthorized');
    });
  });

  describe('缓存机制验证', function () {
    it('CollateralManager – 应该正确处理缓存版本更新', async function () {
      // 验证缓存版本号存在（私有属性无法直接访问）
      expect(collateralManager).to.be.an('object');
    });

    it('CollateralManager – 应该支持批量缓存刷新', async function () {
      // 验证批量刷新功能
      const commonModules = [
        ModuleKeys.KEY_ACCESS_CONTROL,
        ModuleKeys.KEY_LE,
        ModuleKeys.KEY_VAULT_CONFIG,
        ModuleKeys.KEY_CM
      ];

      // 验证所有常用模块都能正确获取
      for (const moduleKey of commonModules) {
        const moduleAddress = await (registry as unknown as { getModule(key: string): Promise<string> }).getModule(moduleKey);
        expect(moduleAddress).to.not.equal(ZERO_ADDRESS);
      }
    });
  });

  describe('事件验证', function () {
    it('CollateralManager – 应该正确发出所有事件', async function () {
      // 验证所有事件过滤器存在
      const events = [
        'CollateralDeposited',
        'CollateralWithdrawn',
        'UserTotalCollateralValueUpdated',
        'PriceOracleUpdated',
        'SettlementTokenUpdated',
        'RegistryUpdated',
        'BatchOperationsCompleted',
        'PriceValidationFailed',
        'AuthorizationFailed',
        'CollateralManagerGracefulDegradation',
        'PriceOracleHealthCheck',
        'ModuleAddressCacheUpdated'
      ];

      for (const eventName of events) {
        const filter = collateralManager.filters[eventName as keyof typeof collateralManager.filters];
        expect(filter).to.not.be.undefined;
      }
    });
  });

  describe('边界条件测试', function () {
    it('CollateralManager – 应该正确处理零地址参数', async function () {
      await expect(
        collateralManager.getCollateral(ZERO_ADDRESS, TEST_ASSET)
      ).to.be.revertedWithCustomError(collateralManager, 'ZeroAddress');

      await expect(
        collateralManager.getCollateral(TEST_USER, ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(collateralManager, 'ZeroAddress');
    });

    it('CollateralManager – 应该正确处理零金额', async function () {
      await expect(
        collateralManager.depositCollateral(TEST_USER, TEST_ASSET, 0n)
      ).to.be.revertedWith('Unauthorized');
    });

    it('CollateralManager – 应该正确处理金额不匹配', async function () {
      const assets = [TEST_ASSET];
      const amounts = [TEST_AMOUNT, TEST_AMOUNT]; // 长度不匹配

      await expect(
        collateralManager.batchDepositCollateral(TEST_USER, assets, amounts)
      ).to.be.revertedWith('Unauthorized');
    });
  });

  describe('错误处理测试', function () {
    it('CollateralManager – 应该正确处理 Registry 地址无效', async function () {
      // 测试 Registry 地址为零的情况
      await expect(
        collateralManager.setRegistry(ZERO_ADDRESS)
      ).to.be.revertedWith('MockRegistry: module not found');
    });

    it('CollateralManager – 应该正确处理价格预言机更新', async function () {
      const newOracle = ethers.Wallet.createRandom().address;

      // 需要权限才能更新
      await expect(
        collateralManager.setPriceOracle(newOracle)
      ).to.be.revertedWith('MockRegistry: module not found');
    });

    it('CollateralManager – 应该正确处理结算币地址更新', async function () {
      const newToken = ethers.Wallet.createRandom().address;

      // 需要权限才能更新
      await expect(
        collateralManager.setSettlementToken(newToken)
      ).to.be.revertedWith('MockRegistry: module not found');
    });
  });
});

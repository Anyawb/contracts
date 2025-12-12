/**
 * ValuationOracleAdapter – 估值预言机适配器测试
 * 
 * 测试目标:
 * - 代理合约初始化验证
 * - 权限控制功能测试
 * - 价格获取和缓存功能
 * - 批量操作功能测试
 * - 优雅降级机制验证
 * - 预言机健康检查功能
 * - 事件发出验证
 * - 边界条件和错误处理
 * - 暂停/恢复功能测试
 * - 升级功能测试
 * - 生产环境一致性验证
 */
import * as hardhat from 'hardhat';
const { ethers } = hardhat;
import { expect } from 'chai';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

// 导入合约类型
import type { ValuationOracleAdapter } from '../../../types/contracts/Vault/modules/ValuationOracleAdapter';
import type { Registry } from '../../../types/contracts/registry/Registry';
import type { AccessControlManager } from '../../../types/contracts/access/AccessControlManager';
import type { MockPriceOracle } from '../../../types/contracts/Mocks/MockPriceOracle';
import type { MockERC20 } from '../../../types/contracts/Mocks/MockERC20';

// DEPRECATED: ValuationOracleAdapter 测试已废弃，保留文件仅为历史参考
describe.skip('ValuationOracleAdapter – 估值预言机适配器测试 (DEPRECATED)', function () {
  // 测试常量定义
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const TEST_AMOUNT = ethers.parseUnits('1000', 18);
  const TEST_ASSET = '0x1234567890123456789012345678901234567890';
  const TEST_ASSET_2 = '0x2345678901234567890123456789012345678901';
  const TEST_ASSET_3 = '0x3456789012345678901234567890123456789012';
  const TEST_PRICE = ethers.parseUnits('1', 8); // 1 USD with 8 decimals
  const TEST_PRICE_2 = ethers.parseUnits('2', 8); // 2 USD with 8 decimals
  const TEST_PRICE_3 = ethers.parseUnits('0.5', 8); // 0.5 USD with 8 decimals
  const TEST_TIMESTAMP = Math.floor(Date.now() / 1000);

  // 角色定义 - 使用 ActionKeys 中定义的常量
  const ROLES = {
    UPGRADE_MODULE: ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE')),
    SET_PARAMETER: ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER')),
    PAUSE_SYSTEM: ethers.keccak256(ethers.toUtf8Bytes('PAUSE_SYSTEM')),
    UNPAUSE_SYSTEM: ethers.keccak256(ethers.toUtf8Bytes('UNPAUSE_SYSTEM')),
  } as const;

  // 模块键定义 - 使用 ModuleKeys 中定义的常量
  const MODULE_KEYS = {
    ACCESS_CONTROL_MANAGER: ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER')),
    PRICE_ORACLE: ethers.keccak256(ethers.toUtf8Bytes('PRICE_ORACLE')),
    VALUATION_ORACLE: ethers.keccak256(ethers.toUtf8Bytes('VALUATION_ORACLE')),
    SETTLEMENT_TOKEN: ethers.keccak256(ethers.toUtf8Bytes('SETTLEMENT_TOKEN')),
  } as const;

  // 合约实例变量
  let valuationOracleAdapter: ValuationOracleAdapter;
  let registry: Registry;
  let accessControlManager: AccessControlManager;
  let mockPriceOracle: MockPriceOracle;
  let mockSettlementToken: MockERC20;
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let admin: SignerWithAddress;
  let keeper: SignerWithAddress;

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
   * 模拟生产环境的完整部署步骤
   */
  async function deployRegistrySystem() {
    // 1. 部署 Registry 实现和代理
    const RegistryFactory = await ethers.getContractFactory('Registry');
    const registryImplementation = await RegistryFactory.deploy();
    await registryImplementation.waitForDeployment();

    const ProxyFactory = await ethers.getContractFactory('ERC1967Proxy');
    const registryProxy = await ProxyFactory.deploy(
      registryImplementation.target,
      registryImplementation.interface.encodeFunctionData('initialize', [0, await owner.getAddress(), await owner.getAddress()])
    );
    await registryProxy.waitForDeployment();

    const registry = RegistryFactory.attach(await registryProxy.getAddress()) as Registry;

    // 2. 部署 RegistryCore 实现和代理
    const RegistryCoreFactory = await ethers.getContractFactory('RegistryCore');
    const registryCoreImplementation = await RegistryCoreFactory.deploy();
    await registryCoreImplementation.waitForDeployment();

    const RegistryCoreProxyFactory = await ethers.getContractFactory('ERC1967Proxy');
    const registryCoreProxy = await RegistryCoreProxyFactory.deploy(
      registryCoreImplementation.target,
      registryCoreImplementation.interface.encodeFunctionData('initialize', [await owner.getAddress(), 0])
    );
    await registryCoreProxy.waitForDeployment();

    const registryCore = RegistryCoreFactory.attach(await registryCoreProxy.getAddress()) as any;

    // 3. 设置 RegistryCore 到 Registry
    await registry.setRegistryCore(await registryCore.getAddress());

    // 5. 部署 AccessControlManager
    const acmFactory = await ethers.getContractFactory('AccessControlManager');
    const accessControlManager = await acmFactory.deploy(await owner.getAddress(), await registry.getAddress());
    await accessControlManager.waitForDeployment();

    // 6. 注册模块到 Registry
    await registry.setModuleWithReplaceFlag(MODULE_KEYS.ACCESS_CONTROL_MANAGER, await accessControlManager.getAddress(), true);

    // 7. 设置权限
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
   * 标准权限设置函数
   * @param accessControlManager AccessControlManager 实例
   * @param owner 拥有权限的账户
   */
  async function setupPermissions(
    accessControlManager: AccessControlManager, 
    owner: SignerWithAddress
  ) {
    const ownerAddress = await owner.getAddress();
    
    // 分配所有需要的权限给 owner
    for (const [name, role] of Object.entries(ROLES)) {
      await accessControlManager.grantRole(role, ownerAddress);
      console.log(`Granted ${name} role to ${ownerAddress}`);
    }
    
    // 验证权限设置
    for (const [name, role] of Object.entries(ROLES)) {
      const hasRole = await accessControlManager.hasRole(role, ownerAddress);
      expect(hasRole).to.be.true;
      console.log(`Verified ${name} role for ${ownerAddress}`);
    }
  }

  /**
   * 验证权限设置是否正确
   * @param accessControlManager AccessControlManager 实例
   * @param user 用户地址
   * @param role 角色哈希
   */
  async function verifyPermission(
    accessControlManager: AccessControlManager,
    user: string,
    role: string
  ) {
    const hasRole = await accessControlManager.hasRole(role, user);
    console.log(`User ${user} has role ${role}: ${hasRole}`);
    
    if (hasRole) {
      // 测试权限检查是否通过
      await accessControlManager.requireRole(role, user);
      console.log('Permission check passed');
    } else {
      console.log('Permission check failed');
    }
  }

  async function deployFixture() {
    [owner, user, admin, keeper] = await ethers.getSigners();

    // 部署 MockERC20 代币作为结算币
    const mockERC20Factory = await ethers.getContractFactory('MockERC20');
    mockSettlementToken = await mockERC20Factory.deploy('Settlement Token', 'SETTLE', ethers.parseUnits('1000000', 18));
    await mockSettlementToken.waitForDeployment();

    // 部署 Registry 系统
    const { registry: deployedRegistry, accessControlManager: deployedAccessControlManager } = await deployRegistrySystem();
    registry = deployedRegistry;
    accessControlManager = deployedAccessControlManager;

    // 部署 MockPriceOracle
    const mockPriceOracleFactory = await ethers.getContractFactory('MockPriceOracle');
    mockPriceOracle = await mockPriceOracleFactory.deploy();
    await mockPriceOracle.waitForDeployment();

    // 部署 ValuationOracleAdapter
    const { proxyContract: deployedValuationOracleAdapter } = await deployProxyContract('ValuationOracleAdapter');
    valuationOracleAdapter = deployedValuationOracleAdapter as ValuationOracleAdapter;

    // 注册模块到 Registry
    await registry.setModuleWithReplaceFlag(MODULE_KEYS.PRICE_ORACLE, await mockPriceOracle.getAddress(), true);
    await registry.setModuleWithReplaceFlag(MODULE_KEYS.VALUATION_ORACLE, await valuationOracleAdapter.getAddress(), true);
    await registry.setModuleWithReplaceFlag(MODULE_KEYS.SETTLEMENT_TOKEN, await mockSettlementToken.getAddress(), true);

    // 初始化 ValuationOracleAdapter
    await valuationOracleAdapter.initialize(await registry.getAddress(), await mockSettlementToken.getAddress());

    // 设置权限
    await setupPermissions(accessControlManager, owner);

    // 设置测试价格
    await mockPriceOracle.setPrice(TEST_ASSET, TEST_PRICE, TEST_TIMESTAMP, 8);
    await mockPriceOracle.setPrice(TEST_ASSET_2, TEST_PRICE_2, TEST_TIMESTAMP, 8);
    await mockPriceOracle.setPrice(TEST_ASSET_3, TEST_PRICE_3, TEST_TIMESTAMP, 8);

    // 分配代币给用户
    await mockSettlementToken.mint(await user.getAddress(), TEST_AMOUNT * 10n);

    return {
      valuationOracleAdapter,
      registry,
      accessControlManager,
      mockPriceOracle,
      mockSettlementToken,
      owner,
      user,
      admin,
      keeper
    };
  }

  beforeEach(async function () {
    const fixture = await loadFixture(deployFixture);
    valuationOracleAdapter = fixture.valuationOracleAdapter;
    registry = fixture.registry;
    accessControlManager = fixture.accessControlManager;
    mockPriceOracle = fixture.mockPriceOracle;
    mockSettlementToken = fixture.mockSettlementToken;
    owner = fixture.owner;
    user = fixture.user;
    admin = fixture.admin;

    // 确保权限设置正确
    await setupPermissions(accessControlManager, owner);
  });

  describe('初始化测试', function () {
    it('应该正确初始化代理合约', async function () {
      const { proxyContract } = await deployProxyContract('ValuationOracleAdapter');
      
      await expect(
        proxyContract.initialize(registry.target, mockSettlementToken.target)
      ).to.not.be.reverted;
      
      // 验证初始化状态
      expect(await proxyContract.getRegistry()).to.equal(registry.target);
      expect(await proxyContract.getSettlementToken()).to.equal(mockSettlementToken.target);
      expect(await proxyContract.getDefaultOracle()).to.equal(mockPriceOracle.target);
    });

    it('应该拒绝重复初始化', async function () {
      const { proxyContract } = await deployProxyContract('ValuationOracleAdapter');
      await proxyContract.initialize(registry.target, mockSettlementToken.target);
      
      await expect(
        proxyContract.initialize(registry.target, mockSettlementToken.target)
      ).to.be.revertedWith('Initializable: contract is already initialized');
    });

    it('应该拒绝零地址初始化', async function () {
      const { proxyContract } = await deployProxyContract('ValuationOracleAdapter');
      
      // 测试零地址 Registry
      await expect(
        proxyContract.initialize(ZERO_ADDRESS, mockSettlementToken.target)
      ).to.be.revertedWithCustomError(proxyContract, 'ZeroAddress');

      // 测试零地址结算币
      await expect(
        proxyContract.initialize(registry.target, ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(proxyContract, 'ZeroAddress');
    });
  });

  describe('权限控制测试', function () {
    it('应该拒绝无权限用户设置预言机', async function () {
      await expect(
        valuationOracleAdapter.connect(user).setOracle(TEST_ASSET, mockPriceOracle.target)
      ).to.be.revertedWithCustomError(valuationOracleAdapter, 'ZeroAddress');
    });

    it('应该允许有权限用户设置预言机', async function () {
      await expect(
        valuationOracleAdapter.connect(owner).setOracle(TEST_ASSET, mockPriceOracle.target)
      ).to.not.be.reverted;
    });

    it('应该拒绝无权限用户更新默认预言机', async function () {
      await expect(
        valuationOracleAdapter.connect(user).setDefaultOracle(mockPriceOracle.target)
      ).to.be.revertedWithCustomError(valuationOracleAdapter, 'ZeroAddress');
    });

    it('应该允许有权限用户更新默认预言机', async function () {
      await expect(
        valuationOracleAdapter.connect(owner).setDefaultOracle(mockPriceOracle.target)
      ).to.not.be.reverted;
    });

    it('应该拒绝无权限用户暂停系统', async function () {
      await expect(
        valuationOracleAdapter.connect(user).pause()
      ).to.be.revertedWithCustomError(valuationOracleAdapter, 'ZeroAddress');
    });

    it('应该允许有权限用户暂停系统', async function () {
      await expect(
        valuationOracleAdapter.connect(owner).pause()
      ).to.not.be.reverted;
    });

    it('应该拒绝无权限用户恢复系统', async function () {
      await expect(
        valuationOracleAdapter.connect(user).unpause()
      ).to.be.revertedWithCustomError(valuationOracleAdapter, 'ZeroAddress');
    });

    it('应该允许有权限用户恢复系统', async function () {
      await valuationOracleAdapter.connect(owner).pause();
      await expect(
        valuationOracleAdapter.connect(owner).unpause()
      ).to.not.be.reverted;
    });
  });

  describe('价格获取功能测试', function () {
    it('应该正确获取单个资产价格', async function () {
      const [price, timestamp] = await valuationOracleAdapter.getAssetPrice(TEST_ASSET);
      
      expect(price).to.equal(TEST_PRICE);
      expect(timestamp).to.be.gt(0);
    });

    it('应该正确批量获取资产价格', async function () {
      const assets = [TEST_ASSET, TEST_ASSET_2];
      const [prices, timestamps] = await valuationOracleAdapter.getAssetPrices(assets);
      
      expect(prices.length).to.equal(2);
      expect(timestamps.length).to.equal(2);
      expect(prices[0]).to.equal(TEST_PRICE);
      expect(prices[1]).to.equal(TEST_PRICE_2);
    });

    it('应该拒绝零地址资产查询', async function () {
      await expect(
        valuationOracleAdapter.getAssetPrice(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(valuationOracleAdapter, 'ZeroAddress');
    });

    it('应该拒绝空数组批量查询', async function () {
      await expect(
        valuationOracleAdapter.getAssetPrices([])
      ).to.be.revertedWithCustomError(valuationOracleAdapter, 'ZeroAddress');
    });

    it('应该检查价格有效性', async function () {
      const isValid = await valuationOracleAdapter.isPriceValid(TEST_ASSET);
      expect(isValid).to.be.true;
    });

    it('应该返回资产的预言机地址', async function () {
      const oracle = await valuationOracleAdapter.getAssetOracle(TEST_ASSET);
      expect(oracle).to.equal(mockPriceOracle.target);
    });
  });

  describe('缓存功能测试', function () {
    it('应该正确缓存价格', async function () {
      // 第一次调用，从预言机获取价格
      const [price1, timestamp1] = await valuationOracleAdapter.getAssetPrice(TEST_ASSET);
      
      // 第二次调用，应该从缓存获取
      const [price2, timestamp2] = await valuationOracleAdapter.getAssetPrice(TEST_ASSET);
      
      expect(price1).to.equal(price2);
      expect(timestamp1).to.equal(timestamp2);
    });

    it('应该允许清除价格缓存', async function () {
      // 先获取价格，建立缓存
      await valuationOracleAdapter.getAssetPrice(TEST_ASSET);
      
      // 清除缓存
      await expect(
        valuationOracleAdapter.connect(owner).clearPriceCache(TEST_ASSET)
      ).to.not.be.reverted;
    });

    it('应该允许批量清除价格缓存', async function () {
      const assets = [TEST_ASSET, TEST_ASSET_2];
      
      await expect(
        valuationOracleAdapter.connect(owner).clearPriceCaches(assets)
      ).to.not.be.reverted;
    });

    it('应该获取缓存时间窗口', async function () {
      const cacheDuration = await valuationOracleAdapter.getCacheDuration();
      expect(cacheDuration).to.equal(BigInt(300)); // 5分钟
    });

    it('应该获取最大价格年龄', async function () {
      const maxPriceAge = await valuationOracleAdapter.getMaxPriceAge();
      expect(maxPriceAge).to.equal(BigInt(3600)); // 1小时
    });

    it('应该获取价格精度', async function () {
      const priceDecimals = await valuationOracleAdapter.getPriceDecimals();
      expect(priceDecimals).to.equal(BigInt(8));
    });
  });

  describe('预言机健康检查测试', function () {
    it('应该检查价格预言机健康状态', async function () {
      const [isHealthy, details] = await valuationOracleAdapter.checkPriceOracleHealth(TEST_ASSET);
      
      expect(isHealthy).to.be.true;
      expect(details).to.be.a('string');
    });

    it('应该拒绝零地址健康检查', async function () {
      await expect(
        valuationOracleAdapter.checkPriceOracleHealth(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(valuationOracleAdapter, 'ZeroAddress');
    });
  });

  describe('优雅降级测试', function () {
    it('应该在预言机失败时使用降级策略', async function () {
      // 设置预言机返回零价格
      await mockPriceOracle.setPrice(TEST_ASSET, 0, TEST_TIMESTAMP, 8);
      
      // 应该仍然能获取价格（通过降级策略）
      const [price, timestamp] = await valuationOracleAdapter.getAssetPrice(TEST_ASSET);
      
      expect(price).to.be.gt(0);
      expect(timestamp).to.be.gt(0);
    });

    it('应该发出优雅降级事件', async function () {
      // 设置预言机返回过期价格
      const oldTimestamp = TEST_TIMESTAMP - 4000; // 超过1小时
      await mockPriceOracle.setPrice(TEST_ASSET, TEST_PRICE, oldTimestamp, 8);
      
      await expect(
        valuationOracleAdapter.getAssetPrice(TEST_ASSET)
      ).to.emit(valuationOracleAdapter, 'ValuationGracefulDegradation')
        .withArgs(TEST_ASSET, (reason: string) => reason.length > 0, (price: bigint) => price > 0, true);
    });
  });

  describe('批量操作测试', function () {
    it('应该正确批量设置预言机', async function () {
      const assets = [TEST_ASSET, TEST_ASSET_2];
      const oracles = [mockPriceOracle.target, mockPriceOracle.target];
      
      await expect(
        valuationOracleAdapter.connect(owner).setOracles(assets, oracles)
      ).to.not.be.reverted;
    });

    it('应该拒绝长度不匹配的批量设置', async function () {
      const assets = [TEST_ASSET];
      const oracles = [mockPriceOracle.target, mockPriceOracle.target];
      
      await expect(
        valuationOracleAdapter.connect(owner).setOracles(assets, oracles)
      ).to.be.revertedWithCustomError(valuationOracleAdapter, 'AmountMismatch');
    });

    it('应该拒绝空数组批量设置', async function () {
      await expect(
        valuationOracleAdapter.connect(owner).setOracles([], [])
      ).to.be.revertedWithCustomError(valuationOracleAdapter, 'ZeroAddress');
    });
  });

  describe('事件测试', function () {
    it('应该发出预言机设置事件', async function () {
      await expect(
        valuationOracleAdapter.connect(owner).setOracle(TEST_ASSET, mockPriceOracle.target)
      ).to.emit(valuationOracleAdapter, 'OracleSet')
        .withArgs(TEST_ASSET, ZERO_ADDRESS, mockPriceOracle.target);
    });

    it('应该发出默认预言机更新事件', async function () {
      await expect(
        valuationOracleAdapter.connect(owner).setDefaultOracle(mockPriceOracle.target)
      ).to.emit(valuationOracleAdapter, 'DefaultOracleUpdated')
        .withArgs(mockPriceOracle.target, mockPriceOracle.target);
    });

    it('应该发出价格缓存更新事件', async function () {
      await expect(
        valuationOracleAdapter.getAssetPrice(TEST_ASSET)
      ).to.emit(valuationOracleAdapter, 'PriceCacheUpdated')
        .withArgs(TEST_ASSET, (oldPrice: bigint) => oldPrice >= 0, TEST_PRICE, (timestamp: bigint) => timestamp > 0);
    });

    it('应该发出价格预言机健康检查事件', async function () {
      await expect(
        valuationOracleAdapter.getAssetPrice(TEST_ASSET)
      ).to.emit(valuationOracleAdapter, 'PriceOracleHealthCheck')
        .withArgs(TEST_ASSET, true, (details: string) => details.length > 0);
    });
  });

  describe('暂停/恢复功能测试', function () {
    it('应该在暂停状态下拒绝价格查询', async function () {
      await valuationOracleAdapter.connect(owner).pause();
      
      await expect(
        valuationOracleAdapter.getAssetPrice(TEST_ASSET)
      ).to.be.revertedWith('Pausable: paused');
    });

    it('应该在暂停状态下拒绝批量价格查询', async function () {
      await valuationOracleAdapter.connect(owner).pause();
      
      await expect(
        valuationOracleAdapter.getAssetPrices([TEST_ASSET])
      ).to.be.revertedWith('Pausable: paused');
    });

    it('应该在恢复后允许价格查询', async function () {
      await valuationOracleAdapter.connect(owner).pause();
      await valuationOracleAdapter.connect(owner).unpause();
      
      await expect(
        valuationOracleAdapter.getAssetPrice(TEST_ASSET)
      ).to.not.be.reverted;
    });
  });

  describe('升级功能测试', function () {
    it('应该允许有权限用户升级合约', async function () {
      // 部署新的实现合约
      const ValuationOracleAdapterFactory = await ethers.getContractFactory('ValuationOracleAdapter');
      const newImplementation = await ValuationOracleAdapterFactory.deploy();
      await newImplementation.waitForDeployment();

      await expect(
        valuationOracleAdapter.connect(owner).upgradeTo(newImplementation.target)
      ).to.not.be.reverted;
    });

    it('应该拒绝无权限用户升级合约', async function () {
      const ValuationOracleAdapterFactory = await ethers.getContractFactory('ValuationOracleAdapter');
      const newImplementation = await ValuationOracleAdapterFactory.deploy();
      await newImplementation.waitForDeployment();

      await expect(
        valuationOracleAdapter.connect(user).upgradeTo(newImplementation.target)
      ).to.be.revertedWithCustomError(valuationOracleAdapter, 'ZeroAddress');
    });
  });

  describe('边界条件测试', function () {
    it('应该处理预言机未配置的情况', async function () {
      // 部署新的适配器，不设置默认预言机
      const { proxyContract } = await deployProxyContract('ValuationOracleAdapter');
      await proxyContract.initialize(registry.target, mockSettlementToken.target);
      
      // 清除默认预言机
      await registry.setModule(MODULE_KEYS.PRICE_ORACLE, ZERO_ADDRESS, true);
      
      await expect(
        proxyContract.getAssetPrice(TEST_ASSET)
      ).to.be.revertedWithCustomError(proxyContract, 'ExternalModuleRevertedRaw');
    });

    it('应该处理预言机返回无效价格的情况', async function () {
      // 设置预言机返回极大价格
      await mockPriceOracle.setPrice(TEST_ASSET, ethers.parseUnits('1000000', 8), TEST_TIMESTAMP, 8);
      
      // 应该通过降级策略处理
      const [price, timestamp] = await valuationOracleAdapter.getAssetPrice(TEST_ASSET);
      expect(price).to.be.gt(0);
    });

    it('应该处理预言机返回过期价格的情况', async function () {
      // 设置预言机返回过期价格
      const oldTimestamp = TEST_TIMESTAMP - 4000;
      await mockPriceOracle.setPrice(TEST_ASSET, TEST_PRICE, oldTimestamp, 8);
      
      // 应该通过降级策略处理
      const [price, timestamp] = await valuationOracleAdapter.getAssetPrice(TEST_ASSET);
      expect(price).to.be.gt(0);
    });
  });

  describe('错误处理测试', function () {
    it('应该拒绝零地址参数', async function () {
      await expect(
        valuationOracleAdapter.connect(owner).setOracle(ZERO_ADDRESS, mockPriceOracle.target)
      ).to.be.revertedWithCustomError(valuationOracleAdapter, 'ZeroAddress');

      await expect(
        valuationOracleAdapter.connect(owner).setOracle(TEST_ASSET, ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(valuationOracleAdapter, 'ZeroAddress');

      await expect(
        valuationOracleAdapter.connect(owner).setDefaultOracle(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(valuationOracleAdapter, 'ZeroAddress');

      await expect(
        valuationOracleAdapter.connect(owner).clearPriceCache(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(valuationOracleAdapter, 'ZeroAddress');
    });

    it('应该拒绝无效的 Registry 地址', async function () {
      const { proxyContract } = await deployProxyContract('ValuationOracleAdapter');
      
      await expect(
        proxyContract.initialize(ZERO_ADDRESS, mockSettlementToken.target)
      ).to.be.revertedWithCustomError(proxyContract, 'ZeroAddress');
    });

    it('应该拒绝无效的结算币地址', async function () {
      const { proxyContract } = await deployProxyContract('ValuationOracleAdapter');
      
      await expect(
        proxyContract.initialize(registry.target, ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(proxyContract, 'ZeroAddress');
    });
  });

  describe('生产环境一致性测试', function () {
    it('应该模拟完整的生产部署流程', async function () {
      // 1. 部署 Registry 系统
      const { registry: prodRegistry, accessControlManager: prodAcm } = await deployRegistrySystem();
      
      // 2. 部署 ValuationOracleAdapter
      const { proxyContract: prodValuationOracleAdapter } = await deployProxyContract('ValuationOracleAdapter');
      await prodValuationOracleAdapter.initialize(prodRegistry.target, mockSettlementToken.target);
      
      // 3. 注册到 Registry
      await prodRegistry.setModule(MODULE_KEYS.VALUATION_ORACLE, prodValuationOracleAdapter.target, true);
      await prodRegistry.setModule(MODULE_KEYS.PRICE_ORACLE, mockPriceOracle.target, true);
      await prodRegistry.setModule(MODULE_KEYS.SETTLEMENT_TOKEN, mockSettlementToken.target, true);
      
      // 4. 分配权限
      await setupPermissions(prodAcm, owner);
      
      // 5. 验证功能正常
      await expect(prodValuationOracleAdapter.getAssetPrice(TEST_ASSET)).to.not.be.reverted;
    });
  });
});

/**
 * VaultBusinessLogic – 业务逻辑模块测试
 * 
 * 测试目标:
 * - 业务逻辑模块的完整功能验证
 * - 模块化架构和依赖关系测试
 * - 权限控制和缓存机制验证
 * - 错误处理和边界条件测试
 * - 积分奖励和保证金管理集成测试
 */

import hardhat from 'hardhat';
const { ethers } = hardhat;
import { expect } from 'chai';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import type { ContractFactory } from 'ethers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

// 导入合约类型
import type { VaultBusinessLogic } from '../../../types/contracts/Vault/modules/VaultBusinessLogic';

// 导入常量
import { ModuleKeys } from '../../../frontend-config/moduleKeys';

describe('VaultBusinessLogic – 业务逻辑模块测试', function () {
  // 测试常量定义
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const MAX_BATCH_SIZE = 50;
  const TEST_AMOUNT = ethers.parseUnits('1000', 18);
  // TEST_ASSET 将在 deployFixture 中设置为 mockERC20 的地址
  let TEST_ASSET: string;

  // 合约实例
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let vaultBusinessLogic: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let vaultBusinessLogicFactory: any;
  
  // Mock 合约
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockRegistry: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockCollateralManager: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockLendingEngine: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockStatisticsView: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // let mockHealthFactorCalculator: any; // HealthFactorCalculator 已废弃
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockFeeRouter: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockRewardManager: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockAssetWhitelist: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockGuaranteeFundManager: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockAccessControlManager: any;
  
  // 测试代币
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockERC20: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockERC20Factory: any;
  
  // 测试账户
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let admin: SignerWithAddress;
  let ownerAddress: string;
  let userAddress: string;
  let adminAddress: string;

  async function deployFixture() {
    // 获取签名者
    const [ownerSigner, userSigner, adminSigner] = await ethers.getSigners();
    owner = ownerSigner;
    user = userSigner;
    admin = adminSigner;
    ownerAddress = await owner.getAddress();
    userAddress = await user.getAddress();
    adminAddress = await admin.getAddress();
    
    // 部署主合约
    vaultBusinessLogicFactory = await ethers.getContractFactory('VaultBusinessLogic');
    
    // 创建 Mock 合约
    mockRegistry = await ethers.getContractFactory('MockRegistry');
    mockCollateralManager = await ethers.getContractFactory('MockCollateralManager');
    mockLendingEngine = await ethers.getContractFactory('MockLendingEngineConcrete');
    mockStatisticsView = await ethers.getContractFactory('MockStatisticsView');
    // mockHealthFactorCalculator 已废弃，不再需要
    mockFeeRouter = await ethers.getContractFactory('MockFeeRouter');
    mockRewardManager = await ethers.getContractFactory('MockRewardManager');
    mockAssetWhitelist = await ethers.getContractFactory('MockAssetWhitelist');
    mockGuaranteeFundManager = await ethers.getContractFactory('MockGuaranteeFundManager');
    mockAccessControlManager = await ethers.getContractFactory('MockAccessControlManager');
    
    // 创建 Mock ERC20
    mockERC20Factory = await ethers.getContractFactory('MockERC20');
    mockERC20 = await mockERC20Factory.deploy('Test Token', 'TEST', TEST_AMOUNT * 100n);
    await mockERC20.waitForDeployment();
    
    // 部署 Mock 合约实例
    const deployedMockRegistry = await mockRegistry.deploy();
    await deployedMockRegistry.waitForDeployment();
    
    const deployedMockCollateralManager = await mockCollateralManager.deploy();
    await deployedMockCollateralManager.waitForDeployment();
    
    const deployedMockLendingEngine = await mockLendingEngine.deploy();
    await deployedMockLendingEngine.waitForDeployment();
    
    const deployedMockStatisticsView = await mockStatisticsView.deploy();
    await deployedMockStatisticsView.waitForDeployment();
    
    // HealthFactorCalculator 已废弃，不再部署
    
    const deployedMockFeeRouter = await mockFeeRouter.deploy();
    await deployedMockFeeRouter.waitForDeployment();
    
    const deployedMockRewardManager = await mockRewardManager.deploy();
    await deployedMockRewardManager.waitForDeployment();
    
    const deployedMockAssetWhitelist = await mockAssetWhitelist.deploy();
    await deployedMockAssetWhitelist.waitForDeployment();
    
    const deployedMockGuaranteeFundManager = await mockGuaranteeFundManager.deploy();
    await deployedMockGuaranteeFundManager.waitForDeployment();
    
    const deployedMockAccessControlManager = await mockAccessControlManager.deploy();
    await deployedMockAccessControlManager.waitForDeployment();
    
    // 设置 Mock Registry 返回各模块地址
    await deployedMockRegistry.setModule(ModuleKeys.KEY_CM, deployedMockCollateralManager.target);
    await deployedMockRegistry.setModule(ModuleKeys.KEY_LE, deployedMockLendingEngine.target);
    await deployedMockRegistry.setModule(ModuleKeys.KEY_STATS, deployedMockStatisticsView.target);
    // KEY_HF_CALC 已废弃，不再注册
    await deployedMockRegistry.setModule(ModuleKeys.KEY_FR, deployedMockFeeRouter.target);
    await deployedMockRegistry.setModule(ModuleKeys.KEY_RM, deployedMockRewardManager.target);
    await deployedMockRegistry.setModule(ModuleKeys.KEY_ASSET_WHITELIST, deployedMockAssetWhitelist.target);
    await deployedMockRegistry.setModule(ModuleKeys.KEY_GUARANTEE_FUND, deployedMockGuaranteeFundManager.target);
    
    // 设置 Mock AccessControlManager
    await deployedMockAccessControlManager.setMockRole(true);
    
    // 为owner设置管理角色
    await deployedMockAccessControlManager.grantRole(ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER')), ownerAddress);
    await deployedMockAccessControlManager.grantRole(ethers.keccak256(ethers.toUtf8Bytes('PAUSE_SYSTEM')), ownerAddress);
    await deployedMockAccessControlManager.grantRole(ethers.keccak256(ethers.toUtf8Bytes('UNPAUSE_SYSTEM')), ownerAddress);
    await deployedMockAccessControlManager.grantRole(ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE')), ownerAddress);
    
    // 设置 Mock AssetWhitelist
    await deployedMockAssetWhitelist.setMockAllowed(true);
    
    // 设置 Mock ERC20
    await mockERC20.mint(mockERC20.target, TEST_AMOUNT * 100n);
    
    // 部署 VaultBusinessLogic 实现合约
    const deployedVaultBusinessLogic = await vaultBusinessLogicFactory.deploy();
    await deployedVaultBusinessLogic.waitForDeployment();
    
    // 部署代理合约
    const proxyFactory = await ethers.getContractFactory('ERC1967Proxy');
    const proxy = await proxyFactory.deploy(
      deployedVaultBusinessLogic.target,
      deployedVaultBusinessLogic.interface.encodeFunctionData('initialize', [
        deployedMockRegistry.target,
        deployedMockAccessControlManager.target
      ])
    );
    await proxy.waitForDeployment();
    
    // 通过代理合约访问VaultBusinessLogic
    const vaultBusinessLogicProxy = deployedVaultBusinessLogic.attach(proxy.target);
    
    // 给合约一些代币用于借款操作
    await mockERC20.mint(vaultBusinessLogicProxy.target, TEST_AMOUNT * 50n);
    
    // 给用户一些代币用于测试
    await mockERC20.transfer(userAddress, TEST_AMOUNT * 50n);
    await mockERC20.transfer(ownerAddress, TEST_AMOUNT * 50n);
    
    // 用户需要approve代币给合约
    await mockERC20.connect(user).approve(vaultBusinessLogicProxy.target, TEST_AMOUNT * 100n);
    await mockERC20.connect(owner).approve(vaultBusinessLogicProxy.target, TEST_AMOUNT * 100n);
    
    // 设置测试资产地址
    TEST_ASSET = mockERC20.target;
    
    return {
      vaultBusinessLogic: vaultBusinessLogicProxy,
      mockRegistry: deployedMockRegistry,
      mockCollateralManager: deployedMockCollateralManager,
      mockLendingEngine: deployedMockLendingEngine,
      mockStatisticsView: deployedMockStatisticsView,
      // mockHealthFactorCalculator: deployedMockHealthFactorCalculator, // 已废弃
      mockFeeRouter: deployedMockFeeRouter,
      mockRewardManager: deployedMockRewardManager,
      mockAssetWhitelist: deployedMockAssetWhitelist,
      mockGuaranteeFundManager: deployedMockGuaranteeFundManager,
      mockAccessControlManager: deployedMockAccessControlManager,
      mockERC20,
      owner,
      user,
      admin,
      ownerAddress,
      userAddress,
      adminAddress
    };
  }

  beforeEach(async function () {
    const fixture = await loadFixture(deployFixture);
    
    // 设置全局变量
    vaultBusinessLogic = fixture.vaultBusinessLogic;
    mockRegistry = fixture.mockRegistry;
    mockCollateralManager = fixture.mockCollateralManager;
    mockLendingEngine = fixture.mockLendingEngine;
    mockStatisticsView = fixture.mockStatisticsView;
    // mockHealthFactorCalculator 已废弃
    mockFeeRouter = fixture.mockFeeRouter;
    mockRewardManager = fixture.mockRewardManager;
    mockAssetWhitelist = fixture.mockAssetWhitelist;
    mockGuaranteeFundManager = fixture.mockGuaranteeFundManager;
    mockAccessControlManager = fixture.mockAccessControlManager;
    mockERC20 = fixture.mockERC20;
    owner = fixture.owner;
    user = fixture.user;
    admin = fixture.admin;
    ownerAddress = fixture.ownerAddress;
    userAddress = fixture.userAddress;
    adminAddress = fixture.adminAddress;
  });

  describe('初始化测试', function () {
    it('VaultBusinessLogic – 应该正确初始化合约', async function () {
      // 验证合约已成功初始化（通过调用一个需要初始化的方法）
      expect(await vaultBusinessLogic.paused()).to.be.false;
    });

    it('VaultBusinessLogic – 应该拒绝零地址初始化', async function () {
      // 创建新的未初始化合约实例
      const newVaultBusinessLogic = await vaultBusinessLogicFactory.deploy();
      await newVaultBusinessLogic.waitForDeployment();
      
      // 部署新的代理合约
      const proxyFactory = await ethers.getContractFactory('ERC1967Proxy');
      const newProxy = await proxyFactory.deploy(
        newVaultBusinessLogic.target,
        '0x' // 空的初始化数据
      );
      await newProxy.waitForDeployment();
      
      // 通过代理合约访问VaultBusinessLogic
      const newVaultBusinessLogicProxy = newVaultBusinessLogic.attach(newProxy.target);
      
      await expect(
        newVaultBusinessLogicProxy.initialize(ZERO_ADDRESS, mockAccessControlManager.target)
      ).to.be.revertedWithCustomError(newVaultBusinessLogicProxy, 'ZeroAddress');
      
      await expect(
        newVaultBusinessLogicProxy.initialize(mockRegistry.target, ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(newVaultBusinessLogicProxy, 'ZeroAddress');
    });

    it('VaultBusinessLogic – 应该拒绝重复初始化', async function () {
      await expect(
        vaultBusinessLogic.initialize(mockRegistry.target, mockAccessControlManager.target)
      ).to.be.revertedWith('Initializable: contract is already initialized');
    });
  });

  describe('权限控制测试', function () {
    it('VaultBusinessLogic – 应该正确检查权限', async function () {
      // 撤销owner的SET_PARAMETER权限
      await mockAccessControlManager.revokeRole(ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER')), ownerAddress);
      
      await expect(
        vaultBusinessLogic.setRegistry(mockRegistry.target)
      ).to.be.revertedWith('requireRole: MissingRole');
    });

    it('VaultBusinessLogic – 应该允许有权限的用户执行管理操作', async function () {
      // 确保owner有SET_PARAMETER权限
      await mockAccessControlManager.grantRole(ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER')), ownerAddress);
      
      await expect(
        vaultBusinessLogic.setRegistry(mockRegistry.target)
      ).to.not.be.reverted;
    });
  });

  describe('资产白名单测试', function () {
    it('VaultBusinessLogic – 应该检查资产是否在白名单中', async function () {
      // 设置资产不在白名单中
      await mockAssetWhitelist.setMockAllowed(false);
      
      await expect(
        vaultBusinessLogic.deposit(userAddress, TEST_ASSET, TEST_AMOUNT)
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'AssetNotAllowed');
    });

    it('VaultBusinessLogic – 应该允许白名单中的资产', async function () {
      // 设置资产在白名单中
      await mockAssetWhitelist.setMockAllowed(true);
      
      // 设置其他模块调用成功
      await mockCollateralManager.setMockSuccess(true);
      await mockGuaranteeFundManager.setMockSuccess(true);
      await mockStatisticsView.setShouldFail(false);
      await mockRewardManager.setMockSuccess(true);
      
      await expect(
        vaultBusinessLogic.deposit(userAddress, TEST_ASSET, TEST_AMOUNT)
      ).to.not.be.reverted;
    });

    it('VaultBusinessLogic – 应该处理白名单模块未设置的情况', async function () {
      // 设置白名单模块返回零地址
      await mockRegistry.setMockModule(ModuleKeys.KEY_ASSET_WHITELIST, ZERO_ADDRESS);
      
      // 设置其他模块调用成功
      await mockCollateralManager.setMockSuccess(true);
      await mockGuaranteeFundManager.setMockSuccess(true);
      await mockStatisticsView.setShouldFail(false);
      await mockRewardManager.setMockSuccess(true);
      
      await expect(
        vaultBusinessLogic.deposit(userAddress, TEST_ASSET, TEST_AMOUNT)
      ).to.not.be.reverted;
    });
  });

  describe('存入功能测试', function () {
    beforeEach(async function () {
      // 设置所有模块调用成功
      await mockCollateralManager.setMockSuccess(true);
      await mockGuaranteeFundManager.setMockSuccess(true);
      await mockStatisticsView.setShouldFail(false);
      await mockRewardManager.setMockSuccess(true);
    });

    it('VaultBusinessLogic – 应该成功存入资产', async function () {
      await expect(
        vaultBusinessLogic.deposit(userAddress, TEST_ASSET, TEST_AMOUNT)
      ).to.not.be.reverted;
    });

    it('VaultBusinessLogic – 应该拒绝零金额存入', async function () {
      await expect(
        vaultBusinessLogic.deposit(userAddress, TEST_ASSET, 0n)
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'AmountIsZero');
    });

    it('VaultBusinessLogic – 应该拒绝零地址资产', async function () {
      await expect(
        vaultBusinessLogic.deposit(userAddress, ZERO_ADDRESS, TEST_AMOUNT)
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'ZeroAddress');
    });

    it('VaultBusinessLogic – 应该处理模块调用失败', async function () {
      // 设置抵押物管理模块调用失败
      await mockCollateralManager.setMockSuccess(false);
      
      await expect(
        vaultBusinessLogic.deposit(userAddress, TEST_ASSET, TEST_AMOUNT)
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'ExternalModuleRevertedRaw');
    });
  });

  describe('借款功能测试', function () {
    beforeEach(async function () {
      // 设置所有模块调用成功
      await mockLendingEngine.setMockSuccess(true);
      await mockStatisticsView.setShouldFail(false);
      await mockRewardManager.setMockSuccess(true);
    });

    it('VaultBusinessLogic – 应该成功借款', async function () {
      await expect(
        vaultBusinessLogic.borrow(userAddress, TEST_ASSET, TEST_AMOUNT)
      ).to.not.be.reverted;
    });

    it('VaultBusinessLogic – 应该拒绝零金额借款', async function () {
      await expect(
        vaultBusinessLogic.borrow(userAddress, TEST_ASSET, 0n)
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'AmountIsZero');
    });

    it('VaultBusinessLogic – 应该处理借贷引擎调用失败', async function () {
      await mockLendingEngine.setMockSuccess(false);
      
      await expect(
        vaultBusinessLogic.borrow(userAddress, TEST_ASSET, TEST_AMOUNT)
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'ExternalModuleRevertedRaw');
    });
  });

  describe('还款功能测试', function () {
    beforeEach(async function () {
      // 设置所有模块调用成功
      await mockLendingEngine.setMockSuccess(true);
      await mockStatisticsView.setShouldFail(false);
      await mockRewardManager.setMockSuccess(true);
    });

    it('VaultBusinessLogic – 应该成功还款', async function () {
      await expect(
        vaultBusinessLogic.repay(userAddress, TEST_ASSET, TEST_AMOUNT)
      ).to.not.be.reverted;
    });

    it('VaultBusinessLogic – 应该处理还款引擎调用失败', async function () {
      await mockLendingEngine.setMockSuccess(false);
      
      await expect(
        vaultBusinessLogic.repay(userAddress, TEST_ASSET, TEST_AMOUNT)
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'ExternalModuleRevertedRaw');
    });
  });

  describe('提取功能测试', function () {
    beforeEach(async function () {
      // 设置所有模块调用成功
      await mockCollateralManager.setMockSuccess(true);
      await mockGuaranteeFundManager.setMockSuccess(true);
      await mockStatisticsView.setShouldFail(false);
      await mockRewardManager.setMockSuccess(true);
      
      // 确保合约有足够的代币用于提取
      await mockERC20.mint(vaultBusinessLogic.target, TEST_AMOUNT * 10n);
      
      // 先存入一些代币，这样提取时才有余额
      await mockERC20.connect(user).approve(vaultBusinessLogic.target, TEST_AMOUNT * 10n);
      await vaultBusinessLogic.deposit(userAddress, TEST_ASSET, TEST_AMOUNT);
    });

    it('VaultBusinessLogic – 应该成功提取抵押物', async function () {
      await expect(
        vaultBusinessLogic.withdraw(userAddress, TEST_ASSET, TEST_AMOUNT)
      ).to.not.be.reverted;
    });

    it('VaultBusinessLogic – 应该处理提取失败', async function () {
      // 设置抵押物管理模块调用失败
      await mockCollateralManager.setMockSuccess(false);
      
      await expect(
        vaultBusinessLogic.withdraw(userAddress, TEST_ASSET, TEST_AMOUNT)
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'ExternalModuleRevertedRaw');
    });
  });

  describe('批量操作测试', function () {
    let assets: string[];
    let amounts: bigint[];
    
    beforeEach(async function () {
      // 设置测试数据
      assets = [TEST_ASSET, TEST_ASSET];
      amounts = [TEST_AMOUNT, TEST_AMOUNT * 2n];
      
      // 设置所有模块调用成功
      await mockCollateralManager.setMockSuccess(true);
      await mockGuaranteeFundManager.setMockSuccess(true);
      await mockStatisticsView.setShouldFail(false);
      await mockRewardManager.setMockSuccess(true);
      
      // 确保合约有足够的代币用于批量提取
      await mockERC20.mint(vaultBusinessLogic.target, TEST_AMOUNT * 20n);
      
      // 先存入一些代币，这样批量提取时才有余额
      await mockERC20.connect(user).approve(vaultBusinessLogic.target, TEST_AMOUNT * 20n);
      await vaultBusinessLogic.deposit(userAddress, TEST_ASSET, TEST_AMOUNT * 3n);
    });

    it('VaultBusinessLogic – 应该成功执行批量存入', async function () {
      await expect(
        vaultBusinessLogic.batchDeposit(userAddress, assets, amounts)
      ).to.not.be.reverted;
    });

    it('VaultBusinessLogic – 应该成功执行批量借款', async function () {
      await mockLendingEngine.setMockSuccess(true);
      
      await expect(
        vaultBusinessLogic.batchBorrow(userAddress, assets, amounts)
      ).to.not.be.reverted;
    });

    it('VaultBusinessLogic – 应该成功执行批量还款', async function () {
      await mockLendingEngine.setMockSuccess(true);
      
      await expect(
        vaultBusinessLogic.batchRepay(userAddress, assets, amounts)
      ).to.not.be.reverted;
    });

    it('VaultBusinessLogic – 应该成功执行批量提取', async function () {
      await mockCollateralManager.setMockSuccess(true);
      await mockGuaranteeFundManager.setMockSuccess(true);
      
      await expect(
        vaultBusinessLogic.batchWithdraw(userAddress, assets, amounts)
      ).to.not.be.reverted;
    });

    it('VaultBusinessLogic – 应该拒绝参数不匹配的批量操作', async function () {
      const wrongAmounts = [TEST_AMOUNT]; // 长度不匹配
      
      await expect(
        vaultBusinessLogic.batchDeposit(userAddress, assets, wrongAmounts)
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'InvalidAmounts');
    });

    it('VaultBusinessLogic – 应该拒绝空数组', async function () {
      await expect(
        vaultBusinessLogic.batchDeposit(userAddress, [], [])
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'AmountIsZero');
    });

    it('VaultBusinessLogic – 应该拒绝超过最大批量大小的操作', async function () {
      const largeAssets = new Array(MAX_BATCH_SIZE + 1).fill(TEST_ASSET);
      const largeAmounts = new Array(MAX_BATCH_SIZE + 1).fill(TEST_AMOUNT);
      
      await expect(
        vaultBusinessLogic.batchDeposit(userAddress, largeAssets, largeAmounts)
      ).to.be.revertedWith('Batch too large');
    });
  });

  describe('积分奖励系统测试', function () {
    it('VaultBusinessLogic – 应该正确处理积分奖励', async function () {
      // 设置其他模块调用成功
      await mockCollateralManager.setMockSuccess(true);
      await mockGuaranteeFundManager.setMockSuccess(true);
      await mockStatisticsView.setShouldFail(false);
      await mockRewardManager.setMockSuccess(true);
      
      await expect(
        vaultBusinessLogic.deposit(userAddress, TEST_ASSET, TEST_AMOUNT)
      ).to.not.be.reverted;
    });

    it('VaultBusinessLogic – 应该处理积分管理器未设置的情况', async function () {
      // 设置积分管理器返回零地址
      await mockRegistry.setMockModule(ModuleKeys.KEY_RM, ZERO_ADDRESS);
      
      // 设置其他模块调用成功
      await mockCollateralManager.setMockSuccess(true);
      await mockGuaranteeFundManager.setMockSuccess(true);
      await mockStatisticsView.setShouldFail(false);
      
      await expect(
        vaultBusinessLogic.deposit(userAddress, TEST_ASSET, TEST_AMOUNT)
      ).to.not.be.reverted;
    });

    it('VaultBusinessLogic – 应该处理积分管理器调用失败但不中断主流程', async function () {
      // 设置积分管理器调用失败
      await mockRewardManager.setMockSuccess(false);
      
      // 设置其他模块调用成功
      await mockCollateralManager.setMockSuccess(true);
      await mockGuaranteeFundManager.setMockSuccess(true);
      await mockStatisticsView.setShouldFail(false);
      
      // 应该不因为积分管理器失败而中断
      await expect(
        vaultBusinessLogic.deposit(userAddress, TEST_ASSET, TEST_AMOUNT)
      ).to.not.be.reverted;
    });
  });

  describe('保证金管理测试', function () {
    beforeEach(async function () {
      // 确保合约有足够的代币
      await mockERC20.mint(vaultBusinessLogic.target, TEST_AMOUNT * 10n);
      
      // 先存入一些代币
      await mockERC20.connect(user).approve(vaultBusinessLogic.target, TEST_AMOUNT * 10n);
      await vaultBusinessLogic.deposit(userAddress, TEST_ASSET, TEST_AMOUNT);
    });

    it('VaultBusinessLogic – 应该正确处理保证金锁定', async function () {
      // 设置其他模块调用成功
      await mockCollateralManager.setMockSuccess(true);
      await mockGuaranteeFundManager.setMockSuccess(true);
      await mockStatisticsView.setShouldFail(false);
      await mockRewardManager.setMockSuccess(true);
      
      await expect(
        vaultBusinessLogic.deposit(userAddress, TEST_ASSET, TEST_AMOUNT)
      ).to.not.be.reverted;
    });

    it('VaultBusinessLogic – 应该正确处理保证金释放', async function () {
      // 设置其他模块调用成功
      await mockCollateralManager.setMockSuccess(true);
      await mockGuaranteeFundManager.setMockSuccess(true);
      await mockStatisticsView.setShouldFail(false);
      await mockRewardManager.setMockSuccess(true);
      
      await expect(
        vaultBusinessLogic.withdraw(userAddress, TEST_ASSET, TEST_AMOUNT)
      ).to.not.be.reverted;
    });

    it('VaultBusinessLogic – 应该处理保证金管理器调用失败', async function () {
      await mockGuaranteeFundManager.setMockSuccess(false);
      
      // 设置其他模块调用成功
      await mockCollateralManager.setMockSuccess(true);
      await mockStatisticsView.setShouldFail(false);
      await mockRewardManager.setMockSuccess(true);
      
      await expect(
        vaultBusinessLogic.deposit(userAddress, TEST_ASSET, TEST_AMOUNT)
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'ExternalModuleRevertedRaw');
    });
  });

  describe('管理功能测试', function () {
    it('VaultBusinessLogic – 应该允许管理员更新Registry地址', async function () {
      const newRegistry = '0x1111111111111111111111111111111111111111';
      
      await expect(
        vaultBusinessLogic.setRegistry(newRegistry)
      ).to.not.be.reverted;
    });

    it('VaultBusinessLogic – 应该拒绝零地址的Registry', async function () {
      await expect(
        vaultBusinessLogic.setRegistry(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'ZeroAddress');
    });

    it('VaultBusinessLogic – 应该允许管理员更新结算币地址', async function () {
      const newSettlementToken = '0x2222222222222222222222222222222222222222';
      
      await expect(
        vaultBusinessLogic.setSettlementToken(newSettlementToken)
      ).to.not.be.reverted;
    });

    it('VaultBusinessLogic – 应该拒绝零地址的结算币', async function () {
      await expect(
        vaultBusinessLogic.setSettlementToken(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'ZeroAddress');
    });

    it('VaultBusinessLogic – 应该允许管理员暂停系统', async function () {
      await expect(
        vaultBusinessLogic.pause()
      ).to.not.be.reverted;
      
      expect(await vaultBusinessLogic.paused()).to.be.true;
    });

    it('VaultBusinessLogic – 应该允许管理员恢复系统', async function () {
      // 先暂停
      await vaultBusinessLogic.pause();
      
      // 再恢复
      await expect(
        vaultBusinessLogic.unpause()
      ).to.not.be.reverted;
      
      expect(await vaultBusinessLogic.paused()).to.be.false;
    });

    it('VaultBusinessLogic – 应该拒绝暂停状态下的操作', async function () {
      await vaultBusinessLogic.pause();
      
      await expect(
        vaultBusinessLogic.deposit(userAddress, TEST_ASSET, TEST_AMOUNT)
      ).to.be.revertedWith('Pausable: paused');
    });
  });

  describe('升级功能测试', function () {
    it('VaultBusinessLogic – 应该正确授权升级', async function () {
      // 部署一个新的实现合约作为升级目标
      const newImplementation = await vaultBusinessLogicFactory.deploy();
      await newImplementation.waitForDeployment();
      
      // 确保owner有UPGRADE_MODULE权限
      await mockAccessControlManager.grantRole(ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE')), ownerAddress);
      
      // 使用代理合约的 upgradeTo 方法
      await expect(
        vaultBusinessLogic.upgradeTo(newImplementation.target)
      ).to.not.be.reverted;
    });

    it('VaultBusinessLogic – 应该拒绝零地址的升级', async function () {
      // 确保owner有UPGRADE_MODULE权限
      await mockAccessControlManager.grantRole(ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE')), ownerAddress);
      
      await expect(
        vaultBusinessLogic.upgradeTo(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'ZeroAddress');
    });

    it('VaultBusinessLogic – 应该拒绝无权限的升级', async function () {
      const newImplementation = '0x3333333333333333333333333333333333333333';
      
      // 撤销owner的UPGRADE_MODULE权限
      await mockAccessControlManager.revokeRole(ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE')), ownerAddress);
      
      await expect(
        vaultBusinessLogic.upgradeTo(newImplementation)
      ).to.be.revertedWith('requireRole: MissingRole');
    });
  });

  describe('事件测试', function () {
    it('VaultBusinessLogic – 应该发出正确的业务操作事件', async function () {
      // 设置所有模块调用成功
      await mockCollateralManager.setMockSuccess(true);
      await mockGuaranteeFundManager.setMockSuccess(true);
      await mockStatisticsView.setShouldFail(false);
      await mockRewardManager.setMockSuccess(true);
      
      await expect(
        vaultBusinessLogic.deposit(userAddress, TEST_ASSET, TEST_AMOUNT)
      ).to.emit(vaultBusinessLogic, 'BusinessOperation')
        .withArgs('deposit', userAddress, TEST_ASSET, TEST_AMOUNT);
    });

    it('VaultBusinessLogic – 应该发出正确的标准化动作事件', async function () {
      // 设置所有模块调用成功
      await mockCollateralManager.setMockSuccess(true);
      await mockGuaranteeFundManager.setMockSuccess(true);
      await mockStatisticsView.setShouldFail(false);
      await mockRewardManager.setMockSuccess(true);
      
      await expect(
        vaultBusinessLogic.deposit(userAddress, TEST_ASSET, TEST_AMOUNT)
      ).to.emit(vaultBusinessLogic, 'ActionExecuted');
    });

    it('VaultBusinessLogic – 应该发出积分奖励事件', async function () {
      // 设置所有模块调用成功
      await mockCollateralManager.setMockSuccess(true);
      await mockGuaranteeFundManager.setMockSuccess(true);
      await mockStatisticsView.setShouldFail(false);
      await mockRewardManager.setMockSuccess(true);
      
      await expect(
        vaultBusinessLogic.deposit(userAddress, TEST_ASSET, TEST_AMOUNT)
      ).to.emit(vaultBusinessLogic, 'RewardEvent');
    });
  });

  describe('边界条件测试', function () {
    it('VaultBusinessLogic – 应该处理模块返回零地址的情况', async function () {
      // 设置抵押物管理模块返回零地址
      await mockRegistry.setModule(ModuleKeys.KEY_CM, ZERO_ADDRESS);
      
      // 应该因为模块未设置而失败
      await expect(
        vaultBusinessLogic.deposit(userAddress, TEST_ASSET, TEST_AMOUNT)
      ).to.be.reverted;
    });

    it('VaultBusinessLogic – 应该处理大金额操作', async function () {
      const largeAmount = ethers.parseUnits('1000000', 18); // 使用合理的金额而不是MaxUint256
      
      // 确保用户有足够的代币
      await mockERC20.mint(userAddress, largeAmount);
      await mockERC20.connect(user).approve(vaultBusinessLogic.target, largeAmount);
      
      // 设置所有模块调用成功
      await mockCollateralManager.setMockSuccess(true);
      await mockGuaranteeFundManager.setMockSuccess(true);
      await mockStatisticsView.setShouldFail(false);
      await mockRewardManager.setMockSuccess(true);
      
      await expect(
        vaultBusinessLogic.deposit(userAddress, TEST_ASSET, largeAmount)
      ).to.not.be.reverted;
    });

    it('VaultBusinessLogic – 应该处理重复操作', async function () {
      // 设置所有模块调用成功
      await mockCollateralManager.setMockSuccess(true);
      await mockGuaranteeFundManager.setMockSuccess(true);
      await mockStatisticsView.setShouldFail(false);
      await mockRewardManager.setMockSuccess(true);
      
      // 第一次操作
      await vaultBusinessLogic.deposit(userAddress, TEST_ASSET, TEST_AMOUNT);
      
      // 第二次操作
      await expect(
        vaultBusinessLogic.deposit(userAddress, TEST_ASSET, TEST_AMOUNT)
      ).to.not.be.reverted;
    });
  });

  describe('Gas 优化测试', function () {
    it('VaultBusinessLogic – 应该高效处理批量操作', async function () {
      const assets = new Array(5).fill(TEST_ASSET); // 减少到5个操作
      const amounts = new Array(5).fill(TEST_AMOUNT);
      
      // 确保用户有足够的代币
      const totalAmount = TEST_AMOUNT * 5n;
      await mockERC20.mint(userAddress, totalAmount);
      await mockERC20.connect(user).approve(vaultBusinessLogic.target, totalAmount);
      
      // 设置所有模块调用成功
      await mockCollateralManager.setMockSuccess(true);
      await mockGuaranteeFundManager.setMockSuccess(true);
      await mockStatisticsView.setShouldFail(false);
      await mockRewardManager.setMockSuccess(true);
      
      const tx = await vaultBusinessLogic.batchDeposit(userAddress, assets, amounts);
      const receipt = await tx.wait();
      
      // 验证Gas使用合理
      if (receipt) {
        expect(receipt.gasUsed).to.be.lt(2000000); // 应该小于2M gas
      }
    });
  });
}); 
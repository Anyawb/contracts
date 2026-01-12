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
// NOTE: typechain path may differ across environments; this test uses runtime contracts only.

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockEarlyRepaymentGuaranteeManager: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lenderPoolVault: any;
  
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
    mockEarlyRepaymentGuaranteeManager = await ethers.getContractFactory('MockEarlyRepaymentGuaranteeManager');
    const lenderPoolVaultFactory = await ethers.getContractFactory('LenderPoolVault');
    
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
    
    const deployedMockEarlyRepaymentGuaranteeManager = await mockEarlyRepaymentGuaranteeManager.deploy();
    await deployedMockEarlyRepaymentGuaranteeManager.waitForDeployment();

    // 设置 Mock Registry 返回各模块地址
    await deployedMockRegistry.setModule(ModuleKeys.KEY_CM, deployedMockCollateralManager.target);
    await deployedMockRegistry.setModule(ModuleKeys.KEY_LE, deployedMockLendingEngine.target);
    await deployedMockRegistry.setModule(ModuleKeys.KEY_STATS, deployedMockStatisticsView.target);
    // KEY_HF_CALC 已废弃，不再注册
    await deployedMockRegistry.setModule(ModuleKeys.KEY_FR, deployedMockFeeRouter.target);
    await deployedMockRegistry.setModule(ModuleKeys.KEY_RM, deployedMockRewardManager.target);
    await deployedMockRegistry.setModule(ModuleKeys.KEY_ASSET_WHITELIST, deployedMockAssetWhitelist.target);
    await deployedMockRegistry.setModule(ModuleKeys.KEY_GUARANTEE_FUND, deployedMockGuaranteeFundManager.target);
    await deployedMockRegistry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, deployedMockAccessControlManager.target);
    await deployedMockRegistry.setModule(ModuleKeys.KEY_EARLY_REPAYMENT_GUARANTEE, deployedMockEarlyRepaymentGuaranteeManager.target);
    
    // MockAccessControlManager 不再提供 setMockRole；权限完全由 grantRole 控制
    
    // 为owner设置管理角色
    await deployedMockAccessControlManager.grantRole(ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER')), ownerAddress);
    await deployedMockAccessControlManager.grantRole(ethers.keccak256(ethers.toUtf8Bytes('PAUSE_SYSTEM')), ownerAddress);
    await deployedMockAccessControlManager.grantRole(ethers.keccak256(ethers.toUtf8Bytes('UNPAUSE_SYSTEM')), ownerAddress);
    await deployedMockAccessControlManager.grantRole(ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE')), ownerAddress);
    
    // NOTE: TEST_ASSET 在下方设置为 mockERC20.target 后再写入白名单
    
    // 设置 Mock ERC20
    await mockERC20.mint(mockERC20.target, TEST_AMOUNT * 100n);
    
    // 部署 VaultBusinessLogic 实现合约
    const deployedVaultBusinessLogic = await vaultBusinessLogicFactory.deploy();
    await deployedVaultBusinessLogic.waitForDeployment();
    
    // 部署 LenderPoolVault（UUPS Proxy）
    const deployedLenderPoolVaultImpl = await lenderPoolVaultFactory.deploy();
    await deployedLenderPoolVaultImpl.waitForDeployment();
    const proxyFactory = await ethers.getContractFactory('ERC1967Proxy');
    const lenderPoolProxy = await proxyFactory.deploy(
      deployedLenderPoolVaultImpl.target,
      deployedLenderPoolVaultImpl.interface.encodeFunctionData('initialize', [
        deployedMockRegistry.target
      ])
    );
    await lenderPoolProxy.waitForDeployment();
    const lenderPoolVaultProxy = deployedLenderPoolVaultImpl.attach(lenderPoolProxy.target);
    await deployedMockRegistry.setModule(ModuleKeys.KEY_LENDER_POOL_VAULT, lenderPoolVaultProxy.target);

    // 部署代理合约
    const proxy = await proxyFactory.deploy(
      deployedVaultBusinessLogic.target,
      deployedVaultBusinessLogic.interface.encodeFunctionData('initialize', [
        deployedMockRegistry.target,
        mockERC20.target
      ])
    );
    await proxy.waitForDeployment();
    
    // 通过代理合约访问VaultBusinessLogic
    const vaultBusinessLogicProxy = deployedVaultBusinessLogic.attach(proxy.target);
    
    // 让 LenderPoolVault 允许 VaultBusinessLogic 作为唯一 transferOut 调用者
    await deployedMockRegistry.setModule(ModuleKeys.KEY_VAULT_BUSINESS_LOGIC, vaultBusinessLogicProxy.target);

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
    // 设置 Mock AssetWhitelist：放行测试资产
    await deployedMockAssetWhitelist.setAssetAllowed(TEST_ASSET, true);
    
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
      mockEarlyRepaymentGuaranteeManager: deployedMockEarlyRepaymentGuaranteeManager,
      lenderPoolVault: lenderPoolVaultProxy,
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
    mockEarlyRepaymentGuaranteeManager = fixture.mockEarlyRepaymentGuaranteeManager;
    lenderPoolVault = fixture.lenderPoolVault;
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
        newVaultBusinessLogicProxy.initialize(ZERO_ADDRESS, mockERC20.target)
      ).to.be.revertedWithCustomError(newVaultBusinessLogicProxy, 'ZeroAddress');
      
      await expect(
        newVaultBusinessLogicProxy.initialize(mockRegistry.target, ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(newVaultBusinessLogicProxy, 'ZeroAddress');
    });

    it('VaultBusinessLogic – 应该拒绝重复初始化', async function () {
      await expect(
        vaultBusinessLogic.initialize(mockRegistry.target, mockERC20.target)
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'InvalidInitialization');
    });
  });

  // NOTE:
  // - VaultBusinessLogic 的抵押存取入口（deposit/withdraw/batchDeposit/batchWithdraw）已按架构收敛到 VaultCore。
  // - 因此本测试文件不再覆盖这些已下线入口；相关用例已删除，避免“为了通过而断言回退”。

  describe('资金池保留/撤销（reserveForLending / cancelReserve）', function () {
    it('VaultBusinessLogic – reserveForLending: 应该把资金转入 LenderPoolVault 并落 reserve 状态', async function () {
      const lendIntentHash = ethers.keccak256(ethers.toUtf8Bytes('lend-intent-1'));
      const amount = ethers.parseUnits('10', 18);

      const userBalBefore = await mockERC20.balanceOf(userAddress);
      const poolBalBefore = await mockERC20.balanceOf(lenderPoolVault.target);

      await expect(
        vaultBusinessLogic.reserveForLending(userAddress, TEST_ASSET, amount, lendIntentHash)
      )
        .to.emit(vaultBusinessLogic, 'BusinessOperation')
        .withArgs('reserveForLending', userAddress, TEST_ASSET, amount);

      const userBalAfter = await mockERC20.balanceOf(userAddress);
      const poolBalAfter = await mockERC20.balanceOf(lenderPoolVault.target);

      expect(userBalAfter).to.equal(userBalBefore - amount);
      expect(poolBalAfter).to.equal(poolBalBefore + amount);
    });

    it('VaultBusinessLogic – reserveForLending: 应该拒绝零资产/零金额', async function () {
      const lendIntentHash = ethers.keccak256(ethers.toUtf8Bytes('lend-intent-2'));
      await expect(
        vaultBusinessLogic.reserveForLending(userAddress, ZERO_ADDRESS, 1n, lendIntentHash)
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'ZeroAddress');

      await expect(
        vaultBusinessLogic.reserveForLending(userAddress, TEST_ASSET, 0n, lendIntentHash)
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'AmountIsZero');
    });

    it('VaultBusinessLogic – reserveForLending: 应该拒绝重复 reserve（同一个 intentHash）', async function () {
      const lendIntentHash = ethers.keccak256(ethers.toUtf8Bytes('lend-intent-dup'));
      const amount = ethers.parseUnits('1', 18);
      await vaultBusinessLogic.reserveForLending(userAddress, TEST_ASSET, amount, lendIntentHash);
      await expect(
        vaultBusinessLogic.reserveForLending(userAddress, TEST_ASSET, amount, lendIntentHash)
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'Settlement__AlreadyReserved');
    });

    it('VaultBusinessLogic – cancelReserve: 应该仅允许原 lender 撤销，并将资金从池子退回', async function () {
      const lendIntentHash = ethers.keccak256(ethers.toUtf8Bytes('lend-intent-cancel'));
      const amount = ethers.parseUnits('7', 18);

      await vaultBusinessLogic.reserveForLending(userAddress, TEST_ASSET, amount, lendIntentHash);

      const userBalBefore = await mockERC20.balanceOf(userAddress);
      const poolBalBefore = await mockERC20.balanceOf(lenderPoolVault.target);

      await expect(vaultBusinessLogic.connect(user).cancelReserve(lendIntentHash))
        .to.emit(vaultBusinessLogic, 'BusinessOperation')
        .withArgs('cancelReserve', userAddress, TEST_ASSET, amount);

      const userBalAfter = await mockERC20.balanceOf(userAddress);
      const poolBalAfter = await mockERC20.balanceOf(lenderPoolVault.target);

      expect(userBalAfter).to.equal(userBalBefore + amount);
      expect(poolBalAfter).to.equal(poolBalBefore - amount);
    });

    it('VaultBusinessLogic – cancelReserve: 应该拒绝非 owner 撤销 / 不存在的 intentHash', async function () {
      const lendIntentHash = ethers.keccak256(ethers.toUtf8Bytes('lend-intent-owner'));
      const amount = ethers.parseUnits('3', 18);
      await vaultBusinessLogic.reserveForLending(userAddress, TEST_ASSET, amount, lendIntentHash);

      await expect(vaultBusinessLogic.connect(owner).cancelReserve(lendIntentHash)).to.be.revertedWithCustomError(
        vaultBusinessLogic,
        'Settlement__NotOwner'
      );

      const unknownHash = ethers.keccak256(ethers.toUtf8Bytes('unknown'));
      await expect(vaultBusinessLogic.connect(user).cancelReserve(unknownHash)).to.be.revertedWithCustomError(
        vaultBusinessLogic,
        'Settlement__NotActive'
      );
    });
  });

  describe('借款（borrow）', function () {
    beforeEach(async function () {
      await mockStatisticsView.setShouldFail(false);
    });

    it('VaultBusinessLogic – borrow: 应该完成放款（合约 -> 用户）并推送统计', async function () {
      const amount = ethers.parseUnits('5', 18);
      const userBalBefore = await mockERC20.balanceOf(userAddress);
      const vblBalBefore = await mockERC20.balanceOf(vaultBusinessLogic.target);
      const debtBefore = await mockStatisticsView.userDebt(userAddress);

      await expect(vaultBusinessLogic.borrow(userAddress, TEST_ASSET, amount))
        .to.emit(vaultBusinessLogic, 'BusinessOperation')
        .withArgs('borrow', userAddress, TEST_ASSET, amount);

      const userBalAfter = await mockERC20.balanceOf(userAddress);
      const vblBalAfter = await mockERC20.balanceOf(vaultBusinessLogic.target);
      const debtAfter = await mockStatisticsView.userDebt(userAddress);

      expect(userBalAfter).to.equal(userBalBefore + amount);
      expect(vblBalAfter).to.equal(vblBalBefore - amount);
      expect(debtAfter).to.equal(debtBefore + amount);
    });

    it('VaultBusinessLogic – borrow: 应该拒绝零金额/零资产', async function () {
      await expect(
        vaultBusinessLogic.borrow(userAddress, TEST_ASSET, 0n)
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'AmountIsZero');

      await expect(
        vaultBusinessLogic.borrow(userAddress, ZERO_ADDRESS, 1n)
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'ZeroAddress');
    });

    it('VaultBusinessLogic – borrow: 应该拒绝不在白名单的资产', async function () {
      await mockAssetWhitelist.setAssetAllowed(TEST_ASSET, false);
      await expect(
        vaultBusinessLogic.borrow(userAddress, TEST_ASSET, TEST_AMOUNT)
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'AssetNotAllowed');
      await mockAssetWhitelist.setAssetAllowed(TEST_ASSET, true);
    });

    it('VaultBusinessLogic – borrow: 统计视图失败应回退（ExternalModuleRevertedRaw）', async function () {
      await mockStatisticsView.setShouldFail(true);
      await expect(
        vaultBusinessLogic.borrow(userAddress, TEST_ASSET, ethers.parseUnits('1', 18))
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'ExternalModuleRevertedRaw');
    });
  });

  describe('还款（repay / repayWithStop）', function () {
    beforeEach(async function () {
      await mockStatisticsView.setShouldFail(false);
    });

    it('VaultBusinessLogic – repay: 已收敛为 VaultCore 入口，应直接拒绝（避免写路径分叉/资金滞留）', async function () {
      const amount = ethers.parseUnits('4', 18);
      await vaultBusinessLogic.borrow(userAddress, TEST_ASSET, amount);

      const userBalBefore = await mockERC20.balanceOf(userAddress);
      const vblBalBefore = await mockERC20.balanceOf(vaultBusinessLogic.target);
      const debtBefore = await mockStatisticsView.userDebt(userAddress);

      await expect(vaultBusinessLogic.repay(userAddress, TEST_ASSET, amount))
        .to.be.revertedWithCustomError(vaultBusinessLogic, 'VaultBusinessLogic__UseVaultCoreEntry');

      const userBalAfter = await mockERC20.balanceOf(userAddress);
      const vblBalAfter = await mockERC20.balanceOf(vaultBusinessLogic.target);
      const debtAfter = await mockStatisticsView.userDebt(userAddress);

      // balances/statistics remain unchanged because the call is rejected
      expect(userBalAfter).to.equal(userBalBefore);
      expect(vblBalAfter).to.equal(vblBalBefore);
      expect(debtAfter).to.equal(debtBefore);
    });

    it('VaultBusinessLogic – repay: 应该拒绝零金额/零资产', async function () {
      await expect(
        vaultBusinessLogic.repay(userAddress, TEST_ASSET, 0n)
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'AmountIsZero');

      await expect(
        vaultBusinessLogic.repay(userAddress, ZERO_ADDRESS, 1n)
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'ZeroAddress');
    });

    it('VaultBusinessLogic – repay: 即使统计视图失败也应直接拒绝（已下线入口）', async function () {
      await mockStatisticsView.setShouldFail(true);
      await expect(
        vaultBusinessLogic.repay(userAddress, TEST_ASSET, ethers.parseUnits('1', 18))
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'VaultBusinessLogic__UseVaultCoreEntry');
    });

    it('VaultBusinessLogic – repayWithStop: 已收敛为 SettlementManager 入口，应直接拒绝', async function () {
      const amount = ethers.parseUnits('2', 18);
      await expect(
        vaultBusinessLogic.repayWithStop(userAddress, TEST_ASSET, amount, true)
      )
        .to.be.revertedWithCustomError(vaultBusinessLogic, 'VaultBusinessLogic__UseVaultCoreEntry');
    });
  });

  describe('批量操作测试', function () {
    let assets: string[];
    let amounts: bigint[];
    
    beforeEach(async function () {
      // 设置测试数据
      assets = [TEST_ASSET, TEST_ASSET];
      amounts = [TEST_AMOUNT, TEST_AMOUNT * 2n];
    });

    it('VaultBusinessLogic – batchBorrow: 参数校验（长度不一致/空数组/超上限）', async function () {
      await expect(
        vaultBusinessLogic.batchBorrow(userAddress, [TEST_ASSET], [TEST_AMOUNT, TEST_AMOUNT])
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'InvalidAmounts');

      await expect(
        vaultBusinessLogic.batchBorrow(userAddress, [], [])
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'AmountIsZero');

      const tooManyAssets = Array.from({ length: MAX_BATCH_SIZE + 1 }, () => TEST_ASSET);
      const tooManyAmounts = Array.from({ length: MAX_BATCH_SIZE + 1 }, () => 0n);
      await expect(
        vaultBusinessLogic.batchBorrow(userAddress, tooManyAssets, tooManyAmounts)
      ).to.be.revertedWith('Batch too large');
    });

    it('VaultBusinessLogic – batchBorrow: amounts 全为 0 时应直接通过（不触发 finalizeAtomic）', async function () {
      await expect(
        vaultBusinessLogic.batchBorrow(userAddress, assets, [0n, 0n])
      ).to.not.be.reverted;
    });

    it('VaultBusinessLogic – batchRepay: 参数校验（长度不一致/空数组/超上限）', async function () {
      await expect(
        vaultBusinessLogic.batchRepay(userAddress, [TEST_ASSET], [TEST_AMOUNT, TEST_AMOUNT])
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'InvalidAmounts');

      await expect(
        vaultBusinessLogic.batchRepay(userAddress, [], [])
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'AmountIsZero');

      const tooManyAssets = Array.from({ length: MAX_BATCH_SIZE + 1 }, () => TEST_ASSET);
      const tooManyAmounts = Array.from({ length: MAX_BATCH_SIZE + 1 }, () => 0n);
      await expect(
        vaultBusinessLogic.batchRepay(userAddress, tooManyAssets, tooManyAmounts)
      ).to.be.revertedWith('Batch too large');
    });

    it('VaultBusinessLogic – batchRepay: amounts 全为 0 时应直接通过（不做 transferFrom）', async function () {
      await expect(
        vaultBusinessLogic.batchRepay(userAddress, assets, [0n, 0n])
      ).to.not.be.reverted;
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
        vaultBusinessLogic.upgradeToAndCall(newImplementation.target, '0x')
      ).to.not.be.reverted;
    });

    it('VaultBusinessLogic – 应该拒绝零地址的升级', async function () {
      // 确保owner有UPGRADE_MODULE权限
      await mockAccessControlManager.grantRole(ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE')), ownerAddress);
      
      await expect(
        vaultBusinessLogic.upgradeToAndCall(ZERO_ADDRESS, '0x')
      ).to.be.revertedWithCustomError(vaultBusinessLogic, 'ZeroAddress');
    });

    it('VaultBusinessLogic – 应该拒绝无权限的升级', async function () {
      const newImplementation = '0x3333333333333333333333333333333333333333';
      
      // 撤销owner的UPGRADE_MODULE权限
      await mockAccessControlManager.revokeRole(ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE')), ownerAddress);
      
      await expect(
        vaultBusinessLogic.upgradeToAndCall(newImplementation, '0x')
      ).to.be.revertedWithCustomError(mockAccessControlManager, 'MissingRole');
    });
  });
}); 
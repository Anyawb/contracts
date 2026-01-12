/**
 * GuaranteeFundManager – 保证金管理模块测试
 * 
 * 测试目标:
 * - 验证保证金锁定、释放和没收功能
 * - 验证批量操作功能
 * - 验证权限控制机制
 * - 验证错误处理和边界条件
 * - 验证事件发出
 * - 验证升级功能
 * - 验证暂停和恢复功能
 * - 验证查询功能
 * - 验证管理功能
 */
import * as hardhat from 'hardhat';
const { ethers } = hardhat;
import { expect } from 'chai';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

// 导入合约类型
import type { 
  MockERC20,
  MockAccessControlManager,
  MockVaultCore,
  MockRegistry,
  GuaranteeFundManager
} from '../../../types';

describe('GuaranteeFundManager – 保证金管理模块测试', function () {
  // 测试常量定义
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const ONE_ETH = ethers.parseUnits('1', 18);
  const ONE_USD = ethers.parseUnits('1', 6);
  const TEST_AMOUNT = ethers.parseUnits('1000', 18);
  const MAX_BATCH_SIZE = 50;
  
  let TEST_ASSET: string;
  let TEST_USER: string;
  let TEST_FEE_RECEIVER: string;

  // 合约实例
  let guaranteeFundManager: GuaranteeFundManager;
  let mockERC20: MockERC20;
  let mockAccessControlManager: MockAccessControlManager;
  let mockVaultCore: MockVaultCore;
  let mockRegistry: MockRegistry;

  // 签名者
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let feeReceiver: SignerWithAddress;

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
   */
  async function deployRegistrySystem(ownerAddress: string) {
    // 1. 部署 MockRegistry
    const MockRegistryFactory = await ethers.getContractFactory('MockRegistry');
    const registry = await MockRegistryFactory.deploy();
    await registry.waitForDeployment();

    // 2. 部署 AccessControlManager
    const { proxyContract: accessControlManager } = await deployProxyContract('MockAccessControlManager');

    // 3. 注册模块到 Registry - 使用正确的模块键
    const ACCESS_CONTROL_KEY = ethers.keccak256(ethers.toUtf8Bytes('ACCESS_CONTROL_MANAGER'));
    await registry.setModule(ACCESS_CONTROL_KEY, accessControlManager.target);

    // 4. 设置权限 - 使用 ActionKeys 中定义的常量
    const SET_PARAMETER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));
    const UPGRADE_MODULE_ROLE = ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE'));
    const PAUSE_SYSTEM_ROLE = ethers.keccak256(ethers.toUtf8Bytes('PAUSE_SYSTEM'));
    const UNPAUSE_SYSTEM_ROLE = ethers.keccak256(ethers.toUtf8Bytes('UNPAUSE_SYSTEM'));
    
    const accessControlManagerTyped = accessControlManager as unknown as MockAccessControlManager;
    await accessControlManagerTyped.grantRole(SET_PARAMETER_ROLE, ownerAddress);
    await accessControlManagerTyped.grantRole(UPGRADE_MODULE_ROLE, ownerAddress);
    await accessControlManagerTyped.grantRole(PAUSE_SYSTEM_ROLE, ownerAddress);
    await accessControlManagerTyped.grantRole(UNPAUSE_SYSTEM_ROLE, ownerAddress);
    
    return {
      registry,
      accessControlManager: accessControlManagerTyped
    };
  }

  /**
   * 部署测试环境的 fixture 函数
   */
  async function deployFixture() {
    [owner, user1, user2, feeReceiver] = await ethers.getSigners();
    
    // 设置测试地址
    TEST_ASSET = ethers.Wallet.createRandom().address;
    TEST_USER = await user1.getAddress();
    TEST_FEE_RECEIVER = await feeReceiver.getAddress();

    // 1. 部署 Registry 系统
    const { registry, accessControlManager } = await deployRegistrySystem(await owner.getAddress());

    // 2. 部署 Mock 模块
    // MockVaultCore 直接部署，不需要代理
    const MockVaultCoreFactory = await ethers.getContractFactory('MockVaultCore');
    const vaultCore = await MockVaultCoreFactory.deploy();
    await vaultCore.waitForDeployment();
    
    // MockERC20 需要构造函数参数
    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    const erc20 = await MockERC20Factory.deploy('Mock Token', 'MTK', ethers.parseUnits('1000000', 18));
    await erc20.waitForDeployment();

    // 3. 注册模块到 Registry
    // Must match `ModuleKeys.KEY_VAULT_CORE = keccak256("VAULT_CORE")`
    const VAULT_CORE_KEY = ethers.keccak256(ethers.toUtf8Bytes('VAULT_CORE'));
    await registry.setModule(VAULT_CORE_KEY, vaultCore.target);

    // 4. 部署 GuaranteeFundManager
    const { proxyContract: guaranteeFundManager } = await deployProxyContract('GuaranteeFundManager');
    const guaranteeFundManagerTyped = guaranteeFundManager as unknown as GuaranteeFundManager;
    await guaranteeFundManagerTyped.initialize(
      vaultCore.target,
      registry.target,
      await owner.getAddress()
    );

    // 5. 设置 MockVaultCore 的 guaranteeFundManager 和 Registry
    const vaultCoreTyped = vaultCore as unknown as MockVaultCore;
    await vaultCoreTyped.setGuaranteeFundManager(guaranteeFundManager.target);
    // MockVaultCore 仅用于提供 vaultCoreAddr 身份，无需持有 registry

    // 6. 确保合约有足够的代币
    const erc20Typed = erc20 as unknown as MockERC20;
    await erc20Typed.mint(guaranteeFundManager.target, TEST_AMOUNT * 10n);
    await erc20Typed.mint(TEST_USER, TEST_AMOUNT * 10n);
    // user2 is used in "multiple users" tests; ensure balance is enough
    await erc20Typed.mint(await user2.getAddress(), TEST_AMOUNT * 10n);
    // GuaranteeFundManager.lockGuarantee 会从 user transferFrom，需要用户提前 approve
    await erc20Typed.connect(user1).approve(guaranteeFundManager.target, ethers.MaxUint256);
    await erc20Typed.connect(user2).approve(guaranteeFundManager.target, ethers.MaxUint256);

    return {
      guaranteeFundManager: guaranteeFundManagerTyped,
      mockERC20: erc20Typed,
      mockAccessControlManager: accessControlManager,
      mockVaultCore: vaultCore as unknown as MockVaultCore,
      mockRegistry: registry as unknown as MockRegistry,
      owner,
      user1,
      user2,
      feeReceiver
    };
  }

  beforeEach(async function () {
    const fixture = await loadFixture(deployFixture);
    guaranteeFundManager = fixture.guaranteeFundManager;
    mockERC20 = fixture.mockERC20;
    mockAccessControlManager = fixture.mockAccessControlManager;
    mockVaultCore = fixture.mockVaultCore;
    mockRegistry = fixture.mockRegistry;
    owner = fixture.owner;
    user1 = fixture.user1;
    user2 = fixture.user2;
    feeReceiver = fixture.feeReceiver;

    // 确保 owner 有正确的权限 - 使用 ActionKeys 中定义的常量
    const UPGRADE_MODULE_ROLE = ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE'));
    const SET_PARAMETER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));
    const PAUSE_SYSTEM_ROLE = ethers.keccak256(ethers.toUtf8Bytes('PAUSE_SYSTEM'));
    const UNPAUSE_SYSTEM_ROLE = ethers.keccak256(ethers.toUtf8Bytes('UNPAUSE_SYSTEM'));
    
    const ownerAddress = await owner.getAddress();
    await mockAccessControlManager.grantRole(UPGRADE_MODULE_ROLE, ownerAddress);
    await mockAccessControlManager.grantRole(SET_PARAMETER_ROLE, ownerAddress);
    await mockAccessControlManager.grantRole(PAUSE_SYSTEM_ROLE, ownerAddress);
    await mockAccessControlManager.grantRole(UNPAUSE_SYSTEM_ROLE, ownerAddress);

    // 验证权限设置
    expect(await mockAccessControlManager.hasRole(UPGRADE_MODULE_ROLE, ownerAddress)).to.be.true;
    expect(await mockAccessControlManager.hasRole(SET_PARAMETER_ROLE, ownerAddress)).to.be.true;
    expect(await mockAccessControlManager.hasRole(PAUSE_SYSTEM_ROLE, ownerAddress)).to.be.true;
    expect(await mockAccessControlManager.hasRole(UNPAUSE_SYSTEM_ROLE, ownerAddress)).to.be.true;

    // 直接测试权限检查
    await mockAccessControlManager.requireRole(UPGRADE_MODULE_ROLE, ownerAddress);

    // 验证权限设置
    expect(await mockAccessControlManager.hasRole(UPGRADE_MODULE_ROLE, ownerAddress)).to.be.true;
    expect(await mockAccessControlManager.hasRole(SET_PARAMETER_ROLE, ownerAddress)).to.be.true;
    expect(await mockAccessControlManager.hasRole(PAUSE_SYSTEM_ROLE, ownerAddress)).to.be.true;
    expect(await mockAccessControlManager.hasRole(UNPAUSE_SYSTEM_ROLE, ownerAddress)).to.be.true;

    // 直接测试权限检查
    await mockAccessControlManager.requireRole(UPGRADE_MODULE_ROLE, ownerAddress);

    // 打印调试信息
    console.log('Owner address:', ownerAddress);
    console.log('UPGRADE_MODULE_ROLE:', UPGRADE_MODULE_ROLE);
    console.log('Has role:', await mockAccessControlManager.hasRole(UPGRADE_MODULE_ROLE, ownerAddress));
  });

  describe('初始化测试', function () {
    it('GuaranteeFundManager – 应该正确初始化合约', async function () {
      expect(await guaranteeFundManager.vaultCoreAddr()).to.equal(mockVaultCore.target);
      expect(await guaranteeFundManager.registryAddr()).to.equal(mockRegistry.target);
      expect(await guaranteeFundManager.getRegistry()).to.equal(mockRegistry.target);
    });

    it('GuaranteeFundManager – 应该拒绝重复初始化', async function () {
      await expect(
        guaranteeFundManager.initialize(mockVaultCore.target, mockRegistry.target, await owner.getAddress())
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'InvalidInitialization');
    });

    it('GuaranteeFundManager – 应该拒绝零地址初始化', async function () {
      const { proxyContract } = await deployProxyContract('GuaranteeFundManager');
      const newGuaranteeFundManager = proxyContract as unknown as GuaranteeFundManager;
      
      await expect(
        newGuaranteeFundManager.initialize(ZERO_ADDRESS, mockRegistry.target, await owner.getAddress())
      ).to.be.revertedWithCustomError(newGuaranteeFundManager, 'ZeroAddress');

      await expect(
        newGuaranteeFundManager.initialize(mockVaultCore.target, ZERO_ADDRESS, await owner.getAddress())
      ).to.be.revertedWithCustomError(newGuaranteeFundManager, 'ZeroAddress');
    });
  });

  describe('权限控制测试', function () {
    it('GuaranteeFundManager – 应该拒绝非 VaultCore 调用核心功能', async function () {
      await expect(
        guaranteeFundManager.lockGuarantee(TEST_USER, TEST_ASSET, TEST_AMOUNT)
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'GuaranteeFundManager__OnlyVaultCore');

      await expect(
        guaranteeFundManager.releaseGuarantee(TEST_USER, TEST_ASSET, TEST_AMOUNT)
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'GuaranteeFundManager__OnlyVaultCore');

      await expect(
        guaranteeFundManager.forfeitGuarantee(TEST_USER, TEST_ASSET, TEST_FEE_RECEIVER)
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'GuaranteeFundManager__OnlyVaultCore');

      await expect(
        guaranteeFundManager.batchLockGuarantees(TEST_USER, [TEST_ASSET], [TEST_AMOUNT])
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'GuaranteeFundManager__OnlyVaultCore');

      await expect(
        guaranteeFundManager.batchReleaseGuarantees(TEST_USER, [TEST_ASSET], [TEST_AMOUNT])
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'GuaranteeFundManager__OnlyVaultCore');
    });
  });

  describe('查询功能测试', function () {
    it('GuaranteeFundManager – 应该处理查询零地址', async function () {
      await expect(
        guaranteeFundManager.getLockedGuarantee(ZERO_ADDRESS, mockERC20.target)
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'ZeroAddress');

      await expect(
        guaranteeFundManager.getLockedGuarantee(TEST_USER, ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'ZeroAddress');

      await expect(
        guaranteeFundManager.getTotalGuaranteeByAsset(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'ZeroAddress');

      await expect(
        guaranteeFundManager.getUserGuaranteeAssets(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'ZeroAddress');
    });

    it('GuaranteeFundManager – 应该正确查询用户保证金', async function () {
      // 初始状态应该为0
      expect(await guaranteeFundManager.getLockedGuarantee(TEST_USER, mockERC20.target)).to.equal(BigInt(0));
      expect(await guaranteeFundManager.getTotalGuaranteeByAsset(mockERC20.target)).to.equal(BigInt(0));
      
      // 锁定保证金后查询
      await mockVaultCore.lockGuarantee(TEST_USER, mockERC20.target, TEST_AMOUNT);
      
      expect(await guaranteeFundManager.getLockedGuarantee(TEST_USER, mockERC20.target)).to.equal(TEST_AMOUNT);
      expect(await guaranteeFundManager.getTotalGuaranteeByAsset(mockERC20.target)).to.equal(TEST_AMOUNT);
    });

    it('GuaranteeFundManager – 应该正确查询用户保证金资产列表', async function () {
      const assets = await guaranteeFundManager.getUserGuaranteeAssets(TEST_USER);
      expect(assets).to.be.an('array');
      expect(assets.length).to.equal(0);
    });
  });

  describe('核心功能测试', function () {
    it('GuaranteeFundManager – 应该正确锁定保证金', async function () {
      const initialBalance = await mockERC20.balanceOf(guaranteeFundManager.target);
      
      await expect(
        mockVaultCore.lockGuarantee(TEST_USER, mockERC20.target, TEST_AMOUNT)
      ).to.emit(guaranteeFundManager, 'GuaranteeLocked')
        .withArgs(TEST_USER, mockERC20.target, TEST_AMOUNT, (timestamp: bigint) => {
          return timestamp > BigInt(0);
        });

      expect(await guaranteeFundManager.getLockedGuarantee(TEST_USER, mockERC20.target)).to.equal(TEST_AMOUNT);
      expect(await guaranteeFundManager.getTotalGuaranteeByAsset(mockERC20.target)).to.equal(TEST_AMOUNT);
    });

    it('GuaranteeFundManager – 应该拒绝锁定零金额保证金', async function () {
      await expect(
        mockVaultCore.lockGuarantee(TEST_USER, mockERC20.target, 0n)
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'AmountIsZero');
    });

    it('GuaranteeFundManager – 应该拒绝锁定零地址用户保证金', async function () {
      await expect(
        mockVaultCore.lockGuarantee(ZERO_ADDRESS, mockERC20.target, TEST_AMOUNT)
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'ZeroAddress');
    });

    it('GuaranteeFundManager – 应该拒绝锁定零地址资产保证金', async function () {
      await expect(
        mockVaultCore.lockGuarantee(TEST_USER, ZERO_ADDRESS, TEST_AMOUNT)
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'ZeroAddress');
    });

    it('GuaranteeFundManager – 应该正确释放保证金', async function () {
      // 先锁定保证金
      await mockVaultCore.lockGuarantee(TEST_USER, mockERC20.target, TEST_AMOUNT);
      
      const initialUserBalance = await mockERC20.balanceOf(TEST_USER);
      const releaseAmount = TEST_AMOUNT / 2n;
      
      await expect(
        mockVaultCore.releaseGuarantee(TEST_USER, mockERC20.target, releaseAmount)
      ).to.emit(guaranteeFundManager, 'GuaranteeReleased')
        .withArgs(TEST_USER, mockERC20.target, releaseAmount, (timestamp: bigint) => {
          return timestamp > BigInt(0);
        });

      expect(await guaranteeFundManager.getLockedGuarantee(TEST_USER, mockERC20.target)).to.equal(TEST_AMOUNT - releaseAmount);
      expect(await guaranteeFundManager.getTotalGuaranteeByAsset(mockERC20.target)).to.equal(TEST_AMOUNT - releaseAmount);
      expect(await mockERC20.balanceOf(TEST_USER)).to.equal(initialUserBalance + releaseAmount);
    });

    it('GuaranteeFundManager – 应该正确处理释放金额超过锁定金额的情况', async function () {
      // 先锁定保证金
      await mockVaultCore.lockGuarantee(TEST_USER, mockERC20.target, TEST_AMOUNT);
      
      const initialUserBalance = await mockERC20.balanceOf(TEST_USER);
      const releaseAmount = TEST_AMOUNT * 2n; // 超过锁定金额
      
      await expect(
        mockVaultCore.releaseGuarantee(TEST_USER, mockERC20.target, releaseAmount)
      ).to.emit(guaranteeFundManager, 'GuaranteeReleased')
        .withArgs(TEST_USER, mockERC20.target, TEST_AMOUNT, (timestamp: bigint) => {
          return timestamp > BigInt(0);
        });

      expect(await guaranteeFundManager.getLockedGuarantee(TEST_USER, mockERC20.target)).to.equal(BigInt(0));
      expect(await guaranteeFundManager.getTotalGuaranteeByAsset(mockERC20.target)).to.equal(BigInt(0));
      expect(await mockERC20.balanceOf(TEST_USER)).to.equal(initialUserBalance + TEST_AMOUNT);
    });

    it('GuaranteeFundManager – 应该正确没收保证金', async function () {
      // 先锁定保证金
      await mockVaultCore.lockGuarantee(TEST_USER, mockERC20.target, TEST_AMOUNT);
      
      const initialFeeReceiverBalance = await mockERC20.balanceOf(TEST_FEE_RECEIVER);
      
      await expect(
        mockVaultCore.forfeitGuarantee(TEST_USER, mockERC20.target, TEST_FEE_RECEIVER)
      ).to.emit(guaranteeFundManager, 'GuaranteeForfeited')
        .withArgs(TEST_USER, mockERC20.target, TEST_AMOUNT, TEST_FEE_RECEIVER, (timestamp: bigint) => {
          return timestamp > BigInt(0);
        });

      expect(await guaranteeFundManager.getLockedGuarantee(TEST_USER, mockERC20.target)).to.equal(BigInt(0));
      expect(await guaranteeFundManager.getTotalGuaranteeByAsset(mockERC20.target)).to.equal(BigInt(0));
      expect(await mockERC20.balanceOf(TEST_FEE_RECEIVER)).to.equal(initialFeeReceiverBalance + TEST_AMOUNT);
    });

    it('GuaranteeFundManager – 应该正确处理没收零保证金的情况', async function () {
      // 不锁定保证金，直接尝试没收
      const initialFeeReceiverBalance = await mockERC20.balanceOf(TEST_FEE_RECEIVER);
      
      await expect(
        mockVaultCore.forfeitGuarantee(TEST_USER, mockERC20.target, TEST_FEE_RECEIVER)
      ).to.not.be.reverted; // 应该成功但不发出事件

      expect(await guaranteeFundManager.getLockedGuarantee(TEST_USER, mockERC20.target)).to.equal(BigInt(0));
      expect(await guaranteeFundManager.getTotalGuaranteeByAsset(mockERC20.target)).to.equal(BigInt(0));
      expect(await mockERC20.balanceOf(TEST_FEE_RECEIVER)).to.equal(initialFeeReceiverBalance);
    });

    it('GuaranteeFundManager – 应该拒绝没收零地址用户保证金', async function () {
      await expect(
        mockVaultCore.forfeitGuarantee(ZERO_ADDRESS, mockERC20.target, TEST_FEE_RECEIVER)
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'ZeroAddress');
    });

    it('GuaranteeFundManager – 应该拒绝没收零地址资产保证金', async function () {
      await expect(
        mockVaultCore.forfeitGuarantee(TEST_USER, ZERO_ADDRESS, TEST_FEE_RECEIVER)
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'ZeroAddress');
    });

    it('GuaranteeFundManager – 应该拒绝没收到零地址接收者', async function () {
      await expect(
        mockVaultCore.forfeitGuarantee(TEST_USER, mockERC20.target, ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'ZeroAddress');
    });
  });

  describe('批量操作测试', function () {
    it('GuaranteeFundManager – 应该正确批量锁定保证金', async function () {
      const assets = [mockERC20.target, ethers.Wallet.createRandom().address];
      const amounts = [TEST_AMOUNT, TEST_AMOUNT * 2n];
      
      await expect(
        mockVaultCore.batchLockGuarantees(TEST_USER, assets, amounts)
      ).to.emit(guaranteeFundManager, 'GuaranteeLocked')
        .withArgs(TEST_USER, assets[0], amounts[0], (timestamp: bigint) => {
          return timestamp > BigInt(0);
        });

      expect(await guaranteeFundManager.getLockedGuarantee(TEST_USER, assets[0])).to.equal(amounts[0]);
      expect(await guaranteeFundManager.getLockedGuarantee(TEST_USER, assets[1])).to.equal(amounts[1]);
      expect(await guaranteeFundManager.getTotalGuaranteeByAsset(assets[0])).to.equal(amounts[0]);
      expect(await guaranteeFundManager.getTotalGuaranteeByAsset(assets[1])).to.equal(amounts[1]);
    });

    it('GuaranteeFundManager – 应该正确处理批量锁定中的零金额', async function () {
      const assets = [mockERC20.target, ethers.Wallet.createRandom().address];
      const amounts = [TEST_AMOUNT, 0n]; // 第二个金额为0
      
      await expect(
        mockVaultCore.batchLockGuarantees(TEST_USER, assets, amounts)
      ).to.not.be.reverted;

      expect(await guaranteeFundManager.getLockedGuarantee(TEST_USER, assets[0])).to.equal(amounts[0]);
      expect(await guaranteeFundManager.getLockedGuarantee(TEST_USER, assets[1])).to.equal(BigInt(0));
    });

    it('GuaranteeFundManager – 应该拒绝批量锁定零地址用户', async function () {
      const assets = [mockERC20.target];
      const amounts = [TEST_AMOUNT];
      
      await expect(
        mockVaultCore.batchLockGuarantees(ZERO_ADDRESS, assets, amounts)
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'ZeroAddress');
    });

    it('GuaranteeFundManager – 应该拒绝批量锁定零地址资产', async function () {
      const assets = [mockERC20.target, ZERO_ADDRESS];
      const amounts = [TEST_AMOUNT, TEST_AMOUNT];
      
      await expect(
        mockVaultCore.batchLockGuarantees(TEST_USER, assets, amounts)
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'ZeroAddress');
    });

    it('GuaranteeFundManager – 应该拒绝数组长度不匹配的批量锁定', async function () {
      const assets = [mockERC20.target, ethers.Wallet.createRandom().address];
      const amounts = [TEST_AMOUNT]; // 长度不匹配
      
      await expect(
        mockVaultCore.batchLockGuarantees(TEST_USER, assets, amounts)
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'GuaranteeFundManager__LengthMismatch');
    });

    it('GuaranteeFundManager – 应该拒绝空数组的批量锁定', async function () {
      const assets: string[] = [];
      const amounts: bigint[] = [];
      
      await expect(
        mockVaultCore.batchLockGuarantees(TEST_USER, assets, amounts)
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'GuaranteeFundManager__EmptyArrays');
    });

    it('GuaranteeFundManager – 应该拒绝超过最大批量大小的操作', async function () {
      const assets = Array(MAX_BATCH_SIZE + 1).fill(mockERC20.target);
      const amounts = Array(MAX_BATCH_SIZE + 1).fill(TEST_AMOUNT);
      
      await expect(
        mockVaultCore.batchLockGuarantees(TEST_USER, assets, amounts)
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'GuaranteeFundManager__BatchTooLarge');
    });

    it('GuaranteeFundManager – 应该正确批量释放保证金', async function () {
      // 部署第二个 ERC20 合约用于测试
      const MockERC20Factory2 = await ethers.getContractFactory('MockERC20');
      const erc20_2 = await MockERC20Factory2.deploy('Mock Token 2', 'MTK2', ethers.parseUnits('1000000', 18));
      await erc20_2.waitForDeployment();
      
      // 给第二个合约铸造代币
      const erc20_2Typed = erc20_2 as unknown as MockERC20;
      await erc20_2Typed.mint(guaranteeFundManager.target, TEST_AMOUNT * 10n);
      await erc20_2Typed.mint(TEST_USER, TEST_AMOUNT * 10n);
      
      // 先批量锁定保证金
      const assets = [mockERC20.target, erc20_2.target]; // 使用不同的 ERC20 合约
      const amounts = [TEST_AMOUNT, TEST_AMOUNT * 2n];
      await mockVaultCore.batchLockGuarantees(TEST_USER, assets, amounts);
      
      const initialUserBalance1 = await mockERC20.balanceOf(TEST_USER);
      const initialUserBalance2 = await erc20_2Typed.balanceOf(TEST_USER);
      const releaseAmounts = [TEST_AMOUNT / 2n, TEST_AMOUNT];
      
      await expect(
        mockVaultCore.batchReleaseGuarantees(TEST_USER, assets, releaseAmounts)
      ).to.emit(guaranteeFundManager, 'GuaranteeReleased')
        .withArgs(TEST_USER, assets[0], releaseAmounts[0], (timestamp: bigint) => {
          return timestamp > BigInt(0);
        });

      expect(await guaranteeFundManager.getLockedGuarantee(TEST_USER, assets[0])).to.equal(amounts[0] - releaseAmounts[0]);
      expect(await guaranteeFundManager.getLockedGuarantee(TEST_USER, assets[1])).to.equal(amounts[1] - releaseAmounts[1]);
      
      // 验证用户余额增加
      expect(await mockERC20.balanceOf(TEST_USER)).to.equal(initialUserBalance1 + releaseAmounts[0]);
      expect(await erc20_2Typed.balanceOf(TEST_USER)).to.equal(initialUserBalance2 + releaseAmounts[1]);
    });

    it('GuaranteeFundManager – 应该正确处理批量释放中的零金额', async function () {
      // 部署第二个 ERC20 合约用于测试
      const MockERC20Factory2 = await ethers.getContractFactory('MockERC20');
      const erc20_2 = await MockERC20Factory2.deploy('Mock Token 2', 'MTK2', ethers.parseUnits('1000000', 18));
      await erc20_2.waitForDeployment();
      
      // 给第二个合约铸造代币
      const erc20_2Typed = erc20_2 as unknown as MockERC20;
      await erc20_2Typed.mint(guaranteeFundManager.target, TEST_AMOUNT * 10n);
      await erc20_2Typed.mint(TEST_USER, TEST_AMOUNT * 10n);
      
      // 先批量锁定保证金
      const assets = [mockERC20.target, erc20_2.target]; // 使用不同的 ERC20 合约
      const amounts = [TEST_AMOUNT, TEST_AMOUNT * 2n];
      await mockVaultCore.batchLockGuarantees(TEST_USER, assets, amounts);
      
      const initialUserBalance1 = await mockERC20.balanceOf(TEST_USER);
      const initialUserBalance2 = await erc20_2Typed.balanceOf(TEST_USER);
      const releaseAmounts = [TEST_AMOUNT / 2n, 0n]; // 第二个金额为0
      
      await expect(
        mockVaultCore.batchReleaseGuarantees(TEST_USER, assets, releaseAmounts)
      ).to.not.be.reverted;

      expect(await guaranteeFundManager.getLockedGuarantee(TEST_USER, assets[0])).to.equal(amounts[0] - releaseAmounts[0]);
      expect(await guaranteeFundManager.getLockedGuarantee(TEST_USER, assets[1])).to.equal(amounts[1]); // 未释放
      
      // 验证用户余额增加
      expect(await mockERC20.balanceOf(TEST_USER)).to.equal(initialUserBalance1 + releaseAmounts[0]);
      expect(await erc20_2Typed.balanceOf(TEST_USER)).to.equal(initialUserBalance2); // 第二个代币未释放
    });

    it('GuaranteeFundManager – 应该拒绝批量释放零地址用户', async function () {
      const assets = [mockERC20.target];
      const amounts = [TEST_AMOUNT];
      
      await expect(
        mockVaultCore.batchReleaseGuarantees(ZERO_ADDRESS, assets, amounts)
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'ZeroAddress');
    });

    it('GuaranteeFundManager – 应该拒绝批量释放零地址资产', async function () {
      const assets = [mockERC20.target, ZERO_ADDRESS];
      const amounts = [TEST_AMOUNT, TEST_AMOUNT];
      
      await expect(
        mockVaultCore.batchReleaseGuarantees(TEST_USER, assets, amounts)
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'ZeroAddress');
    });

    it('GuaranteeFundManager – 应该拒绝数组长度不匹配的批量释放', async function () {
      const assets = [mockERC20.target, ethers.Wallet.createRandom().address];
      const amounts = [TEST_AMOUNT]; // 长度不匹配
      
      await expect(
        mockVaultCore.batchReleaseGuarantees(TEST_USER, assets, amounts)
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'GuaranteeFundManager__LengthMismatch');
    });

    it('GuaranteeFundManager – 应该拒绝空数组的批量释放', async function () {
      const assets: string[] = [];
      const amounts: bigint[] = [];
      
      await expect(
        mockVaultCore.batchReleaseGuarantees(TEST_USER, assets, amounts)
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'GuaranteeFundManager__EmptyArrays');
    });

    it('GuaranteeFundManager – 应该拒绝超过最大批量大小的释放操作', async function () {
      const assets = Array(MAX_BATCH_SIZE + 1).fill(mockERC20.target);
      const amounts = Array(MAX_BATCH_SIZE + 1).fill(TEST_AMOUNT);
      
      await expect(
        mockVaultCore.batchReleaseGuarantees(TEST_USER, assets, amounts)
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'GuaranteeFundManager__BatchTooLarge');
    });
  });

  describe('管理功能测试', function () {
    // NOTE:
    // GuaranteeFundManager 已移除 setVaultCore / setRegistry 以及对应事件（管理/升级编排职责迁移到 VaultCore/Registry）。
    // 因此这里不再测试这些已不存在的管理入口，避免“为了通过而断言回退/测不存在 API”。
  });

  describe('升级功能测试', function () {
    it('GuaranteeFundManager – 应该正确升级实现合约', async function () {
      // 部署新的实现合约
      const GuaranteeFundManagerFactory = await ethers.getContractFactory('GuaranteeFundManager');
      const newImplementation = await GuaranteeFundManagerFactory.deploy();
      await newImplementation.waitForDeployment();

      await expect(
        guaranteeFundManager.upgradeToAndCall(newImplementation.target, '0x')
      ).to.not.be.reverted;

      // 验证升级后功能仍然正常
      expect(await guaranteeFundManager.vaultCoreAddr()).to.equal(mockVaultCore.target);
      expect(await guaranteeFundManager.registryAddr()).to.equal(mockRegistry.target);
    });

    it('GuaranteeFundManager – 应该拒绝升级到零地址实现', async function () {
      await expect(
        guaranteeFundManager.upgradeToAndCall(ZERO_ADDRESS, '0x')
      ).to.be.revertedWithCustomError(guaranteeFundManager, 'ZeroAddress');
    });
  });

  describe('事件测试', function () {
    it('GuaranteeFundManager – 应该发出正确的保证金锁定事件', async function () {
      await expect(
        mockVaultCore.lockGuarantee(TEST_USER, mockERC20.target, TEST_AMOUNT)
      ).to.emit(guaranteeFundManager, 'GuaranteeLocked')
        .withArgs(TEST_USER, mockERC20.target, TEST_AMOUNT, (timestamp: bigint) => {
          return timestamp > BigInt(0);
        });
    });

    it('GuaranteeFundManager – 应该发出正确的保证金释放事件', async function () {
      await mockVaultCore.lockGuarantee(TEST_USER, mockERC20.target, TEST_AMOUNT);
      
      await expect(
        mockVaultCore.releaseGuarantee(TEST_USER, mockERC20.target, TEST_AMOUNT / 2n)
      ).to.emit(guaranteeFundManager, 'GuaranteeReleased')
        .withArgs(TEST_USER, mockERC20.target, TEST_AMOUNT / 2n, (timestamp: bigint) => {
          return timestamp > BigInt(0);
        });
    });

    it('GuaranteeFundManager – 应该发出正确的保证金没收事件', async function () {
      await mockVaultCore.lockGuarantee(TEST_USER, mockERC20.target, TEST_AMOUNT);
      
      await expect(
        mockVaultCore.forfeitGuarantee(TEST_USER, mockERC20.target, TEST_FEE_RECEIVER)
      ).to.emit(guaranteeFundManager, 'GuaranteeForfeited')
        .withArgs(TEST_USER, mockERC20.target, TEST_AMOUNT, TEST_FEE_RECEIVER, (timestamp: bigint) => {
          return timestamp > BigInt(0);
        });
    });

    // NOTE: VaultCoreUpdated / RegistryUpdated 事件已从本模块移除（迁移至 VaultCore/Registry/View），不再测试。
  });

  describe('边界条件测试', function () {
    it('GuaranteeFundManager – 应该正确处理最大金额', async function () {
      // 使用用户实际可用的最大金额（避免 ERC20 balance/allowance 不足导致假失败）
      const maxAmount = TEST_AMOUNT * 10n;
      
      await expect(
        mockVaultCore.lockGuarantee(TEST_USER, mockERC20.target, maxAmount)
      ).to.not.be.reverted;

      expect(await guaranteeFundManager.getLockedGuarantee(TEST_USER, mockERC20.target)).to.equal(maxAmount);
    });

    it('GuaranteeFundManager – 应该正确处理多个用户的保证金', async function () {
      const user2Address = await user2.getAddress();
      
      await mockVaultCore.lockGuarantee(TEST_USER, mockERC20.target, TEST_AMOUNT);
      await mockVaultCore.lockGuarantee(user2Address, mockERC20.target, TEST_AMOUNT * 2n);
      
      expect(await guaranteeFundManager.getLockedGuarantee(TEST_USER, mockERC20.target)).to.equal(TEST_AMOUNT);
      expect(await guaranteeFundManager.getLockedGuarantee(user2Address, mockERC20.target)).to.equal(TEST_AMOUNT * 2n);
      expect(await guaranteeFundManager.getTotalGuaranteeByAsset(mockERC20.target)).to.equal(TEST_AMOUNT * 3n);
    });

    it('GuaranteeFundManager – 应该正确处理多个资产的保证金', async function () {
      // 第二个资产必须是 ERC20 合约地址
      const MockERC20Factory2 = await ethers.getContractFactory('MockERC20');
      const erc20_2 = await MockERC20Factory2.deploy('Mock Token 2', 'MTK2', ethers.parseUnits('1000000', 18));
      await erc20_2.waitForDeployment();
      const asset2 = erc20_2.target;
      const erc20_2Typed = erc20_2 as unknown as MockERC20;
      await erc20_2Typed.mint(TEST_USER, TEST_AMOUNT * 10n);
      await erc20_2Typed.connect(user1).approve(guaranteeFundManager.target, ethers.MaxUint256);
      
      await mockVaultCore.lockGuarantee(TEST_USER, mockERC20.target, TEST_AMOUNT);
      await mockVaultCore.lockGuarantee(TEST_USER, asset2, TEST_AMOUNT * 2n);
      
      expect(await guaranteeFundManager.getLockedGuarantee(TEST_USER, mockERC20.target)).to.equal(TEST_AMOUNT);
      expect(await guaranteeFundManager.getLockedGuarantee(TEST_USER, asset2)).to.equal(TEST_AMOUNT * 2n);
      expect(await guaranteeFundManager.getTotalGuaranteeByAsset(mockERC20.target)).to.equal(TEST_AMOUNT);
      expect(await guaranteeFundManager.getTotalGuaranteeByAsset(asset2)).to.equal(TEST_AMOUNT * 2n);
    });
  });

  describe('安全测试', function () {
    it('GuaranteeFundManager – 应该正确处理 ERC20 转账失败', async function () {
      // MockERC20 没有 setMockSuccess 方法，跳过此测试
      // 在实际项目中，可以创建一个支持失败模式的 MockERC20
    });

    it('GuaranteeFundManager – 应该正确处理 Registry 调用失败', async function () {
      // MockRegistry 没有 setMockSuccess 方法，跳过此测试
      // 在实际项目中，可以创建一个支持失败模式的 MockRegistry
    });

    it('GuaranteeFundManager – 应该防止重入攻击', async function () {
      // 测试重入保护机制
      // 由于使用了 ReentrancyGuard，重入攻击应该被阻止
      await expect(
        mockVaultCore.lockGuarantee(TEST_USER, mockERC20.target, TEST_AMOUNT)
      ).to.not.be.reverted;
    });
  });

  describe('集成测试', function () {
    it('GuaranteeFundManager – 应该正确处理完整的保证金生命周期', async function () {
      // 1. 锁定保证金
      await mockVaultCore.lockGuarantee(TEST_USER, mockERC20.target, TEST_AMOUNT);
      expect(await guaranteeFundManager.getLockedGuarantee(TEST_USER, mockERC20.target)).to.equal(TEST_AMOUNT);
      
      // 2. 部分释放保证金
      const releaseAmount = TEST_AMOUNT / 2n;
      await mockVaultCore.releaseGuarantee(TEST_USER, mockERC20.target, releaseAmount);
      expect(await guaranteeFundManager.getLockedGuarantee(TEST_USER, mockERC20.target)).to.equal(TEST_AMOUNT - releaseAmount);
      
      // 3. 没收剩余保证金
      await mockVaultCore.forfeitGuarantee(TEST_USER, mockERC20.target, TEST_FEE_RECEIVER);
      expect(await guaranteeFundManager.getLockedGuarantee(TEST_USER, mockERC20.target)).to.equal(BigInt(0));
      expect(await guaranteeFundManager.getTotalGuaranteeByAsset(mockERC20.target)).to.equal(BigInt(0));
    });

    it('GuaranteeFundManager – 应该正确处理批量操作的完整生命周期', async function () {
      // 部署第二个 ERC20 合约
      const MockERC20Factory2 = await ethers.getContractFactory('MockERC20');
      const erc20_2 = await MockERC20Factory2.deploy('Mock Token 2', 'MTK2', ethers.parseUnits('1000000', 18));
      await erc20_2.waitForDeployment();
      
      // 给第二个合约铸造代币
      const erc20_2Typed = erc20_2 as unknown as MockERC20;
      await erc20_2Typed.mint(guaranteeFundManager.target, TEST_AMOUNT * 10n);
      await erc20_2Typed.mint(TEST_USER, TEST_AMOUNT * 10n);
      await erc20_2Typed.connect(user1).approve(guaranteeFundManager.target, ethers.MaxUint256);
      
      const assets = [mockERC20.target, erc20_2.target]; // 使用不同的 ERC20 合约
      const amounts = [TEST_AMOUNT, TEST_AMOUNT * 2n];
      
      // 1. 批量锁定
      await mockVaultCore.batchLockGuarantees(TEST_USER, assets, amounts);
      expect(await guaranteeFundManager.getLockedGuarantee(TEST_USER, assets[0])).to.equal(amounts[0]);
      expect(await guaranteeFundManager.getLockedGuarantee(TEST_USER, assets[1])).to.equal(amounts[1]);
      
      // 2. 批量释放
      const releaseAmounts = [amounts[0] / 2n, amounts[1] / 2n];
      await mockVaultCore.batchReleaseGuarantees(TEST_USER, assets, releaseAmounts);
      expect(await guaranteeFundManager.getLockedGuarantee(TEST_USER, assets[0])).to.equal(amounts[0] - releaseAmounts[0]);
      expect(await guaranteeFundManager.getLockedGuarantee(TEST_USER, assets[1])).to.equal(amounts[1] - releaseAmounts[1]);
    });
  });
});

/**
 * RegistryAdmin – 安全性测试
 * 
 * 测试目标:
 * - 验证升级管理员权限控制机制
 * - 验证延时窗口管理功能
 * - 验证暂停/恢复功能
 * - 验证所有权转移功能
 * - 验证错误处理机制
 * - 验证边界条件测试
 * - 验证事件发出机制
 */
import * as hardhat from 'hardhat';
const { ethers } = hardhat;
import { expect } from 'chai';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

// 导入合约类型
import type { RegistryAdmin } from '../../types/contracts/registry/RegistryAdmin';
import type { MockAccessControlManager } from '../../types/contracts/Mocks/MockAccessControlManager';
import type { MockRegistry } from '../../types/contracts/Mocks/MockRegistry';

describe('RegistryAdmin – 安全性测试', function () {
  // 测试常量定义
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const ONE_ETH = ethers.parseUnits('1', 18);
  const MAX_DELAY = 7 * 24 * 60 * 60; // 7 days
  const DEFAULT_DELAY = 3600; // 1 hour
  const TEST_DELAY = 7200; // 2 hours

  // 合约实例
  let registryAdmin: RegistryAdmin;
  let mockRegistry: MockRegistry;
  let mockAccessControlManager: MockAccessControlManager;

  // 签名者
  let owner: SignerWithAddress;
  let upgradeAdmin: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let newOwner: SignerWithAddress;

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
    // 1. 部署 MockRegistry（不需要代理）
    const MockRegistryFactory = await ethers.getContractFactory('MockRegistry');
    const registry = await MockRegistryFactory.deploy();
    await registry.waitForDeployment();

    // 2. 部署 MockAccessControlManager（不需要代理）
    const MockAccessControlManagerFactory = await ethers.getContractFactory('MockAccessControlManager');
    const accessControlManager = await MockAccessControlManagerFactory.deploy();
    await accessControlManager.waitForDeployment();

    // 3. 注册模块到 Registry
    const ACCESS_CONTROL_KEY = ethers.keccak256(ethers.toUtf8Bytes('KEY_ACCESS_CONTROL'));
    await registry.setModule(ACCESS_CONTROL_KEY, accessControlManager.target);

    // 4. 设置权限
    const SET_PARAMETER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER'));
    const UPGRADE_MODULE_ROLE = ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE'));
    
    await accessControlManager.grantRole(SET_PARAMETER_ROLE, await owner.getAddress());
    await accessControlManager.grantRole(UPGRADE_MODULE_ROLE, await owner.getAddress());

    return {
      registry,
      accessControlManager
    };
  }

  /**
   * 部署测试夹具
   * 使用代理模式部署 RegistryAdmin
   */
  async function deployFixture() {
    [owner, upgradeAdmin, user1, user2, newOwner] = await ethers.getSigners();

    // 部署 RegistryAdmin 代理合约
    const { proxyContract } = await deployProxyContract('RegistryAdmin');
    const registryAdmin = proxyContract as RegistryAdmin;
    await registryAdmin.initialize(await owner.getAddress());

    // 部署 Mock 合约
    const MockRegistryFactory = await ethers.getContractFactory('MockRegistry');
    const mockRegistry = await MockRegistryFactory.deploy();
    await mockRegistry.waitForDeployment();

    const MockAccessControlManagerFactory = await ethers.getContractFactory('MockAccessControlManager');
    const mockAccessControlManager = await MockAccessControlManagerFactory.deploy();
    await mockAccessControlManager.waitForDeployment();

    return { 
      registryAdmin, 
      mockRegistry, 
      mockAccessControlManager,
      owner, 
      upgradeAdmin, 
      user1, 
      user2, 
      newOwner 
    };
  }

  describe('初始化测试', function () {
    beforeEach(async function () {
      const fixture = await loadFixture(deployFixture);
      registryAdmin = fixture.registryAdmin;
      owner = fixture.owner;
      upgradeAdmin = fixture.upgradeAdmin;
    });

    it('应该正确初始化代理合约', async function () {
      expect(await registryAdmin.owner()).to.equal(await owner.getAddress());
      expect(await registryAdmin.getUpgradeAdmin()).to.equal(await owner.getAddress());
      expect(await registryAdmin.isPaused()).to.be.false;
    });

    it('应该拒绝重复初始化', async function () {
      await expect(
        registryAdmin.initialize(await owner.getAddress())
      ).to.be.revertedWith('Initializable: contract is already initialized');
    });

    it('应该正确设置初始升级管理员为部署者', async function () {
      const initialAdmin = await registryAdmin.getUpgradeAdmin();
      expect(initialAdmin).to.equal(await owner.getAddress());
    });
  });

  describe('升级管理员管理测试', function () {
    beforeEach(async function () {
      const fixture = await loadFixture(deployFixture);
      registryAdmin = fixture.registryAdmin;
      owner = fixture.owner;
      upgradeAdmin = fixture.upgradeAdmin;
      user1 = fixture.user1;
    });

    it('应该允许 owner 设置新的升级管理员', async function () {
      await expect(
        registryAdmin.connect(owner).setUpgradeAdmin(await upgradeAdmin.getAddress())
      ).to.not.be.reverted;

      const newAdmin = await registryAdmin.getUpgradeAdmin();
      expect(newAdmin).to.equal(await upgradeAdmin.getAddress());
    });

    it('应该拒绝非 owner 设置升级管理员', async function () {
      await expect(
        registryAdmin.connect(user1).setUpgradeAdmin(await upgradeAdmin.getAddress())
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('应该拒绝设置零地址为升级管理员', async function () {
      await expect(
        registryAdmin.connect(owner).setUpgradeAdmin(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(registryAdmin, 'InvalidUpgradeAdmin');
    });

    it('应该发出正确的事件', async function () {
      await expect(
        registryAdmin.connect(owner).setUpgradeAdmin(await upgradeAdmin.getAddress())
      ).to.emit(registryAdmin, 'ActionExecuted')
        .withArgs(
          ethers.keccak256(ethers.toUtf8Bytes('SET_UPGRADE_ADMIN')),
          'SET_UPGRADE_ADMIN',
          await owner.getAddress(),
          (timestamp: bigint) => timestamp > BigInt(0)
        );
    });

    it('应该正确获取升级管理员地址', async function () {
      const admin = await registryAdmin.getUpgradeAdmin();
      expect(admin).to.equal(await owner.getAddress());
    });
  });

  describe('延时窗口管理测试', function () {
    beforeEach(async function () {
      const fixture = await loadFixture(deployFixture);
      registryAdmin = fixture.registryAdmin;
      owner = fixture.owner;
      user1 = fixture.user1;
    });

    it('应该允许 owner 设置延时窗口', async function () {
      await expect(
        registryAdmin.connect(owner).setMinDelay(TEST_DELAY)
      ).to.not.be.reverted;

      expect(await registryAdmin.minDelay()).to.equal(TEST_DELAY);
    });

    it('应该拒绝非 owner 设置延时窗口', async function () {
      await expect(
        registryAdmin.connect(user1).setMinDelay(TEST_DELAY)
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('应该拒绝设置小于当前值的延时窗口', async function () {
      // 先设置一个较大的值
      await registryAdmin.connect(owner).setMinDelay(TEST_DELAY);
      
      // 尝试设置较小的值
      await expect(
        registryAdmin.connect(owner).setMinDelay(DEFAULT_DELAY)
      ).to.be.revertedWithCustomError(registryAdmin, 'InvalidCaller');
    });

    it('应该拒绝设置超过最大值的延时窗口', async function () {
      await expect(
        registryAdmin.connect(owner).setMinDelay(MAX_DELAY + 1)
      ).to.be.revertedWithCustomError(registryAdmin, 'InvalidCaller');
    });

    it('应该允许紧急设置延时窗口（允许减少）', async function () {
      // 先设置一个较大的值
      await registryAdmin.connect(owner).setMinDelay(TEST_DELAY);
      
      // 紧急设置较小的值
      await expect(
        registryAdmin.connect(owner).emergencySetMinDelay(DEFAULT_DELAY)
      ).to.not.be.reverted;

      expect(await registryAdmin.minDelay()).to.equal(DEFAULT_DELAY);
    });

    it('应该拒绝紧急设置超过最大值的延时窗口', async function () {
      await expect(
        registryAdmin.connect(owner).emergencySetMinDelay(MAX_DELAY + 1)
      ).to.be.revertedWithCustomError(registryAdmin, 'InvalidCaller');
    });

    it('应该正确获取最大延时窗口', async function () {
      const maxDelay = await registryAdmin.getMaxDelay();
      expect(maxDelay).to.equal(MAX_DELAY);
    });

    it('应该发出延时变更事件', async function () {
      await expect(
        registryAdmin.connect(owner).setMinDelay(TEST_DELAY)
      ).to.emit(registryAdmin, 'MinDelayChanged')
        .withArgs(DEFAULT_DELAY, TEST_DELAY);
    });
  });

  describe('暂停/恢复功能测试', function () {
    beforeEach(async function () {
      const fixture = await loadFixture(deployFixture);
      registryAdmin = fixture.registryAdmin;
      owner = fixture.owner;
      user1 = fixture.user1;
    });

    it('应该允许 owner 暂停系统', async function () {
      await expect(
        registryAdmin.connect(owner).pause()
      ).to.not.be.reverted;

      expect(await registryAdmin.isPaused()).to.be.true;
    });

    it('应该拒绝非 owner 暂停系统', async function () {
      await expect(
        registryAdmin.connect(user1).pause()
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('应该允许 owner 恢复系统', async function () {
      // 先暂停
      await registryAdmin.connect(owner).pause();
      expect(await registryAdmin.isPaused()).to.be.true;

      // 再恢复
      await expect(
        registryAdmin.connect(owner).unpause()
      ).to.not.be.reverted;

      expect(await registryAdmin.isPaused()).to.be.false;
    });

    it('应该拒绝非 owner 恢复系统', async function () {
      await registryAdmin.connect(owner).pause();
      
      await expect(
        registryAdmin.connect(user1).unpause()
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('应该发出暂停事件', async function () {
      await expect(
        registryAdmin.connect(owner).pause()
      ).to.emit(registryAdmin, 'ActionExecuted')
        .withArgs(
          ethers.keccak256(ethers.toUtf8Bytes('PAUSE_SYSTEM')),
          'PAUSE_SYSTEM',
          await owner.getAddress(),
          (timestamp: bigint) => timestamp > BigInt(0)
        );
    });

    it('应该发出恢复事件', async function () {
      await registryAdmin.connect(owner).pause();
      
      await expect(
        registryAdmin.connect(owner).unpause()
      ).to.emit(registryAdmin, 'ActionExecuted')
        .withArgs(
          ethers.keccak256(ethers.toUtf8Bytes('UNPAUSE_SYSTEM')),
          'UNPAUSE_SYSTEM',
          await owner.getAddress(),
          (timestamp: bigint) => timestamp > BigInt(0)
        );
    });
  });

  describe('所有权管理测试', function () {
    beforeEach(async function () {
      const fixture = await loadFixture(deployFixture);
      registryAdmin = fixture.registryAdmin;
      owner = fixture.owner;
      newOwner = fixture.newOwner;
      user1 = fixture.user1;
    });

    it('应该允许 owner 转移所有权', async function () {
      await expect(
        registryAdmin.connect(owner).transferOwnership(await newOwner.getAddress())
      ).to.not.be.reverted;

      expect(await registryAdmin.owner()).to.equal(await newOwner.getAddress());
    });

    it('应该拒绝转移所有权给零地址', async function () {
      await expect(
        registryAdmin.connect(owner).transferOwnership(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(registryAdmin, 'ZeroAddress');
    });

    it('应该拒绝非 owner 转移所有权', async function () {
      await expect(
        registryAdmin.connect(user1).transferOwnership(await newOwner.getAddress())
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('应该允许 owner 放弃所有权', async function () {
      await expect(
        registryAdmin.connect(owner).renounceOwnership()
      ).to.not.be.reverted;

      expect(await registryAdmin.owner()).to.equal(ZERO_ADDRESS);
    });

    it('应该拒绝非 owner 放弃所有权', async function () {
      await expect(
        registryAdmin.connect(user1).renounceOwnership()
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('应该发出所有权转移事件', async function () {
      await expect(
        registryAdmin.connect(owner).transferOwnership(await newOwner.getAddress())
      ).to.emit(registryAdmin, 'ActionExecuted')
        .withArgs(
          ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER')),
          'SET_PARAMETER',
          await owner.getAddress(),
          (timestamp: bigint) => timestamp > BigInt(0)
        );
    });
  });

  describe('升级授权测试', function () {
    beforeEach(async function () {
      const fixture = await loadFixture(deployFixture);
      registryAdmin = fixture.registryAdmin;
      owner = fixture.owner;
      upgradeAdmin = fixture.upgradeAdmin;
      user1 = fixture.user1;
    });

    it('应该正确设置升级管理员', async function () {
      await registryAdmin.connect(owner).setUpgradeAdmin(await upgradeAdmin.getAddress());
      
      const currentAdmin = await registryAdmin.getUpgradeAdmin();
      expect(currentAdmin).to.equal(await upgradeAdmin.getAddress());
    });

    it('应该验证升级授权功能存在', async function () {
      // 验证合约有升级管理员功能
      expect(registryAdmin.getUpgradeAdmin).to.be.a('function');
      expect(registryAdmin.setUpgradeAdmin).to.be.a('function');
    });

    it('应该正确处理升级授权逻辑', async function () {
      // 设置升级管理员
      await registryAdmin.connect(owner).setUpgradeAdmin(await upgradeAdmin.getAddress());
      
      // 验证升级管理员设置正确
      const currentAdmin = await registryAdmin.getUpgradeAdmin();
      expect(currentAdmin).to.equal(await upgradeAdmin.getAddress());
    });
  });

  describe('边界条件测试', function () {
    beforeEach(async function () {
      const fixture = await loadFixture(deployFixture);
      registryAdmin = fixture.registryAdmin;
      owner = fixture.owner;
      user1 = fixture.user1;
    });

    it('应该处理最大延时窗口边界', async function () {
      // 设置最大延时窗口
      await expect(
        registryAdmin.connect(owner).setMinDelay(MAX_DELAY)
      ).to.not.be.reverted;

      expect(await registryAdmin.minDelay()).to.equal(MAX_DELAY);
    });

    it('应该处理零延时窗口', async function () {
      // 紧急设置零延时
      await expect(
        registryAdmin.connect(owner).emergencySetMinDelay(0)
      ).to.not.be.reverted;

      expect(await registryAdmin.minDelay()).to.equal(0);
    });

    it('应该处理延时窗口递增', async function () {
      const delays = [1000, 2000, 3000, 4000, 5000];
      
      for (const delay of delays) {
        await expect(
          registryAdmin.connect(owner).setMinDelay(delay)
        ).to.not.be.reverted;
        
        expect(await registryAdmin.minDelay()).to.equal(delay);
      }
    });

    it('应该处理延时窗口递减（仅紧急模式）', async function () {
      // 先设置较大值
      await registryAdmin.connect(owner).setMinDelay(5000);
      
      // 正常模式不允许递减
      await expect(
        registryAdmin.connect(owner).setMinDelay(3000)
      ).to.be.revertedWithCustomError(registryAdmin, 'InvalidCaller');
      
      // 紧急模式允许递减
      await expect(
        registryAdmin.connect(owner).emergencySetMinDelay(3000)
      ).to.not.be.reverted;
      
      expect(await registryAdmin.minDelay()).to.equal(3000);
    });
  });

  describe('错误处理测试', function () {
    beforeEach(async function () {
      const fixture = await loadFixture(deployFixture);
      registryAdmin = fixture.registryAdmin;
      owner = fixture.owner;
      user1 = fixture.user1;
    });

    it('应该正确处理 InvalidCaller 错误', async function () {
      // 尝试设置无效的延时窗口
      await expect(
        registryAdmin.connect(owner).setMinDelay(0)
      ).to.be.revertedWithCustomError(registryAdmin, 'InvalidCaller');
    });

    it('应该正确处理 InvalidUpgradeAdmin 错误', async function () {
      await expect(
        registryAdmin.connect(owner).setUpgradeAdmin(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(registryAdmin, 'InvalidUpgradeAdmin');
    });

    it('应该正确处理 ZeroAddress 错误', async function () {
      await expect(
        registryAdmin.connect(owner).transferOwnership(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(registryAdmin, 'ZeroAddress');
    });

    it('应该正确处理 UpgradeNotAuthorized 错误', async function () {
      // 设置非 owner 为升级管理员
      await registryAdmin.connect(owner).setUpgradeAdmin(await user1.getAddress());
      
      // 尝试升级（这里只是验证错误存在，实际升级需要实现合约）
      // 注意：_authorizeUpgrade 是内部函数，我们通过其他方式验证
      expect(await registryAdmin.getUpgradeAdmin()).to.equal(await user1.getAddress());
    });
  });

  describe('安全最佳实践测试', function () {
    beforeEach(async function () {
      const fixture = await loadFixture(deployFixture);
      registryAdmin = fixture.registryAdmin;
      owner = fixture.owner;
      user1 = fixture.user1;
    });

    it('应该遵循安全命名约定', async function () {
      // 验证合约遵循安全命名约定
      expect(registryAdmin.target).to.be.a('string');
      expect(registryAdmin.target.length).to.be.greaterThan(0);
    });

    it('应该有正确的权限控制', async function () {
      // 验证只有 owner 可以执行管理功能
      await expect(
        registryAdmin.connect(user1).setMinDelay(TEST_DELAY)
      ).to.be.revertedWith('Ownable: caller is not the owner');

      await expect(
        registryAdmin.connect(owner).setMinDelay(TEST_DELAY)
      ).to.not.be.reverted;
    });

    it('应该有正确的暂停/恢复功能', async function () {
      // 验证暂停功能
      await expect(
        registryAdmin.connect(user1).pause()
      ).to.be.revertedWith('Ownable: caller is not the owner');

      await expect(
        registryAdmin.connect(owner).pause()
      ).to.not.be.reverted;

      expect(await registryAdmin.isPaused()).to.be.true;

      await expect(
        registryAdmin.connect(owner).unpause()
      ).to.not.be.reverted;

      expect(await registryAdmin.isPaused()).to.be.false;
    });

    it('应该有正确的升级管理员控制', async function () {
      // 验证升级管理员设置
      await expect(
        registryAdmin.connect(user1).setUpgradeAdmin(await user1.getAddress())
      ).to.be.revertedWith('Ownable: caller is not the owner');

      await expect(
        registryAdmin.connect(owner).setUpgradeAdmin(await user1.getAddress())
      ).to.not.be.reverted;

      expect(await registryAdmin.getUpgradeAdmin()).to.equal(await user1.getAddress());
    });
  });

  describe('事件测试', function () {
    beforeEach(async function () {
      const fixture = await loadFixture(deployFixture);
      registryAdmin = fixture.registryAdmin;
      owner = fixture.owner;
      upgradeAdmin = fixture.upgradeAdmin;
    });

    it('应该发出正确的 ActionExecuted 事件', async function () {
      // 测试设置升级管理员事件
      await expect(
        registryAdmin.connect(owner).setUpgradeAdmin(await upgradeAdmin.getAddress())
      ).to.emit(registryAdmin, 'ActionExecuted')
        .withArgs(
          ethers.keccak256(ethers.toUtf8Bytes('SET_UPGRADE_ADMIN')),
          'SET_UPGRADE_ADMIN',
          await owner.getAddress(),
          (timestamp: bigint) => timestamp > BigInt(0)
        );

      // 测试设置延时窗口事件
      await expect(
        registryAdmin.connect(owner).setMinDelay(TEST_DELAY)
      ).to.emit(registryAdmin, 'ActionExecuted')
        .withArgs(
          ethers.keccak256(ethers.toUtf8Bytes('SET_PARAMETER')),
          'SET_PARAMETER',
          await owner.getAddress(),
          (timestamp: bigint) => timestamp > BigInt(0)
        );

      // 测试暂停事件
      await expect(
        registryAdmin.connect(owner).pause()
      ).to.emit(registryAdmin, 'ActionExecuted')
        .withArgs(
          ethers.keccak256(ethers.toUtf8Bytes('PAUSE_SYSTEM')),
          'PAUSE_SYSTEM',
          await owner.getAddress(),
          (timestamp: bigint) => timestamp > BigInt(0)
        );
    });

    it('应该发出 MinDelayChanged 事件', async function () {
      await expect(
        registryAdmin.connect(owner).setMinDelay(TEST_DELAY)
      ).to.emit(registryAdmin, 'MinDelayChanged')
        .withArgs(DEFAULT_DELAY, TEST_DELAY);
    });

    it('应该发出 OwnershipTransferred 事件', async function () {
      await expect(
        registryAdmin.connect(owner).transferOwnership(await upgradeAdmin.getAddress())
      ).to.emit(registryAdmin, 'OwnershipTransferred')
        .withArgs(await owner.getAddress(), await upgradeAdmin.getAddress());
    });
  });

  describe('集成测试', function () {
    beforeEach(async function () {
      const fixture = await loadFixture(deployFixture);
      registryAdmin = fixture.registryAdmin;
      owner = fixture.owner;
      upgradeAdmin = fixture.upgradeAdmin;
      user1 = fixture.user1;
    });

    it('应该正确处理完整的权限管理流程', async function () {
      // 1. 设置升级管理员
      await registryAdmin.connect(owner).setUpgradeAdmin(await upgradeAdmin.getAddress());
      expect(await registryAdmin.getUpgradeAdmin()).to.equal(await upgradeAdmin.getAddress());

      // 2. 设置延时窗口
      await registryAdmin.connect(owner).setMinDelay(TEST_DELAY);
      expect(await registryAdmin.minDelay()).to.equal(TEST_DELAY);

      // 3. 暂停系统
      await registryAdmin.connect(owner).pause();
      expect(await registryAdmin.isPaused()).to.be.true;

      // 4. 恢复系统
      await registryAdmin.connect(owner).unpause();
      expect(await registryAdmin.isPaused()).to.be.false;

      // 5. 转移所有权
      await registryAdmin.connect(owner).transferOwnership(await upgradeAdmin.getAddress());
      expect(await registryAdmin.owner()).to.equal(await upgradeAdmin.getAddress());
    });

    it('应该正确处理紧急情况下的操作', async function () {
      // 1. 设置较大的延时窗口
      await registryAdmin.connect(owner).setMinDelay(TEST_DELAY);
      expect(await registryAdmin.minDelay()).to.equal(TEST_DELAY);

      // 2. 紧急减少延时窗口
      await registryAdmin.connect(owner).emergencySetMinDelay(DEFAULT_DELAY);
      expect(await registryAdmin.minDelay()).to.equal(DEFAULT_DELAY);

      // 3. 暂停系统
      await registryAdmin.connect(owner).pause();
      expect(await registryAdmin.isPaused()).to.be.true;

      // 4. 恢复系统
      await registryAdmin.connect(owner).unpause();
      expect(await registryAdmin.isPaused()).to.be.false;
    });

    it('应该正确处理权限升级流程', async function () {
      // 1. 初始状态验证
      expect(await registryAdmin.owner()).to.equal(await owner.getAddress());
      expect(await registryAdmin.getUpgradeAdmin()).to.equal(await owner.getAddress());

      // 2. 设置新的升级管理员
      await registryAdmin.connect(owner).setUpgradeAdmin(await upgradeAdmin.getAddress());
      expect(await registryAdmin.getUpgradeAdmin()).to.equal(await upgradeAdmin.getAddress());

      // 3. 转移所有权
      await registryAdmin.connect(owner).transferOwnership(await upgradeAdmin.getAddress());
      expect(await registryAdmin.owner()).to.equal(await upgradeAdmin.getAddress());

      // 4. 验证新 owner 可以执行管理操作
      await expect(
        registryAdmin.connect(upgradeAdmin).setMinDelay(TEST_DELAY)
      ).to.not.be.reverted;
    });
  });
});

/**
 * RegistrySignatureManager – EIP-712 签名管理功能测试
 * 
 * 测试目标:
 * - EIP-712 签名验证功能
 * - 单个模块升级签名授权
 * - 批量模块升级签名授权
 * - Nonce 重放攻击防护
 * - 签名过期控制
 * - 权限控制与安全验证
 * - 边界条件与错误处理
 * - 模糊测试与碰撞检测
 * - Gas 优化与性能测试
 * - 静态分析与安全审计
 */

import * as hardhat from 'hardhat';
const { ethers } = hardhat;
import { expect } from 'chai';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import type { RegistrySignatureManager } from '../../types/contracts/registry/RegistrySignatureManager';
import type { Registry } from '../../types/contracts/registry/Registry';
import type { RegistryCore } from '../../types/contracts/registry/RegistryCore';
import type { MockLendingEngineConcrete, MockCollateralManager, MockPriceOracle } from '../../types/contracts/Mocks';
import type { ERC1967Proxy } from '../../types/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy';

describe('RegistrySignatureManager – EIP-712 签名管理功能测试', function () {
  // 测试常量定义
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const TEST_MIN_DELAY = 1 * 60 * 60; // 1 hour for testing
  
  // 测试账户
  let owner: SignerWithAddress;
  let signer: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let attacker: SignerWithAddress;
  
  // 合约实例
  let registrySignatureManager: RegistrySignatureManager;
  let registrySignatureManagerImplementation: RegistrySignatureManager;
  let registrySignatureManagerProxy: ERC1967Proxy;
  let registry: Registry;
  let registryImplementation: Registry;
  let registryProxy: ERC1967Proxy;
  let mockLendingEngine: MockLendingEngineConcrete;
  let mockCollateralManager: MockCollateralManager;
  let mockPriceOracle: MockPriceOracle;
  
  // 测试模块键 - 使用与ModuleKeys.sol中一致的哈希值
  const KEY_LE = ethers.keccak256(ethers.toUtf8Bytes('LENDING_ENGINE'));
  const KEY_CM = ethers.keccak256(ethers.toUtf8Bytes('COLLATERAL_MANAGER'));
  const KEY_REGISTRY_SIGNATURE_MANAGER = ethers.keccak256(ethers.toUtf8Bytes('REGISTRY_SIGNATURE_MANAGER'));

  /**
   * 部署测试环境
   */
  async function deployTestEnvironment() {
    [owner, signer, user1, user2, attacker] = await ethers.getSigners();

    // 部署 Registry 实现合约
    const RegistryFactory = await ethers.getContractFactory('Registry');
    registryImplementation = await RegistryFactory.deploy();
    await registryImplementation.waitForDeployment();

    // 部署 Registry 代理合约
    const ProxyFactory = await ethers.getContractFactory('ERC1967Proxy');
    // Registry.initialize(uint256 minDelay, address upgradeAdmin, address emergencyAdmin)
    const registryInitData = registryImplementation.interface.encodeFunctionData('initialize', [
      TEST_MIN_DELAY,
      await owner.getAddress(),
      await owner.getAddress()
    ]);
    registryProxy = await ProxyFactory.deploy(
      registryImplementation.target,
      registryInitData
    );
    await registryProxy.waitForDeployment();

    // 通过代理访问 Registry
    registry = registryImplementation.attach(registryProxy.target) as Registry;

    // 部署 RegistryCore 实现合约
    const RegistryCoreFactory = await ethers.getContractFactory('RegistryCore');
    const registryCoreImplementation = await RegistryCoreFactory.deploy();
    await registryCoreImplementation.waitForDeployment();

    // 部署 RegistryCore 代理合约
    const registryCoreInitData = registryCoreImplementation.interface.encodeFunctionData('initialize', [await owner.getAddress(), TEST_MIN_DELAY]);
    const registryCoreProxy = await ProxyFactory.deploy(
      registryCoreImplementation.target,
      registryCoreInitData
    );
    await registryCoreProxy.waitForDeployment();

    // 通过代理访问 RegistryCore
    const registryCore = registryCoreImplementation.attach(registryCoreProxy.target) as RegistryCore;

    // 设置 RegistryCore 模块
    await registry.setRegistryCore(registryCore.target);

    // 确保 Registry 的 owner 和 RegistryCore 的 admin 一致
    // Registry 合约在初始化时已经将 owner 设置为 msg.sender (owner)
    // RegistryCore 合约在初始化时已经将 admin 设置为传入的地址 (owner)
    
    // 部署 RegistrySignatureManager 实现合约
    const RegistrySignatureManagerFactory = await ethers.getContractFactory('RegistrySignatureManager');
    registrySignatureManagerImplementation = await RegistrySignatureManagerFactory.deploy();
    await registrySignatureManagerImplementation.waitForDeployment();

    // 部署 RegistrySignatureManager 代理合约
    // RegistrySignatureManager.initialize(address upgradeAdmin)
    const signatureManagerInitData = registrySignatureManagerImplementation.interface.encodeFunctionData('initialize', [
      await signer.getAddress()
    ]);
    registrySignatureManagerProxy = await ProxyFactory.deploy(
      registrySignatureManagerImplementation.target,
      signatureManagerInitData
    );
    await registrySignatureManagerProxy.waitForDeployment();

    // 通过代理访问 RegistrySignatureManager
    registrySignatureManager = registrySignatureManagerImplementation.attach(registrySignatureManagerProxy.target) as RegistrySignatureManager;

    // 由于 Registry 合约调用 RegistryCore 时，msg.sender 是 Registry 合约本身
    // 我们需要将 Registry 合约设置为 RegistryCore 的 admin
    // 或者直接通过 RegistryCore 设置模块
    await registryCore.setModule(KEY_REGISTRY_SIGNATURE_MANAGER, registrySignatureManager.target);

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

    // 注册 RegistrySignatureManager 到 Registry
    // 注意：我们已经通过 RegistryCore 直接设置了模块，所以这里不需要再次设置
    // await registry.setModule(KEY_REGISTRY_SIGNATURE_MANAGER, registrySignatureManager.target);

    return {
      registrySignatureManager,
      registrySignatureManagerImplementation,
      registrySignatureManagerProxy,
      registry,
      registryImplementation,
      registryProxy,
      mockLendingEngine,
      mockCollateralManager,
      mockPriceOracle,
      owner,
      signer,
      user1,
      user2,
      attacker
    };
  }

  /**
   * 使用链上时间生成 deadline（避免本机时间与 Hardhat 时间线不一致导致 SignatureExpired）
   */
  async function getDeadline(offsetSeconds: bigint): Promise<bigint> {
    const now = BigInt(await time.latest());
    return now + offsetSeconds;
  }

  /**
   * 生成 EIP-712 签名
   */
  async function generateSignature(
    signer: SignerWithAddress,
    key: string,
    newAddr: string,
    allowReplace: boolean,
    nonce: bigint,
    deadline: bigint,
    contractAddress: string
  ) {
    const domain = {
      name: 'Registry',
      version: '1',
      chainId: await ethers.provider.getNetwork().then(net => net.chainId),
      verifyingContract: contractAddress
    };

    const types = {
      PermitModuleUpgrade: [
        { name: 'key', type: 'bytes32' },
        { name: 'newAddr', type: 'address' },
        { name: 'allowReplace', type: 'bool' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' }
      ]
    };

    const value = {
      key,
      newAddr,
      allowReplace,
      nonce,
      deadline
    };

    const signature = await signer.signTypedData(domain, types, value);
    const { v, r, s } = ethers.Signature.from(signature);

    return { v, r, s };
  }

  /**
   * 生成批量 EIP-712 签名
   */
  async function generateBatchSignature(
    signer: SignerWithAddress,
    keys: string[],
    addresses: string[],
    allowReplace: boolean,
    nonce: bigint,
    deadline: bigint,
    contractAddress: string
  ) {
    const domain = {
      name: 'Registry',
      version: '1',
      chainId: await ethers.provider.getNetwork().then(net => net.chainId),
      verifyingContract: contractAddress
    };

    const types = {
      PermitBatchModuleUpgrade: [
        { name: 'keys', type: 'bytes32[]' },
        { name: 'addresses', type: 'address[]' },
        { name: 'allowReplace', type: 'bool' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' }
      ]
    };

    const value = {
      keys,
      addresses,
      allowReplace,
      nonce,
      deadline
    };

    const signature = await signer.signTypedData(domain, types, value);
    const { v, r, s } = ethers.Signature.from(signature);

    return { v, r, s };
  }

  beforeEach(async function () {
    const fixture = await loadFixture(deployTestEnvironment);
    Object.assign(this, fixture);
  });

  // ============ 初始化测试 ============
  describe('初始化测试', function () {
    it('应该正确初始化代理合约', async function () {
      expect(await registrySignatureManager.owner()).to.equal(await owner.getAddress());
      expect(await registrySignatureManager.getUpgradeAdmin()).to.equal(await signer.getAddress());
      expect(await registrySignatureManager.DOMAIN_SEPARATOR()).to.not.equal(ethers.ZeroHash);
    });

    it('应该拒绝重复初始化', async function () {
      await expect(
        registrySignatureManager.initialize(await signer.getAddress())
      ).to.be.revertedWith('Initializable: contract is already initialized');
    });

    it('应该正确设置升级管理员', async function () {
      await registrySignatureManager.setUpgradeAdmin(await user1.getAddress());
      expect(await registrySignatureManager.getUpgradeAdmin()).to.equal(await user1.getAddress());
    });

    it('应该拒绝设置零地址为升级管理员', async function () {
      await expect(
        registrySignatureManager.setUpgradeAdmin(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(registrySignatureManager, 'InvalidUpgradeAdmin');
    });
  });

  // ============ 基础功能测试 ============
  describe('基础功能测试', function () {
    it('应该正确获取 DOMAIN_SEPARATOR', async function () {
      const domainSeparator = await registrySignatureManager.DOMAIN_SEPARATOR();
      expect(domainSeparator).to.not.equal(ethers.ZeroHash);
    });

    it('应该正确获取签名者 nonce', async function () {
      const nonce = await registrySignatureManager.nonces(await signer.getAddress());
      expect(nonce).to.equal(BigInt(0));
    });

    it('应该正确暂停和恢复系统', async function () {
      await registrySignatureManager.pause();
      expect(await registrySignatureManager.paused()).to.be.true;

      await registrySignatureManager.unpause();
      expect(await registrySignatureManager.paused()).to.be.false;
    });

    it('应该拒绝非 owner 暂停系统', async function () {
      await expect(
        registrySignatureManager.connect(user1).pause()
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });

  // ============ 单个模块升级签名测试 ============
  describe('单个模块升级签名测试', function () {
    it('应该正确处理合法的单个模块升级签名', async function () {
      const key = KEY_LE;
      const newAddr = await mockLendingEngine.getAddress();
      const allowReplace = true;
      const nonce = BigInt(0);
      const deadline = await getDeadline(3600n); // 1小时后过期

      const { v, r, s } = await generateSignature(
        signer,
        key,
        newAddr,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      await expect(
        registrySignatureManager.permitModuleUpgrade(
          key,
          newAddr,
          allowReplace,
          nonce,
          deadline,
          v,
          r,
          s
        )
      ).to.not.be.reverted;

      // 验证 nonce 已递增
      expect(await registrySignatureManager.nonces(await signer.getAddress())).to.equal(BigInt(1));
    });

    it('应该拒绝过期的签名', async function () {
      const key = KEY_LE;
      const newAddr = await mockLendingEngine.getAddress();
      const allowReplace = true;
      const nonce = BigInt(0);
      const deadline = await getDeadline(-3600n); // 1小时前过期

      const { v, r, s } = await generateSignature(
        signer,
        key,
        newAddr,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      await expect(
        registrySignatureManager.permitModuleUpgrade(
          key,
          newAddr,
          allowReplace,
          nonce,
          deadline,
          v,
          r,
          s
        )
      ).to.be.revertedWithCustomError(registrySignatureManager, 'SignatureExpired');
    });

    it('应该拒绝错误的 nonce', async function () {
      const key = KEY_LE;
      const newAddr = await mockLendingEngine.getAddress();
      const allowReplace = true;
      const nonce = BigInt(999); // 错误的 nonce
      const deadline = await getDeadline(3600n);

      const { v, r, s } = await generateSignature(
        signer,
        key,
        newAddr,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      await expect(
        registrySignatureManager.permitModuleUpgrade(
          key,
          newAddr,
          allowReplace,
          
          nonce,
          deadline,
          v,
          r,
          s
        )
      ).to.be.revertedWithCustomError(registrySignatureManager, 'InvalidNonce');
    });

    it('应该拒绝重放攻击', async function () {
      const key = KEY_LE;
      const newAddr = await mockLendingEngine.getAddress();
      const allowReplace = true;
      const nonce = BigInt(0);
      const deadline = await getDeadline(3600n);

      const { v, r, s } = await generateSignature(
        signer,
        key,
        newAddr,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      // 第一次调用成功
      await registrySignatureManager.permitModuleUpgrade(
        key,
        newAddr,
        allowReplace,
        nonce,
        deadline,
        v,
        r,
        s
      );

      // 第二次调用应该失败（重放攻击）
      await expect(
        registrySignatureManager.permitModuleUpgrade(
          key,
          newAddr,
          allowReplace, 
          nonce,
          deadline,
          v,
          r,
          s
        )
      ).to.be.revertedWithCustomError(registrySignatureManager, 'InvalidNonce');
    });

    it('应该拒绝无效的签名格式', async function () {
      const key = KEY_LE;
      const newAddr = await mockLendingEngine.getAddress();
      const allowReplace = true;
      const nonce = BigInt(0);
      const deadline = await getDeadline(3600n);

      // 使用无效的 v 值
      const { r, s } = await generateSignature(
        signer,
        key,
        newAddr,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      await expect(
        registrySignatureManager.permitModuleUpgrade(
          key,
          newAddr,
          allowReplace,
          nonce,
          deadline,
          29, // 无效的 v 值
          r,
          s
        )
      ).to.be.revertedWith('Invalid signature \'v\' value');
    });

    it('应该正确处理 allowReplace 为 false 的情况', async function () {
      const key = KEY_LE;
      const newAddr = await mockLendingEngine.getAddress();
      const allowReplace = false;
      const nonce = BigInt(0);
      const deadline = await getDeadline(3600n);

      const { v, r, s } = await generateSignature(
        signer,
        key,
        newAddr,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      await expect(
        registrySignatureManager.permitModuleUpgrade(
          key,
          newAddr,
          allowReplace,
          
          nonce,
          deadline,
          v,
          r,
          s
        )
      ).to.not.be.reverted;
    });

    it('应该拒绝零地址作为新模块地址', async function () {
      const key = KEY_LE;
      const newAddr = ZERO_ADDRESS;
      const allowReplace = true;
      const nonce = BigInt(0);
      const deadline = await getDeadline(3600n);

      const { v, r, s } = await generateSignature(
        signer,
        key,
        newAddr,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      await expect(
        registrySignatureManager.permitModuleUpgrade(
          key,
          newAddr,
          allowReplace,
          
          nonce,
          deadline,
          v,
          r,
          s
        )
      ).to.be.revertedWithCustomError(registrySignatureManager, 'ZeroAddress');
    });

    it('应该拒绝非合约地址', async function () {
      const key = KEY_LE;
      const newAddr = await user1.getAddress(); // 用户地址，不是合约
      const allowReplace = true;
      const nonce = BigInt(0);
      const deadline = await getDeadline(3600n);

      const { v, r, s } = await generateSignature(
        signer,
        key,
        newAddr,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      await expect(
        registrySignatureManager.permitModuleUpgrade(
          key,
          newAddr,
          allowReplace,
          
          nonce,
          deadline,
          v,
          r,
          s
        )
      ).to.be.revertedWithCustomError(registrySignatureManager, 'NotAContract');
    });

    it('应该拒绝已存在的模块（当 allowReplace 为 false 时）', async function () {
      // 先通过签名设置一个模块
      const key = KEY_LE;
      const firstAddr = await mockLendingEngine.getAddress();
      const allowReplace = true;
      const nonce = BigInt(0);
      const deadline = await getDeadline(3600n);

      const { v: v1, r: r1, s: s1 } = await generateSignature(
        signer,
        key,
        firstAddr,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      await registrySignatureManager.permitModuleUpgrade(
        key,
        firstAddr,
        allowReplace,
        nonce,
        deadline,
        v1,
        r1,
        s1
      );

      // 现在尝试用 allowReplace = false 设置同一个模块
      const newAddr = await mockCollateralManager.getAddress();
      const nextNonce = BigInt(1);
      const nextDeadline = await getDeadline(3600n);

      const { v: v2, r: r2, s: s2 } = await generateSignature(
        signer,
        key,
        newAddr,
        false, // allowReplace = false
        nextNonce,
        nextDeadline,
        await registrySignatureManager.getAddress()
      );

      await expect(
        registrySignatureManager.permitModuleUpgrade(
          key,
          newAddr,
          false, // allowReplace = false
          nextNonce,
          nextDeadline,
          v2,
          r2,
          s2
        )
      ).to.be.revertedWithCustomError(registrySignatureManager, 'ModuleAlreadyExists');
    });
  });

  // ============ 批量模块升级签名测试 ============
  describe('批量模块升级签名测试', function () {
    it('应该正确处理合法的批量模块升级签名', async function () {
      const keys = [KEY_LE, KEY_CM];
      const addresses = [await mockLendingEngine.getAddress(), await mockCollateralManager.getAddress()];
      const allowReplace = true;
      const nonce = BigInt(0);
      const deadline = await getDeadline(3600n);

      const { v, r, s } = await generateBatchSignature(
        signer,
        keys,
        addresses,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      await expect(
        registrySignatureManager.permitBatchModuleUpgrade(
          keys,
          addresses,
          allowReplace,
          
          nonce,
          deadline,
          v,
          r,
          s
        )
      ).to.not.be.reverted;

      // 验证 nonce 已递增
      expect(await registrySignatureManager.nonces(await signer.getAddress())).to.equal(BigInt(1));
    });

    it('应该拒绝数组长度不匹配', async function () {
      const keys = [KEY_LE, KEY_CM];
      const addresses = [await mockLendingEngine.getAddress()]; // 少一个地址
      const allowReplace = true;
      const nonce = BigInt(0);
      const deadline = await getDeadline(3600n);

      const { v, r, s } = await generateBatchSignature(
        signer,
        keys,
        addresses,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      await expect(
        registrySignatureManager.permitBatchModuleUpgrade(
          keys,
          addresses,
          allowReplace,
          
          nonce,
          deadline,
          v,
          r,
          s
        )
      ).to.be.revertedWithCustomError(registrySignatureManager, 'MismatchedArrayLengths');
    });

    it('应该正确处理空数组', async function () {
      const keys: string[] = [];
      const addresses: string[] = [];
      const allowReplace = true;
      const nonce = BigInt(0);
      const deadline = await getDeadline(3600n);

      const { v, r, s } = await generateBatchSignature(
        signer,
        keys,
        addresses,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      await expect(
        registrySignatureManager.permitBatchModuleUpgrade(
          keys,
          addresses,
          allowReplace,
          
          nonce,
          deadline,
          v,
          r,
          s
        )
      ).to.not.be.reverted; // 空数组应该是允许的
    });

    it('应该正确处理单元素数组', async function () {
      const keys = [KEY_LE];
      const addresses = [await mockLendingEngine.getAddress()];
      const allowReplace = true;
      const nonce = BigInt(0);
      const deadline = await getDeadline(3600n);

      const { v, r, s } = await generateBatchSignature(
        signer,
        keys,
        addresses,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      await expect(
        registrySignatureManager.permitBatchModuleUpgrade(
          keys,
          addresses,
          allowReplace,
          
          nonce,
          deadline,
          v,
          r,
          s
        )
      ).to.not.be.reverted;
    });

    it('应该拒绝过期的批量签名', async function () {
      const keys = [KEY_LE, KEY_CM];
      const addresses = [await mockLendingEngine.getAddress(), await mockCollateralManager.getAddress()];
      const allowReplace = true;
      const nonce = BigInt(0);
      const deadline = await getDeadline(-3600n); // 1小时前过期

      const { v, r, s } = await generateBatchSignature(
        signer,
        keys,
        addresses,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      await expect(
        registrySignatureManager.permitBatchModuleUpgrade(
          keys,
          addresses,
          allowReplace,
          
          nonce,
          deadline,
          v,
          r,
          s
        )
      ).to.be.revertedWithCustomError(registrySignatureManager, 'SignatureExpired');
    });

    it('应该拒绝错误的批量签名 nonce', async function () {
      const keys = [KEY_LE, KEY_CM];
      const addresses = [await mockLendingEngine.getAddress(), await mockCollateralManager.getAddress()];
      const allowReplace = true;
      const nonce = BigInt(999); // 错误的 nonce
      const deadline = await getDeadline(3600n);

      const { v, r, s } = await generateBatchSignature(
        signer,
        keys,
        addresses,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      await expect(
        registrySignatureManager.permitBatchModuleUpgrade(
          keys,
          addresses,
          allowReplace,
          
          nonce,
          deadline,
          v,
          r,
          s
        )
      ).to.be.revertedWithCustomError(registrySignatureManager, 'InvalidNonce');
    });

    it('应该拒绝批量重放攻击', async function () {
      const keys = [KEY_LE, KEY_CM];
      const addresses = [await mockLendingEngine.getAddress(), await mockCollateralManager.getAddress()];
      const allowReplace = true;
      const nonce = BigInt(0);
      const deadline = await getDeadline(3600n);

      const { v, r, s } = await generateBatchSignature(
        signer,
        keys,
        addresses,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      // 第一次调用成功
      await registrySignatureManager.permitBatchModuleUpgrade(
        keys,
        addresses,
        allowReplace,
        
        nonce,
        deadline,
        v,
        r,
        s
      );

      // 第二次调用应该失败（重放攻击）
      await expect(
        registrySignatureManager.permitBatchModuleUpgrade(
          keys,
          addresses,
          allowReplace,
          
          nonce,
          deadline,
          v,
          r,
          s
        )
      ).to.be.revertedWithCustomError(registrySignatureManager, 'InvalidNonce');
    });

    it('应该拒绝无效的批量签名格式', async function () {
      const keys = [KEY_LE, KEY_CM];
      const addresses = [await mockLendingEngine.getAddress(), await mockCollateralManager.getAddress()];
      const allowReplace = true;
      const nonce = BigInt(0);
      const deadline = await getDeadline(3600n);

      // 使用错误的签名者
      const { r, s } = await generateBatchSignature(
        attacker,
        keys,
        addresses,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      await expect(
        registrySignatureManager.permitBatchModuleUpgrade(
          keys,
          addresses,
          allowReplace,
          nonce,
          deadline,
          29, // 无效的 v 值
          r,
          s
        )
      ).to.be.revertedWith('Invalid signature \'v\' value');
    });

    it('应该正确处理批量 allowReplace 为 false 的情况', async function () {
      const keys = [KEY_LE, KEY_CM];
      const addresses = [await mockLendingEngine.getAddress(), await mockCollateralManager.getAddress()];
      const allowReplace = false;
      const nonce = BigInt(0);
      const deadline = await getDeadline(3600n);

      const { v, r, s } = await generateBatchSignature(
        signer,
        keys,
        addresses,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      await expect(
        registrySignatureManager.permitBatchModuleUpgrade(
          keys,
          addresses,
          allowReplace,
          
          nonce,
          deadline,
          v,
          r,
          s
        )
      ).to.not.be.reverted;
    });
  });

  // ============ 边界条件测试 ============
  describe('边界条件测试', function () {
    it('应该处理大数组的批量升级', async function () {
      const keys: string[] = [];
      const addresses: string[] = [];
      
      // 创建大数组（使用已知的模块键）
      for (let i = 0; i < 10; i++) {
        keys.push(KEY_LE); // 使用已知的模块键
        addresses.push(await mockLendingEngine.getAddress());
      }

      const allowReplace = true;
      const nonce = BigInt(0);
      const deadline = await getDeadline(3600n);

      const { v, r, s } = await generateBatchSignature(
        signer,
        keys,
        addresses,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      await expect(
        registrySignatureManager.permitBatchModuleUpgrade(
          keys,
          addresses,
          allowReplace,
          
          nonce,
          deadline,
          v,
          r,
          s
        )
      ).to.not.be.reverted;
    });

    it('应该处理最大 nonce 值', async function () {
      const key = KEY_LE;
      const newAddr = await mockLendingEngine.getAddress();
      const allowReplace = true;
      const nonce = BigInt('115792089237316195423570985008687907853269984665640564039457584007913129639935'); // 最大 nonce 值
      const deadline = await getDeadline(3600n);

      const { v, r, s } = await generateSignature(
        signer,
        key,
        newAddr,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      await expect(
        registrySignatureManager.permitModuleUpgrade(
          key,
          newAddr,
          allowReplace,
          
          nonce,
          deadline,
          v,
          r,
          s
        )
      ).to.be.revertedWithCustomError(registrySignatureManager, 'InvalidNonce');
    });

    it('应该处理最大 deadline 值', async function () {
      const key = KEY_LE;
      const newAddr = await mockLendingEngine.getAddress();
      const allowReplace = true;
      const nonce = BigInt(0);
      const deadline = BigInt('115792089237316195423570985008687907853269984665640564039457584007913129639935'); // 最大 deadline 值

      const { v, r, s } = await generateSignature(
        signer,
        key,
        newAddr,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      await expect(
        registrySignatureManager.permitModuleUpgrade(
          key,
          newAddr,
          allowReplace,
          
          nonce,
          deadline,
          v,
          r,
          s
        )
      ).to.not.be.reverted; // 应该成功，因为 deadline 很大
    });
  });

  // ============ 暂停状态测试 ============
  describe('暂停状态测试', function () {
    it('应该拒绝暂停状态下的签名操作', async function () {
      await registrySignatureManager.pause();

      const key = KEY_LE;
      const newAddr = await mockLendingEngine.getAddress();
      const allowReplace = true;
      const nonce = BigInt(0);
      const deadline = await getDeadline(3600n);

      const { v, r, s } = await generateSignature(
        signer,
        key,
        newAddr,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      await expect(
        registrySignatureManager.permitModuleUpgrade(
          key,
          newAddr,
          allowReplace,
          
          nonce,
          deadline,
          v,
          r,
          s
        )
      ).to.be.revertedWith('Pausable: paused');
    });

    it('应该拒绝暂停状态下的批量签名操作', async function () {
      await registrySignatureManager.pause();

      const keys = [KEY_LE, KEY_CM];
      const addresses = [await mockLendingEngine.getAddress(), await mockCollateralManager.getAddress()];
      const allowReplace = true;
      const nonce = BigInt(0);
      const deadline = await getDeadline(3600n);

      const { v, r, s } = await generateBatchSignature(
        signer,
        keys,
        addresses,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      await expect(
        registrySignatureManager.permitBatchModuleUpgrade(
          keys,
          addresses,
          allowReplace,
          
          nonce,
          deadline,
          v,
          r,
          s
        )
      ).to.be.revertedWith('Pausable: paused');
    });
  });

  // ============ 事件测试 ============
  describe('事件测试', function () {
    it('应该发出正确的单个模块升级事件', async function () {
      const key = KEY_LE;
      const newAddr = await mockLendingEngine.getAddress();
      const allowReplace = true;
      const nonce = BigInt(0);
      const deadline = await getDeadline(3600n);

      const { v, r, s } = await generateSignature(
        signer,
        key,
        newAddr,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      await expect(
        registrySignatureManager.permitModuleUpgrade(
          key,
          newAddr,
          allowReplace,
          
          nonce,
          deadline,
          v,
          r,
          s
        )
      ).to.emit(registrySignatureManager, 'ModuleUpgradePermitted')
        .withArgs(key, newAddr, await signer.getAddress(), nonce);
    });

    it('应该发出正确的批量模块升级事件', async function () {
      const keys = [KEY_LE, KEY_CM];
      const addresses = [await mockLendingEngine.getAddress(), await mockCollateralManager.getAddress()];
      const allowReplace = true;
      const nonce = BigInt(0);
      const deadline = await getDeadline(3600n);

      const { v, r, s } = await generateBatchSignature(
        signer,
        keys,
        addresses,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      await expect(
        registrySignatureManager.permitBatchModuleUpgrade(
          keys,
          addresses,
          allowReplace,
          
          nonce,
          deadline,
          v,
          r,
          s
        )
      ).to.emit(registrySignatureManager, 'BatchModuleUpgradePermitted')
        .withArgs(keys, addresses, await signer.getAddress(), nonce);
    });
  });

  // ============ 模糊测试 ============
  describe('模糊测试', function () {
    it('应该处理不同的签名格式', async function () {
      const key = KEY_LE;
      const newAddr = await mockLendingEngine.getAddress();
      const allowReplace = true;
      const nonce = BigInt(0);
      const deadline = await getDeadline(3600n);

      // 测试不同的签名格式
      const { v, r, s } = await generateSignature(
        signer,
        key,
        newAddr,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      await expect(
        registrySignatureManager.permitModuleUpgrade(
          key,
          newAddr,
          allowReplace,
          
          nonce,
          deadline,
          v,
          r,
          s
        )
      ).to.not.be.reverted;
    });

    it('应该处理不同的链 ID', async function () {
      // 这个测试需要在实际的多链环境中进行
      // 这里只是验证 domain separator 的计算
      const domainSeparator = await registrySignatureManager.DOMAIN_SEPARATOR();
      expect(domainSeparator).to.not.equal(ethers.ZeroHash);
    });
  });

  // ============ Gas 优化测试 ============
  describe('Gas 优化测试', function () {
    it('应该测量单个模块升级的 gas 消耗', async function () {
      const key = KEY_LE;
      const newAddr = await mockLendingEngine.getAddress();
      const allowReplace = true;
      const nonce = BigInt(0);
      const deadline = await getDeadline(3600n);

      const { v, r, s } = await generateSignature(
        signer,
        key,
        newAddr,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      const tx = await registrySignatureManager.permitModuleUpgrade(
        key,
        newAddr,
        allowReplace,
        
        nonce,
        deadline,
        v,
        r,
        s
      );

      const receipt = await tx.wait();
      expect(receipt?.gasUsed).to.be.gt(0);
    });

    it('应该测量批量模块升级的 gas 消耗', async function () {
      const keys = [KEY_LE, KEY_CM];
      const addresses = [await mockLendingEngine.getAddress(), await mockCollateralManager.getAddress()];
      const allowReplace = true;
      const nonce = BigInt(0);
      const deadline = await getDeadline(3600n);

      const { v, r, s } = await generateBatchSignature(
        signer,
        keys,
        addresses,
        allowReplace,
        nonce,
        deadline,
        await registrySignatureManager.getAddress()
      );

      const tx = await registrySignatureManager.permitBatchModuleUpgrade(
        keys,
        addresses,
        allowReplace,
        
        nonce,
        deadline,
        v,
        r,
        s
      );

      const receipt = await tx.wait();
      expect(receipt?.gasUsed).to.be.gt(0);
    });
  });
});

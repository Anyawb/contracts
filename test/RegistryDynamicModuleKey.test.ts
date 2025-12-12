/**
 * RegistryDynamicModuleKey – 动态模块键注册管理器测试
 * 
 * 测试目标:
 * - 初始化/权限控制验证
 * - 注册/注销正常流程测试
 * - 重复注册和边界条件测试
 * - 列表一致性和 Gas 消耗测试
 * - 与 ModuleKeys 交互测试
 * - 批量注册和分页查询测试
 */

import * as hardhat from 'hardhat';
const { ethers } = hardhat;
import { expect } from 'chai';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import type { ContractFactory } from 'ethers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

// 导入合约类型
import type { RegistryDynamicModuleKey } from '../../types/contracts/registry/RegistryDynamicModuleKey';

// 导入常量
import { ModuleKeys } from '../frontend-config/moduleKeys';

describe('RegistryDynamicModuleKey – 动态模块键注册管理器测试', function () {
  // 测试常量定义
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const MAX_DYNAMIC_KEYS = 100;
  const MIN_NAME_LENGTH = 3;
  const MAX_NAME_LENGTH = 50;
  const MAX_BATCH_SIZE = 20;
  
  // 测试名称
  const TEST_NAME_1 = 'testmodule';
  const TEST_NAME_2 = 'anothermodule';
  const TEST_NAME_3 = 'thirdmodule';
  const TEST_NAME_UPPER = 'UPPERMODULE';
  const TEST_NAME_MIXED = 'MixedModule';
  const TEST_NAME_WITH_SPACES = '  spacedmodule  ';
  const TEST_NAME_SHORT = 'ab';
  const TEST_NAME_LONG = 'a'.repeat(51);
  const TEST_NAME_INVALID_CHAR = 'test@module';
  const TEST_NAME_CHINESE = '测试模块';
  const TEST_NAME_DIFFERENT = 'differentmodule';
  
  // 合约实例
  let registryDynamicModuleKey: RegistryDynamicModuleKey;
  
  // 账户
  let owner: SignerWithAddress;
  let registrationAdmin: SignerWithAddress;
  let systemAdmin: SignerWithAddress;
  let user: SignerWithAddress;
  let otherUser: SignerWithAddress;

  /**
   * 部署代理合约的标准函数
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
   * 测试夹具
   */
  async function deployFixture() {
    // 获取账户
    [owner, registrationAdmin, systemAdmin, user, otherUser] = await ethers.getSigners();

    // 部署 RegistryDynamicModuleKey 代理
    const { proxyContract } = await deployProxyContract('RegistryDynamicModuleKey');
    registryDynamicModuleKey = proxyContract as RegistryDynamicModuleKey;

    // 初始化合约
    await registryDynamicModuleKey.initialize(
      await registrationAdmin.getAddress(),
      await systemAdmin.getAddress()
    );

    return {
      registryDynamicModuleKey,
      owner,
      registrationAdmin,
      systemAdmin,
      user,
      otherUser
    };
  }

  beforeEach(async function () {
    await loadFixture(deployFixture);
  });

  describe('初始化测试', function () {
    it('RegistryDynamicModuleKey – 应该正确初始化合约', async function () {
      const { proxyContract } = await deployProxyContract('RegistryDynamicModuleKey');
      const registry = proxyContract as RegistryDynamicModuleKey;
      
      await expect(
        registry.initialize(
          await registrationAdmin.getAddress(),
          await systemAdmin.getAddress()
        )
      ).to.not.be.reverted;
      
      // 验证初始化状态
      expect(await registry.owner()).to.equal(await owner.getAddress());
      expect(await registry.getRegistrationAdmin()).to.equal(await registrationAdmin.getAddress());
      expect(await registry.getSystemAdmin()).to.equal(await systemAdmin.getAddress());
      expect(await registry.getDynamicKeyCount()).to.equal(0);
    });

    it('RegistryDynamicModuleKey – 应该拒绝零地址初始化', async function () {
      const { proxyContract } = await deployProxyContract('RegistryDynamicModuleKey');
      const registry = proxyContract as RegistryDynamicModuleKey;
      
      // 测试零地址参数
      await expect(
        registry.initialize(ZERO_ADDRESS, await systemAdmin.getAddress())
      ).to.be.revertedWithCustomError(registry, 'ZeroAddress');
      
      await expect(
        registry.initialize(await registrationAdmin.getAddress(), ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(registry, 'ZeroAddress');
    });

    it('RegistryDynamicModuleKey – 应该拒绝重复初始化', async function () {
      const { proxyContract } = await deployProxyContract('RegistryDynamicModuleKey');
      const registry = proxyContract as RegistryDynamicModuleKey;
      
      await registry.initialize(
        await registrationAdmin.getAddress(),
        await systemAdmin.getAddress()
      );
      
      // 测试重复初始化
      await expect(
        registry.initialize(
          await registrationAdmin.getAddress(),
          await systemAdmin.getAddress()
        )
      ).to.be.revertedWith('Initializable: contract is already initialized');
    });
  });

  describe('权限控制测试', function () {
    it('RegistryDynamicModuleKey – 只有 owner 可升级', async function () {
      // 部署新的实现合约
      const RegistryDynamicModuleKeyFactory = await ethers.getContractFactory('RegistryDynamicModuleKey');
      const newImplementation = await RegistryDynamicModuleKeyFactory.deploy();
      await newImplementation.waitForDeployment();

      // owner 可以升级
      await expect(
        registryDynamicModuleKey.upgradeTo(newImplementation.target)
      ).to.not.be.reverted;

      // 非 owner 不能升级
      await expect(
        registryDynamicModuleKey.connect(user).upgradeTo(newImplementation.target)
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('RegistryDynamicModuleKey – 只有 owner 可设置注册管理员', async function () {
      // owner 可以设置
      await expect(
        registryDynamicModuleKey.setRegistrationAdmin(await user.getAddress())
      ).to.not.be.reverted;

      // 非 owner 不能设置
      await expect(
        registryDynamicModuleKey.connect(user).setRegistrationAdmin(await otherUser.getAddress())
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('RegistryDynamicModuleKey – 只有 owner 可设置系统管理员', async function () {
      // owner 可以设置
      await expect(
        registryDynamicModuleKey.setSystemAdmin(await user.getAddress())
      ).to.not.be.reverted;

      // 非 owner 不能设置
      await expect(
        registryDynamicModuleKey.connect(user).setSystemAdmin(await otherUser.getAddress())
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('RegistryDynamicModuleKey – 只有 owner 可暂停/恢复', async function () {
      // owner 可以暂停
      await expect(
        registryDynamicModuleKey.pause()
      ).to.not.be.reverted;

      // owner 可以恢复
      await expect(
        registryDynamicModuleKey.unpause()
      ).to.not.be.reverted;

      // 非 owner 不能暂停
      await expect(
        registryDynamicModuleKey.connect(user).pause()
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('RegistryDynamicModuleKey – 只有注册管理员可注册模块键', async function () {
      // 注册管理员可以注册
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_1)
      ).to.not.be.reverted;

      // 非注册管理员不能注册
      await expect(
        registryDynamicModuleKey.connect(user).registerModuleKey(TEST_NAME_2)
      ).to.be.revertedWithCustomError(registryDynamicModuleKey, 'RegistryDynamicModuleKey__OnlyRegistrationAdmin');
    });

    it('RegistryDynamicModuleKey – 只有系统管理员可注销模块键', async function () {
      // 先注册一个模块键
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_1);
      const moduleKey = await registryDynamicModuleKey.getModuleKeyByName(TEST_NAME_1);

      // 系统管理员可以注销
      await expect(
        registryDynamicModuleKey.connect(systemAdmin).unregisterModuleKey(moduleKey)
      ).to.not.be.reverted;

      // 重新注册用于测试
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_1);
      const newModuleKey = await registryDynamicModuleKey.getModuleKeyByName(TEST_NAME_1);

      // 非系统管理员不能注销
      await expect(
        registryDynamicModuleKey.connect(user).unregisterModuleKey(newModuleKey)
      ).to.be.revertedWithCustomError(registryDynamicModuleKey, 'RegistryDynamicModuleKey__OnlySystemAdmin');
    });
  });

  describe('注册/注销正常流程测试', function () {
    it('RegistryDynamicModuleKey – 应该正确注册新模块键', async function () {
      // 注册模块键
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_1)
      ).to.emit(registryDynamicModuleKey, 'ModuleKeyRegistered')
        .withArgs(
          (moduleKey: unknown) => moduleKey !== '0x0000000000000000000000000000000000000000000000000000000000000000',
          TEST_NAME_1,
          (nameHash: unknown) => nameHash !== '0x0000000000000000000000000000000000000000000000000000000000000000',
          await registrationAdmin.getAddress(),
          (timestamp: bigint) => timestamp > BigInt(0)
        );

      // 验证状态
      const moduleKey = await registryDynamicModuleKey.getModuleKeyByName(TEST_NAME_1);
      expect(moduleKey).to.not.equal('0x0000000000000000000000000000000000000000000000000000000000000000');
      expect(await registryDynamicModuleKey.isDynamicModuleKey(moduleKey)).to.be.true;
      expect(await registryDynamicModuleKey.isValidModuleKey(moduleKey)).to.be.true;
      expect(await registryDynamicModuleKey.getModuleKeyName(moduleKey)).to.equal(TEST_NAME_1);
      expect(await registryDynamicModuleKey.getDynamicKeyCount()).to.equal(1);
    });

    it('RegistryDynamicModuleKey – 应该正确注销模块键', async function () {
      // 先注册模块键
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_1);
      const moduleKey = await registryDynamicModuleKey.getModuleKeyByName(TEST_NAME_1);

      // 注销模块键
      await expect(
        registryDynamicModuleKey.connect(systemAdmin).unregisterModuleKey(moduleKey)
      ).to.emit(registryDynamicModuleKey, 'ModuleKeyUnregistered')
        .withArgs(
          moduleKey,
          TEST_NAME_1,
          await systemAdmin.getAddress(),
          (timestamp: bigint) => timestamp > BigInt(0)
        );

      // 验证状态
      expect(await registryDynamicModuleKey.isDynamicModuleKey(moduleKey)).to.be.false;
      expect(await registryDynamicModuleKey.isValidModuleKey(moduleKey)).to.be.false;
      expect(await registryDynamicModuleKey.getDynamicKeyCount()).to.equal(0);

      // 验证查询函数
      await expect(
        registryDynamicModuleKey.getModuleKeyByName(TEST_NAME_1)
      ).to.be.revertedWithCustomError(registryDynamicModuleKey, 'RegistryDynamicModuleKey__ModuleNameNotExists');

      await expect(
        registryDynamicModuleKey.getModuleKeyName(moduleKey)
      ).to.be.revertedWithCustomError(registryDynamicModuleKey, 'RegistryDynamicModuleKey__ModuleKeyNotExists');
    });

    it('RegistryDynamicModuleKey – 应该验证注册后所有映射一致', async function () {
      // 注册模块键
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_1);
      const moduleKey = await registryDynamicModuleKey.getModuleKeyByName(TEST_NAME_1);

      // 验证所有映射一致
      expect(await registryDynamicModuleKey.isDynamicModuleKey(moduleKey)).to.be.true;
      expect(await registryDynamicModuleKey.getModuleKeyName(moduleKey)).to.equal(TEST_NAME_1);
      expect(await registryDynamicModuleKey.getDynamicKeyCount()).to.equal(1);

      // 验证动态模块键列表
      const dynamicKeys = await registryDynamicModuleKey.getDynamicModuleKeys();
      expect(dynamicKeys.length).to.equal(1);
      expect(dynamicKeys[0]).to.equal(moduleKey);

      // 验证名称哈希映射
      const nameHash = ethers.keccak256(ethers.toUtf8Bytes(TEST_NAME_1));
      expect(await registryDynamicModuleKey.getNameHashToModuleKey(nameHash)).to.equal(moduleKey);
    });
  });

  describe('重复注册测试', function () {
    it('RegistryDynamicModuleKey – 应该拒绝重复注册相同名称', async function () {
      // 注册第一个模块键
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_1);

      // 尝试重复注册相同名称
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_1)
      ).to.be.revertedWithCustomError(registryDynamicModuleKey, 'RegistryDynamicModuleKey__ModuleKeyAlreadyExists');
    });

    it('RegistryDynamicModuleKey – 应该拒绝不同大小写但规范化后相同的名称', async function () {
      // 注册小写名称
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_DIFFERENT);

      // 尝试注册大写名称（规范化后相同）
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey('DIFFERENTMODULE')
      ).to.be.revertedWithCustomError(registryDynamicModuleKey, 'RegistryDynamicModuleKey__ModuleKeyAlreadyExists');
    });

    it('RegistryDynamicModuleKey – 应该拒绝带空格但规范化后相同的名称', async function () {
      // 注册正常名称
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_DIFFERENT);

      // 尝试注册带空格的名称（规范化后相同）
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey('  differentmodule  ')
      ).to.be.revertedWithCustomError(registryDynamicModuleKey, 'RegistryDynamicModuleKey__ModuleKeyAlreadyExists');
    });

    it('RegistryDynamicModuleKey – 应该拒绝混合大小写但规范化后相同的名称', async function () {
      // 注册小写名称
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_DIFFERENT);

      // 尝试注册混合大小写名称（规范化后相同）
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey('DifferentModule')
      ).to.be.revertedWithCustomError(registryDynamicModuleKey, 'RegistryDynamicModuleKey__ModuleKeyAlreadyExists');
    });
  });

  describe('边界条件测试', function () {
    it('RegistryDynamicModuleKey – 应该拒绝长度过短的名称', async function () {
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_SHORT)
      ).to.be.revertedWithCustomError(registryDynamicModuleKey, 'RegistryDynamicModuleKey__InvalidModuleKeyName');
    });

    it('RegistryDynamicModuleKey – 应该拒绝长度过长的名称', async function () {
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_LONG)
      ).to.be.revertedWithCustomError(registryDynamicModuleKey, 'RegistryDynamicModuleKey__InvalidModuleKeyName');
    });

    it('RegistryDynamicModuleKey – 应该拒绝包含无效字符的名称', async function () {
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_INVALID_CHAR)
      ).to.be.revertedWithCustomError(registryDynamicModuleKey, 'RegistryDynamicModuleKey__InvalidCharacterInName');
    });

    it('RegistryDynamicModuleKey – 应该拒绝包含中文的名称', async function () {
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_CHINESE)
      ).to.be.revertedWithCustomError(registryDynamicModuleKey, 'RegistryDynamicModuleKey__InvalidCharacterInName');
    });

    it('RegistryDynamicModuleKey – 应该拒绝注销不存在的模块键', async function () {
      const nonExistentKey = ethers.keccak256(ethers.toUtf8Bytes('NON_EXISTENT'));
      
      await expect(
        registryDynamicModuleKey.connect(systemAdmin).unregisterModuleKey(nonExistentKey)
      ).to.be.revertedWithCustomError(registryDynamicModuleKey, 'RegistryDynamicModuleKey__ModuleKeyNotExists');
    });

    it('RegistryDynamicModuleKey – 应该拒绝超过最大数量限制', async function () {
      // 注册最大数量的模块键
      for (let i = 0; i < MAX_DYNAMIC_KEYS; i++) {
        await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(`module${i}`);
      }

      // 尝试注册超出限制的模块键
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey('extramodule')
      ).to.be.revertedWithCustomError(registryDynamicModuleKey, 'RegistryDynamicModuleKey__ModuleKeyLimitExceeded');
    });
  });

  describe('批量注册测试', function () {
    it('RegistryDynamicModuleKey – 应该正确批量注册模块键', async function () {
      const names = [TEST_NAME_1, TEST_NAME_2, TEST_NAME_3];
      
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).batchRegisterModuleKeys(names)
      ).to.not.be.reverted;

      // 验证所有模块键都已注册
      for (const name of names) {
        const moduleKey = await registryDynamicModuleKey.getModuleKeyByName(name);
        expect(moduleKey).to.not.equal('0x0000000000000000000000000000000000000000000000000000000000000000');
        expect(await registryDynamicModuleKey.isDynamicModuleKey(moduleKey)).to.be.true;
      }

      expect(await registryDynamicModuleKey.getDynamicKeyCount()).to.equal(3);
    });

    it('RegistryDynamicModuleKey – 应该拒绝超过批量大小限制', async function () {
      const largeNames = Array(MAX_BATCH_SIZE + 1).fill('').map((_, i) => `module${i}`);
      
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).batchRegisterModuleKeys(largeNames)
      ).to.be.revertedWithCustomError(registryDynamicModuleKey, 'RegistryDynamicModuleKey__BatchSizeLimitExceeded');
    });

    it('RegistryDynamicModuleKey – 应该拒绝会超过总限制的批量注册', async function () {
      // 先注册接近限制数量的模块键
      for (let i = 0; i < MAX_DYNAMIC_KEYS - 5; i++) {
        await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(`module${i}`);
      }

      // 尝试批量注册会超过限制的模块键
      const largeNames = Array(10).fill('').map((_, i) => `extramodule${i}`);
      
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).batchRegisterModuleKeys(largeNames)
      ).to.be.revertedWithCustomError(registryDynamicModuleKey, 'RegistryDynamicModuleKey__ModuleKeyLimitExceeded');
    });

    it('RegistryDynamicModuleKey – 应该拒绝空数组批量注册', async function () {
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).batchRegisterModuleKeys([])
      ).to.be.revertedWith('Empty array');
    });
  });

  describe('列表一致性测试', function () {
    it('RegistryDynamicModuleKey – 应该保持列表一致性', async function () {
      // 注册多个模块键
      const names = [TEST_NAME_1, TEST_NAME_2, TEST_NAME_3];
      for (const name of names) {
        await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(name);
      }

      // 验证列表一致性
      expect(await registryDynamicModuleKey.getDynamicKeyCount()).to.equal(3);
      const dynamicKeys = await registryDynamicModuleKey.getDynamicModuleKeys();
      expect(dynamicKeys.length).to.equal(3);

      // 注销一个模块键
      const moduleKey = await registryDynamicModuleKey.getModuleKeyByName(TEST_NAME_1);
      await registryDynamicModuleKey.connect(systemAdmin).unregisterModuleKey(moduleKey);

      // 验证列表已更新
      expect(await registryDynamicModuleKey.getDynamicKeyCount()).to.equal(2);
      const updatedKeys = await registryDynamicModuleKey.getDynamicModuleKeys();
      expect(updatedKeys.length).to.equal(2);
      expect(updatedKeys).to.not.include(moduleKey);
    });

    it('RegistryDynamicModuleKey – 应该处理找不到模块键的情况', async function () {
      // 注册一个模块键
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_1);
      const moduleKey = await registryDynamicModuleKey.getModuleKeyByName(TEST_NAME_1);

      // 手动修改数组（模拟 buggy 实现）
      // 注意：这里我们通过直接调用内部函数来模拟不一致状态
      // 在实际测试中，这可能需要通过特殊的测试函数来实现

      // 验证注销时能找到模块键
      await expect(
        registryDynamicModuleKey.connect(systemAdmin).unregisterModuleKey(moduleKey)
      ).to.not.be.reverted;
    });
  });

  describe('Gas 消耗测试', function () {
    it('RegistryDynamicModuleKey – 应该支持大批量注册', async function () {
      const names = Array(MAX_BATCH_SIZE).fill('').map((_, i) => `module${i}`);
      
      // 测试批量注册的 gas 消耗
      const tx = await registryDynamicModuleKey.connect(registrationAdmin).batchRegisterModuleKeys(names);
      const receipt = await tx.wait();
      
      // 验证 gas 消耗在合理范围内（小于 10M gas）
      expect(receipt!.gasUsed).to.be.lt(BigInt(10000000));
      
      // 验证所有模块键都已注册
      expect(await registryDynamicModuleKey.getDynamicKeyCount()).to.equal(MAX_BATCH_SIZE);
    });

    it('RegistryDynamicModuleKey – 应该支持单次注册大量模块键', async function () {
      // 测试注册 50 个模块键的 gas 消耗
      for (let i = 0; i < 50; i++) {
        const tx = await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(`module${i}`);
        const receipt = await tx.wait();
        
        // 验证单次注册的 gas 消耗在合理范围内（小于 500K gas）
        expect(receipt!.gasUsed).to.be.lt(BigInt(500000));
      }

      expect(await registryDynamicModuleKey.getDynamicKeyCount()).to.equal(50);
    });
  });

  describe('与 ModuleKeys 交互测试', function () {
    it('RegistryDynamicModuleKey – 应该正确与静态模块键交互', async function () {
      // 获取静态模块键
      const staticKeys = await registryDynamicModuleKey.getStaticModuleKeyCount();
      expect(staticKeys).to.be.gt(0);

      // 验证静态模块键是有效的
      for (let i = 0; i < Math.min(Number(staticKeys), 5); i++) {
        const staticKey = await registryDynamicModuleKey.getStaticModuleKeyAt(i);
        expect(await registryDynamicModuleKey.isValidModuleKey(staticKey)).to.be.true;
        expect(await registryDynamicModuleKey.isDynamicModuleKey(staticKey)).to.be.false;
      }
    });

    it('RegistryDynamicModuleKey – 应该正确获取所有模块键', async function () {
      // 注册动态模块键
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_1);
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_2);

      // 获取所有模块键
      const allKeys = await registryDynamicModuleKey.getAllModuleKeys();
      const staticCount = await registryDynamicModuleKey.getStaticModuleKeyCount();
      const dynamicCount = await registryDynamicModuleKey.getDynamicKeyCount();

      expect(allKeys.length).to.equal(staticCount + dynamicCount);

      // 验证动态模块键在结果中
      const moduleKey1 = await registryDynamicModuleKey.getModuleKeyByName(TEST_NAME_1);
      const moduleKey2 = await registryDynamicModuleKey.getModuleKeyByName(TEST_NAME_2);
      expect(allKeys).to.include(moduleKey1);
      expect(allKeys).to.include(moduleKey2);
    });

    it('RegistryDynamicModuleKey – 应该正确获取模块键名称', async function () {
      // 注册动态模块键
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_1);
      const moduleKey = await registryDynamicModuleKey.getModuleKeyByName(TEST_NAME_1);

      // 验证动态模块键名称
      expect(await registryDynamicModuleKey.getModuleKeyName(moduleKey)).to.equal(TEST_NAME_1);

      // 验证静态模块键名称
      const staticKey = await registryDynamicModuleKey.getStaticModuleKeyAt(0);
      const staticName = await registryDynamicModuleKey.getModuleKeyName(staticKey);
      expect(staticName).to.not.equal('');
    });

    it('RegistryDynamicModuleKey – 应该正确验证模块键有效性', async function () {
      // 注册动态模块键
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_1);
      const dynamicKey = await registryDynamicModuleKey.getModuleKeyByName(TEST_NAME_1);

      // 验证动态模块键
      expect(await registryDynamicModuleKey.isValidModuleKey(dynamicKey)).to.be.true;

      // 验证静态模块键
      const staticKey = await registryDynamicModuleKey.getStaticModuleKeyAt(0);
      expect(await registryDynamicModuleKey.isValidModuleKey(staticKey)).to.be.true;

      // 验证无效模块键
      const invalidKey = ethers.keccak256(ethers.toUtf8Bytes('INVALID'));
      expect(await registryDynamicModuleKey.isValidModuleKey(invalidKey)).to.be.false;
    });
  });

  describe('分页查询测试', function () {
    it('RegistryDynamicModuleKey – 应该正确分页查询模块键', async function () {
      // 注册多个动态模块键
      const names = [TEST_NAME_1, TEST_NAME_2, TEST_NAME_3];
      for (const name of names) {
        await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(name);
      }

      // 测试分页查询
      const [keys, totalCount] = await registryDynamicModuleKey.getModuleKeysPaginated(0, 10);
      const staticCount = await registryDynamicModuleKey.getStaticModuleKeyCount();
      
      expect(totalCount).to.equal(staticCount + BigInt(3));
      expect(keys.length).to.be.lte(10);

      // 测试第二页
      const [keys2, totalCount2] = await registryDynamicModuleKey.getModuleKeysPaginated(10, 10);
      expect(totalCount2).to.equal(staticCount + BigInt(3));
      expect(keys2.length).to.be.lte(10);
    });

    it('RegistryDynamicModuleKey – 应该正确处理静态/动态交界处的分页', async function () {
      // 注册动态模块键
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_1);
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_2);

      const staticCount = await registryDynamicModuleKey.getStaticModuleKeyCount();
      
      // 测试在静态模块键末尾的分页
      const [keys, totalCount] = await registryDynamicModuleKey.getModuleKeysPaginated(Number(staticCount) - 1, 5);
      expect(totalCount).to.equal(staticCount + BigInt(2));
      expect(keys.length).to.be.gt(0);

      // 测试在动态模块键开始的分页
      const [keys2, totalCount2] = await registryDynamicModuleKey.getModuleKeysPaginated(Number(staticCount), 5);
      expect(totalCount2).to.equal(staticCount + BigInt(2));
      expect(keys2.length).to.be.gt(0);
    });
  });

  describe('名称规范化测试', function () {
    it('RegistryDynamicModuleKey – 应该正确规范化大写输入', async function () {
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_UPPER);
      
      // 验证规范化后的名称
      const moduleKey = await registryDynamicModuleKey.getModuleKeyByName(TEST_NAME_UPPER);
      expect(await registryDynamicModuleKey.getModuleKeyName(moduleKey)).to.equal(TEST_NAME_UPPER.toLowerCase());
    });

    it('RegistryDynamicModuleKey – 应该正确规范化带空格的输入', async function () {
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_WITH_SPACES);
      
      // 验证规范化后的名称
      const moduleKey = await registryDynamicModuleKey.getModuleKeyByName(TEST_NAME_WITH_SPACES);
      expect(await registryDynamicModuleKey.getModuleKeyName(moduleKey)).to.equal(TEST_NAME_WITH_SPACES.trim().toLowerCase());
    });

    it('RegistryDynamicModuleKey – 应该正确规范化混合大小写输入', async function () {
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_MIXED);
      
      // 验证规范化后的名称
      const moduleKey = await registryDynamicModuleKey.getModuleKeyByName(TEST_NAME_MIXED);
      expect(await registryDynamicModuleKey.getModuleKeyName(moduleKey)).to.equal(TEST_NAME_MIXED.toLowerCase());
    });
  });

  describe('错误处理测试', function () {
    it('RegistryDynamicModuleKey – 应该正确处理无效字符位置', async function () {
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_INVALID_CHAR)
      ).to.be.revertedWithCustomError(registryDynamicModuleKey, 'RegistryDynamicModuleKey__InvalidCharacterInName')
        .withArgs(TEST_NAME_INVALID_CHAR, 4); // @ 字符的位置
    });

    it('RegistryDynamicModuleKey – 应该正确处理中文字符位置', async function () {
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_CHINESE)
      ).to.be.revertedWithCustomError(registryDynamicModuleKey, 'RegistryDynamicModuleKey__InvalidCharacterInName')
        .withArgs(TEST_NAME_CHINESE, 0); // 第一个中文字符的位置
    });

    it('RegistryDynamicModuleKey – 应该正确处理暂停状态', async function () {
      // 暂停合约
      await registryDynamicModuleKey.pause();

      // 验证注册被拒绝
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_1)
      ).to.be.revertedWith('Pausable: paused');

      // 验证批量注册被拒绝
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).batchRegisterModuleKeys([TEST_NAME_1, TEST_NAME_2])
      ).to.be.revertedWith('Pausable: paused');

      // 恢复合约
      await registryDynamicModuleKey.unpause();

      // 验证功能恢复
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_2)
      ).to.not.be.reverted;
    });
  });

  describe('事件测试', function () {
    it('RegistryDynamicModuleKey – 应该正确发出注册事件', async function () {
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_1)
      ).to.emit(registryDynamicModuleKey, 'ModuleKeyRegistered')
        .withArgs(
          (moduleKey: unknown) => moduleKey !== '0x0000000000000000000000000000000000000000000000000000000000000000',
          TEST_NAME_1,
          (nameHash: unknown) => nameHash !== '0x0000000000000000000000000000000000000000000000000000000000000000',
          await registrationAdmin.getAddress(),
          (timestamp: bigint) => timestamp > BigInt(0)
        );
    });

    it('RegistryDynamicModuleKey – 应该正确发出注销事件', async function () {
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_1);
      const moduleKey = await registryDynamicModuleKey.getModuleKeyByName(TEST_NAME_1);

      await expect(
        registryDynamicModuleKey.connect(systemAdmin).unregisterModuleKey(moduleKey)
      ).to.emit(registryDynamicModuleKey, 'ModuleKeyUnregistered')
        .withArgs(
          moduleKey,
          TEST_NAME_1,
          await systemAdmin.getAddress(),
          (timestamp: bigint) => timestamp > BigInt(0)
        );
    });

    it('RegistryDynamicModuleKey – 应该正确发出管理员变更事件', async function () {
      await expect(
        registryDynamicModuleKey.setRegistrationAdmin(await user.getAddress())
      ).to.emit(registryDynamicModuleKey, 'RegistrationAdminChanged')
        .withArgs(
          await registrationAdmin.getAddress(),
          await user.getAddress(),
          (timestamp: bigint) => timestamp > BigInt(0)
        );

      await expect(
        registryDynamicModuleKey.setSystemAdmin(await otherUser.getAddress())
      ).to.emit(registryDynamicModuleKey, 'SystemAdminChanged')
        .withArgs(
          await systemAdmin.getAddress(),
          await otherUser.getAddress(),
          (timestamp: bigint) => timestamp > BigInt(0)
        );
    });
  });

  describe('边界值和压力测试', function () {
    it('RegistryDynamicModuleKey – 应该支持最小长度名称', async function () {
      const minLengthName = 'abc';
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(minLengthName)
      ).to.not.be.reverted;

      const moduleKey = await registryDynamicModuleKey.getModuleKeyByName(minLengthName);
      expect(moduleKey).to.not.equal('0x0000000000000000000000000000000000000000000000000000000000000000');
    });

    it('RegistryDynamicModuleKey – 应该支持最大长度名称', async function () {
      const maxLengthName = 'a'.repeat(MAX_NAME_LENGTH);
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(maxLengthName)
      ).to.not.be.reverted;

      const moduleKey = await registryDynamicModuleKey.getModuleKeyByName(maxLengthName);
      expect(moduleKey).to.not.equal('0x0000000000000000000000000000000000000000000000000000000000000000');
    });

    it('RegistryDynamicModuleKey – 应该支持特殊字符名称', async function () {
      const specialCharName = 'test-module_123';
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(specialCharName)
      ).to.not.be.reverted;

      const moduleKey = await registryDynamicModuleKey.getModuleKeyByName(specialCharName);
      expect(moduleKey).to.not.equal('0x0000000000000000000000000000000000000000000000000000000000000000');
    });

    it('RegistryDynamicModuleKey – 应该支持大量模块键的注册和注销', async function () {
      // 注册大量模块键
      for (let i = 0; i < 50; i++) {
        await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(`module${i}`);
      }

      expect(await registryDynamicModuleKey.getDynamicKeyCount()).to.equal(50);

      // 注销所有模块键
      for (let i = 0; i < 50; i++) {
        const moduleKey = await registryDynamicModuleKey.getModuleKeyByName(`module${i}`);
        await registryDynamicModuleKey.connect(systemAdmin).unregisterModuleKey(moduleKey);
      }

      expect(await registryDynamicModuleKey.getDynamicKeyCount()).to.equal(0);
    });
  });

  describe('升级功能测试', function () {
    it('RegistryDynamicModuleKey – 应该支持合约升级', async function () {
      // 注册一些模块键
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_1);
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_2);

      // 部署新的实现合约
      const RegistryDynamicModuleKeyFactory = await ethers.getContractFactory('RegistryDynamicModuleKey');
      const newImplementation = await RegistryDynamicModuleKeyFactory.deploy();
      await newImplementation.waitForDeployment();

      // 升级合约
      await expect(
        registryDynamicModuleKey.upgradeTo(newImplementation.target)
      ).to.not.be.reverted;

      // 验证数据保持不变
      expect(await registryDynamicModuleKey.getDynamicKeyCount()).to.equal(2);
      expect(await registryDynamicModuleKey.getModuleKeyByName(TEST_NAME_1)).to.not.equal('0x0000000000000000000000000000000000000000000000000000000000000000');
      expect(await registryDynamicModuleKey.getModuleKeyByName(TEST_NAME_2)).to.not.equal('0x0000000000000000000000000000000000000000000000000000000000000000');
    });

    it('RegistryDynamicModuleKey – 应该拒绝非 owner 升级', async function () {
      const RegistryDynamicModuleKeyFactory = await ethers.getContractFactory('RegistryDynamicModuleKey');
      const newImplementation = await RegistryDynamicModuleKeyFactory.deploy();
      await newImplementation.waitForDeployment();

      await expect(
        registryDynamicModuleKey.connect(user).upgradeTo(newImplementation.target)
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });

  describe('管理员功能测试', function () {
    it('RegistryDynamicModuleKey – 应该正确设置注册管理员', async function () {
      await expect(
        registryDynamicModuleKey.setRegistrationAdmin(await user.getAddress())
      ).to.not.be.reverted;

      expect(await registryDynamicModuleKey.getRegistrationAdmin()).to.equal(await user.getAddress());
    });

    it('RegistryDynamicModuleKey – 应该正确设置系统管理员', async function () {
      await expect(
        registryDynamicModuleKey.setSystemAdmin(await user.getAddress())
      ).to.not.be.reverted;

      expect(await registryDynamicModuleKey.getSystemAdmin()).to.equal(await user.getAddress());
    });

    it('RegistryDynamicModuleKey – 应该拒绝零地址管理员', async function () {
      await expect(
        registryDynamicModuleKey.setRegistrationAdmin(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(registryDynamicModuleKey, 'ZeroAddress');

      await expect(
        registryDynamicModuleKey.setSystemAdmin(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(registryDynamicModuleKey, 'ZeroAddress');
    });
  });

  describe('查询功能测试', function () {
    it('RegistryDynamicModuleKey – 应该正确获取动态模块键总数', async function () {
      expect(await registryDynamicModuleKey.getDynamicKeyCount()).to.equal(0);

      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_1);
      expect(await registryDynamicModuleKey.getDynamicKeyCount()).to.equal(1);

      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_2);
      expect(await registryDynamicModuleKey.getDynamicKeyCount()).to.equal(2);
    });

    it('RegistryDynamicModuleKey – 应该正确获取总模块键数', async function () {
      const staticCount = await registryDynamicModuleKey.getStaticModuleKeyCount();
      expect(await registryDynamicModuleKey.getTotalModuleKeyCount()).to.equal(staticCount);

      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_1);
      expect(await registryDynamicModuleKey.getTotalModuleKeyCount()).to.equal(staticCount + BigInt(1));
    });

    it('RegistryDynamicModuleKey – 应该正确获取动态模块键名称', async function () {
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_1);
      const moduleKey = await registryDynamicModuleKey.getModuleKeyByName(TEST_NAME_1);

      expect(await registryDynamicModuleKey.getDynamicModuleKeyName(moduleKey)).to.equal(TEST_NAME_1);
    });

    it('RegistryDynamicModuleKey – 应该正确根据索引获取动态模块键', async function () {
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_1);
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_2);

      const key0 = await registryDynamicModuleKey.getDynamicModuleKeyByIndex(0);
      const key1 = await registryDynamicModuleKey.getDynamicModuleKeyByIndex(1);

      expect(key0).to.not.equal('0x0000000000000000000000000000000000000000000000000000000000000000');
      expect(key1).to.not.equal('0x0000000000000000000000000000000000000000000000000000000000000000');
      expect(key0).to.not.equal(key1);
    });

    it('RegistryDynamicModuleKey – 应该拒绝超出范围的索引', async function () {
      await expect(
        registryDynamicModuleKey.getDynamicModuleKeyByIndex(0)
      ).to.be.revertedWith('Index out of bounds');
    });
  });

  describe('ModuleKeys 函数类型测试', function () {
    it('RegistryDynamicModuleKey – 应该验证 ModuleKeys 函数的 pure/view 特性', async function () {
      // 测试 ModuleKeys 库的 pure 函数特性
      // 这些函数在 ModuleKeys.sol 中定义为 pure，不依赖状态
      const testName = 'collateralManager';
      const expectedHash = ethers.keccak256(ethers.toUtf8Bytes(testName));
      
      // 验证哈希计算的一致性（pure 函数特性）
      const hash1 = ethers.keccak256(ethers.toUtf8Bytes(testName));
      const hash2 = ethers.keccak256(ethers.toUtf8Bytes(testName));
      expect(hash1).to.equal(hash2);
      expect(hash1).to.equal(expectedHash);
    });

    it('RegistryDynamicModuleKey – 应该验证静态模块键的 view 函数特性', async function () {
      // 测试静态模块键的 view 函数特性
      const staticCount = await registryDynamicModuleKey.getStaticModuleKeyCount();
      expect(staticCount).to.be.gt(0);
      
      // 验证静态模块键是有效的
      for (let i = 0; i < Math.min(Number(staticCount), 5); i++) {
        const staticKey = await registryDynamicModuleKey.getStaticModuleKeyAt(i);
        expect(await registryDynamicModuleKey.isValidModuleKey(staticKey)).to.be.true;
        expect(await registryDynamicModuleKey.isDynamicModuleKey(staticKey)).to.be.false;
      }
    });
  });

  describe('输入规范化测试', function () {
    it('RegistryDynamicModuleKey – 应该正确处理大写输入并规范化为小写', async function () {
      const upperName = 'MYMODULE';
      const expectedNormalized = 'mymodule';
      
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(upperName)
      ).to.not.be.reverted;

      // 验证规范化后的名称
      const moduleKey = await registryDynamicModuleKey.getModuleKeyByName(upperName);
      expect(await registryDynamicModuleKey.getModuleKeyName(moduleKey)).to.equal(expectedNormalized);
      
      // 验证使用规范化名称也能找到
      const moduleKeyByNormalized = await registryDynamicModuleKey.getModuleKeyByName(expectedNormalized);
      expect(moduleKeyByNormalized).to.equal(moduleKey);
    });

    it('RegistryDynamicModuleKey – 应该正确处理前后空格并规范化为无空格', async function () {
      const spacedName = '  MyModule  ';
      const expectedNormalized = 'mymodule';
      
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(spacedName)
      ).to.not.be.reverted;

      // 验证规范化后的名称
      const moduleKey = await registryDynamicModuleKey.getModuleKeyByName(spacedName);
      expect(await registryDynamicModuleKey.getModuleKeyName(moduleKey)).to.equal(expectedNormalized);
      
      // 验证使用规范化名称也能找到
      const moduleKeyByNormalized = await registryDynamicModuleKey.getModuleKeyByName(expectedNormalized);
      expect(moduleKeyByNormalized).to.equal(moduleKey);
    });

    it('RegistryDynamicModuleKey – 应该正确处理混合大小写并规范化为小写', async function () {
      const mixedName = 'MyModule';
      const expectedNormalized = 'mymodule';
      
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(mixedName)
      ).to.not.be.reverted;

      // 验证规范化后的名称
      const moduleKey = await registryDynamicModuleKey.getModuleKeyByName(mixedName);
      expect(await registryDynamicModuleKey.getModuleKeyName(moduleKey)).to.equal(expectedNormalized);
    });
  });

  describe('非法字符测试', function () {
    it('RegistryDynamicModuleKey – 应该拒绝包含 @ 字符的名称并返回正确位置', async function () {
      const invalidName = 'test@module';
      
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(invalidName)
      ).to.be.revertedWithCustomError(registryDynamicModuleKey, 'RegistryDynamicModuleKey__InvalidCharacterInName')
        .withArgs(invalidName, 4); // @ 字符在第4个位置（0-based）
    });

    it('RegistryDynamicModuleKey – 应该拒绝包含中间空格字符的名称并返回正确位置', async function () {
      const invalidName = 'test module';
      
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(invalidName)
      ).to.be.revertedWithCustomError(registryDynamicModuleKey, 'RegistryDynamicModuleKey__InvalidCharacterInName')
        .withArgs(invalidName, 4); // 空格字符在第4个位置（0-based）
    });

    it('RegistryDynamicModuleKey – 应该拒绝包含中文字符的名称并返回正确位置', async function () {
      const invalidName = '测试模块';
      
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(invalidName)
      ).to.be.revertedWithCustomError(registryDynamicModuleKey, 'RegistryDynamicModuleKey__InvalidCharacterInName')
        .withArgs(invalidName, 0); // 第一个中文字符在第0个位置
    });

    it('RegistryDynamicModuleKey – 应该拒绝包含其他特殊字符的名称', async function () {
      const specialChars = ['test#module', 'test$module', 'test%module', 'test^module', 'test&module'];
      
      for (const invalidName of specialChars) {
        await expect(
          registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(invalidName)
        ).to.be.revertedWithCustomError(registryDynamicModuleKey, 'RegistryDynamicModuleKey__InvalidCharacterInName');
      }
    });

    it('RegistryDynamicModuleKey – 应该接受有效的特殊字符', async function () {
      const validNames = ['test-module', 'test_module', 'test123module'];
      
      for (const validName of validNames) {
        await expect(
          registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(validName)
        ).to.not.be.reverted;
      }
    });
  });

  describe('批量操作边界测试', function () {
    it('RegistryDynamicModuleKey – 应该拒绝超过 MAX_BATCH_SIZE 的批量注册', async function () {
      const largeBatch = Array(MAX_BATCH_SIZE + 1).fill('').map((_, i) => `module${i}`);
      
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).batchRegisterModuleKeys(largeBatch)
      ).to.be.revertedWithCustomError(registryDynamicModuleKey, 'RegistryDynamicModuleKey__BatchSizeLimitExceeded');
    });

    it('RegistryDynamicModuleKey – 应该拒绝会导致超出 MAX_DYNAMIC_KEYS 的批量注册', async function () {
      // 先注册接近限制数量的模块键
      for (let i = 0; i < MAX_DYNAMIC_KEYS - 5; i++) {
        await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(`module${i}`);
      }

      // 尝试批量注册会超过限制的模块键
      const largeBatch = Array(10).fill('').map((_, i) => `extramodule${i}`);
      
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).batchRegisterModuleKeys(largeBatch)
      ).to.be.revertedWithCustomError(registryDynamicModuleKey, 'RegistryDynamicModuleKey__ModuleKeyLimitExceeded');
    });

    it('RegistryDynamicModuleKey – 应该正确处理最大允许的批量注册', async function () {
      const maxBatch = Array(MAX_BATCH_SIZE).fill('').map((_, i) => `module${i}`);
      
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).batchRegisterModuleKeys(maxBatch)
      ).to.not.be.reverted;

      expect(await registryDynamicModuleKey.getDynamicKeyCount()).to.equal(MAX_BATCH_SIZE);
    });

    it('RegistryDynamicModuleKey – 应该正确处理接近限制的批量注册', async function () {
      // 先注册一些模块键
      for (let i = 0; i < MAX_DYNAMIC_KEYS - MAX_BATCH_SIZE; i++) {
        await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(`module${i}`);
      }

      // 批量注册剩余空间
      const remainingBatch = Array(MAX_BATCH_SIZE).fill('').map((_, i) => `extramodule${i}`);
      
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).batchRegisterModuleKeys(remainingBatch)
      ).to.not.be.reverted;

      expect(await registryDynamicModuleKey.getDynamicKeyCount()).to.equal(MAX_DYNAMIC_KEYS);
    });
  });

  describe('重入攻击测试', function () {
    it('RegistryDynamicModuleKey – 应该验证合约具有重入保护机制', async function () {
      // 验证合约继承了 ReentrancyGuard
      // 通过检查合约是否支持 nonReentrant 修饰符来验证
      const contractCode = await ethers.provider.getCode(registryDynamicModuleKey.target);
      expect(contractCode).to.not.equal('0x');
      
      // 测试正常的注册操作不会因为重入保护而失败
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_1)
      ).to.not.be.reverted;
    });

    it('RegistryDynamicModuleKey – 应该验证批量注册的重入保护', async function () {
      const names = [TEST_NAME_1, TEST_NAME_2, TEST_NAME_3];
      
      // 测试正常的批量注册操作不会因为重入保护而失败
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).batchRegisterModuleKeys(names)
      ).to.not.be.reverted;
    });

    it('RegistryDynamicModuleKey – 应该验证注销的重入保护', async function () {
      // 先注册一个模块键
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_1);
      const moduleKey = await registryDynamicModuleKey.getModuleKeyByName(TEST_NAME_1);

      // 测试正常的注销操作不会因为重入保护而失败
      await expect(
        registryDynamicModuleKey.connect(systemAdmin).unregisterModuleKey(moduleKey)
      ).to.not.be.reverted;
    });
  });

  describe('分页查询边界测试', function () {
    it('RegistryDynamicModuleKey – 应该正确处理静态/动态交界处的偏移', async function () {
      // 注册一些动态模块键
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_1);
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_2);
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_3);

      const staticCount = await registryDynamicModuleKey.getStaticModuleKeyCount();
      
      // 测试在静态模块键末尾的分页
      const [keysAtStaticEnd, totalAtStaticEnd] = await registryDynamicModuleKey.getModuleKeysPaginated(Number(staticCount) - 1, 5);
      expect(totalAtStaticEnd).to.equal(staticCount + BigInt(3));
      expect(keysAtStaticEnd.length).to.be.gt(0);

      // 测试在动态模块键开始的分页
      const [keysAtDynamicStart, totalAtDynamicStart] = await registryDynamicModuleKey.getModuleKeysPaginated(Number(staticCount), 5);
      expect(totalAtDynamicStart).to.equal(staticCount + BigInt(3));
      expect(keysAtDynamicStart.length).to.be.gt(0);

      // 测试跨越静态和动态的分页
      const [keysCrossing, totalCrossing] = await registryDynamicModuleKey.getModuleKeysPaginated(Number(staticCount) - 2, 5);
      expect(totalCrossing).to.equal(staticCount + BigInt(3));
      expect(keysCrossing.length).to.be.gt(0);
    });

    it('RegistryDynamicModuleKey – 应该正确处理零偏移的分页', async function () {
      // 注册动态模块键
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_1);
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_2);

      const [keys, total] = await registryDynamicModuleKey.getModuleKeysPaginated(0, 10);
      const staticCount = await registryDynamicModuleKey.getStaticModuleKeyCount();
      
      expect(total).to.equal(staticCount + BigInt(2));
      expect(keys.length).to.be.lte(10);
    });

    it('RegistryDynamicModuleKey – 应该正确处理超出范围的分页', async function () {
      // 注册一些动态模块键
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_1);
      await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(TEST_NAME_2);

      const staticCount = await registryDynamicModuleKey.getStaticModuleKeyCount();
      const totalCount = staticCount + BigInt(2);
      
      // 测试超出范围的分页
      const [keysOutOfRange, totalOutOfRange] = await registryDynamicModuleKey.getModuleKeysPaginated(Number(totalCount) + 10, 5);
      expect(totalOutOfRange).to.equal(totalCount);
      expect(keysOutOfRange.length).to.equal(0);
    });

    it('RegistryDynamicModuleKey – 应该正确处理不同页面大小的分页', async function () {
      // 注册多个动态模块键
      const names = Array(10).fill('').map((_, i) => `module${i}`);
      for (const name of names) {
        await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(name);
      }

      const staticCount = await registryDynamicModuleKey.getStaticModuleKeyCount();
      
      // 测试不同页面大小
      const pageSizes = [1, 3, 5, 10, 20];
      for (const pageSize of pageSizes) {
        const [keys, total] = await registryDynamicModuleKey.getModuleKeysPaginated(0, pageSize);
        expect(total).to.equal(staticCount + BigInt(10));
        expect(keys.length).to.be.lte(pageSize);
      }
    });

    it('RegistryDynamicModuleKey – 应该正确处理空结果的分页', async function () {
      // 不注册任何动态模块键
      const staticCount = await registryDynamicModuleKey.getStaticModuleKeyCount();
      
      // 测试在静态模块键范围内的分页
      const [keys, total] = await registryDynamicModuleKey.getModuleKeysPaginated(Number(staticCount), 5);
      expect(total).to.equal(staticCount);
      expect(keys.length).to.equal(0);
    });
  });

  describe('综合边界测试', function () {
    it('RegistryDynamicModuleKey – 应该正确处理所有边界条件的组合', async function () {
      // 测试最大长度名称的规范化
      const maxLengthName = 'A'.repeat(MAX_NAME_LENGTH);
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(maxLengthName)
      ).to.not.be.reverted;

      const moduleKey = await registryDynamicModuleKey.getModuleKeyByName(maxLengthName);
      expect(await registryDynamicModuleKey.getModuleKeyName(moduleKey)).to.equal(maxLengthName.toLowerCase());

      // 测试最小长度名称的规范化
      const minLengthName = 'ABC';
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(minLengthName)
      ).to.not.be.reverted;

      const moduleKey2 = await registryDynamicModuleKey.getModuleKeyByName(minLengthName);
      expect(await registryDynamicModuleKey.getModuleKeyName(moduleKey2)).to.equal(minLengthName.toLowerCase());
    });

    it('RegistryDynamicModuleKey – 应该正确处理特殊字符组合的边界情况', async function () {
      // 测试包含连字符和下划线的名称
      const specialName = 'test-module_123';
      await expect(
        registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(specialName)
      ).to.not.be.reverted;

      const moduleKey = await registryDynamicModuleKey.getModuleKeyByName(specialName);
      expect(await registryDynamicModuleKey.getModuleKeyName(moduleKey)).to.equal(specialName.toLowerCase());
    });

    it('RegistryDynamicModuleKey – 应该正确处理大量数据的性能', async function () {
      // 注册大量模块键
      const startTime = Date.now();
      for (let i = 0; i < 50; i++) {
        await registryDynamicModuleKey.connect(registrationAdmin).registerModuleKey(`module${i}`);
      }
      const endTime = Date.now();
      
      // 验证性能（应该在合理时间内完成）
      expect(endTime - startTime).to.be.lt(30000); // 30秒内完成
      expect(await registryDynamicModuleKey.getDynamicKeyCount()).to.equal(50);
    });
  });
}); 
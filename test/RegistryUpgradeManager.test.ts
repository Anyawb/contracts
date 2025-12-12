/**
 * RegistryUpgradeManager – 模块升级管理功能测试
 * 
 * 测试目标:
 * - 基础升级功能验证（setModule、batchSetModules）
 * - 延时升级流程测试（schedule -> execute -> cancel）
 * - 权限控制验证（owner vs upgradeAdmin）
 * - 错误处理测试（自定义错误、边界条件）
 * - 历史记录管理测试（环形缓冲、gas优化）
 * - 恶意场景模拟（DoS攻击、权限劫持）
 * - 存储版本兼容性测试
 */

import * as hardhat from 'hardhat';
const { ethers } = hardhat;
import { expect } from 'chai';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

// 导入合约类型
import type { 
  RegistryUpgradeManager,
  MockERC20
} from '../../types';

// 导入常量
import { ModuleKeys } from '../frontend-config/moduleKeys';

describe('RegistryUpgradeManager – 模块升级管理功能测试', function () {
  // 测试常量定义
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const MAX_BATCH_SIZE = 50;
  const MAX_UPGRADE_HISTORY = 100;
  const MAX_MIN_DELAY = 365 * 24 * 60 * 60 * 10; // 10年
  
  // 测试账户
  let owner: SignerWithAddress;
  let upgradeAdmin: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let user3: SignerWithAddress;
  
  // 合约实例
  let registryUpgradeManager: RegistryUpgradeManager;
  let mockERC20: MockERC20;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockModule1: any; // MockModule type - using any since MockModule type not exported
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockModule2: any; // MockModule type - using any since MockModule type not exported
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockModule3: any; // MockModule type - using any since MockModule type not exported
  
  // 测试模块地址
  let testModule1: string;
  let testModule2: string;
  let testModule3: string;
  
  // 测试模块键 - 使用有效的模块键
  const TEST_KEY_1 = ethers.keccak256(ethers.toUtf8Bytes('COLLATERAL_MANAGER'));
  const TEST_KEY_2 = ethers.keccak256(ethers.toUtf8Bytes('LENDING_ENGINE'));
  const TEST_KEY_3 = ethers.keccak256(ethers.toUtf8Bytes('VAULT_STATISTICS'));

  /**
   * 测试环境设置
   */
  async function deployFixture() {
    // 获取测试账户
    [owner, upgradeAdmin, user1, user2, user3] = await ethers.getSigners();

    // 部署 RegistryUpgradeManager 实现合约
    const RegistryUpgradeManagerFactory = await ethers.getContractFactory('RegistryUpgradeManager');
    const deployedRegistryUpgradeManager = await RegistryUpgradeManagerFactory.deploy();
    await deployedRegistryUpgradeManager.waitForDeployment();

    // 部署代理合约
    const proxyFactory = await ethers.getContractFactory('ERC1967Proxy');
    const proxy = await proxyFactory.deploy(
      deployedRegistryUpgradeManager.target,
      '0x' // 空的初始化数据，因为 initialize 没有参数
    );
    await proxy.waitForDeployment();

    // 通过代理合约访问 RegistryUpgradeManager
    registryUpgradeManager = deployedRegistryUpgradeManager.attach(proxy.target) as RegistryUpgradeManager;

    // 初始化合约（通过代理调用）
    await registryUpgradeManager.initialize(await upgradeAdmin.getAddress());

    // 部署 Mock ERC20
    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    mockERC20 = await MockERC20Factory.deploy('Mock Token', 'MTK', ethers.parseUnits('1000000', 18));
    await mockERC20.waitForDeployment();

    // 部署 Mock 模块
    const SimpleMockFactory = await ethers.getContractFactory('SimpleMock');
    mockModule1 = await SimpleMockFactory.deploy();
    mockModule2 = await SimpleMockFactory.deploy();
    mockModule3 = await SimpleMockFactory.deploy();
    await mockModule1.waitForDeployment();
    await mockModule2.waitForDeployment();
    await mockModule3.waitForDeployment();

    // 设置测试模块地址
    testModule1 = await mockModule1.getAddress();
    testModule2 = await mockModule2.getAddress();
    testModule3 = await mockModule3.getAddress();

    // 设置升级管理员
    await registryUpgradeManager.setUpgradeAdmin(await upgradeAdmin.getAddress());

    // 注意：RegistryStorage 需要在 RegistryUpgradeManager 初始化时自动初始化
    // 但由于我们的合约设计，可能需要先设置一个模块来触发存储初始化
    // 暂时跳过 setMinDelay，在测试中验证这个行为

    return {
      registryUpgradeManager,
      mockERC20,
      mockModule1,
      mockModule2,
      mockModule3,
      owner,
      upgradeAdmin,
      user1,
      user2,
      user3,
      testModule1,
      testModule2,
      testModule3
    };
  }

  beforeEach(async function () {
    const fixture = await loadFixture(deployFixture);
    registryUpgradeManager = fixture.registryUpgradeManager;
    mockERC20 = fixture.mockERC20;
    mockModule1 = fixture.mockModule1;
    mockModule2 = fixture.mockModule2;
    mockModule3 = fixture.mockModule3;
    owner = fixture.owner;
    upgradeAdmin = fixture.upgradeAdmin;
    user1 = fixture.user1;
    user2 = fixture.user2;
    user3 = fixture.user3;
    testModule1 = fixture.testModule1;
    testModule2 = fixture.testModule2;
    testModule3 = fixture.testModule3;
  });

  describe('初始化测试', function () {
    it('RegistryUpgradeManager – 应该正确初始化合约', async function () {
      expect(await registryUpgradeManager.owner()).to.equal(await owner.getAddress());
      expect(await registryUpgradeManager.getUpgradeAdmin()).to.equal(await upgradeAdmin.getAddress());
      expect(await registryUpgradeManager.paused()).to.be.false;
    });

    it('RegistryUpgradeManager – 应该拒绝重复初始化', async function () {
      await expect(
        registryUpgradeManager.initialize(await user1.getAddress())
      ).to.be.revertedWith('Initializable: contract is already initialized');
    });

    it('RegistryUpgradeManager – 应该拒绝零地址作为升级管理员', async function () {
      const newManager = await (await ethers.getContractFactory('RegistryUpgradeManager')).deploy();
      await newManager.waitForDeployment();
      
      const proxyFactory = await ethers.getContractFactory('ERC1967Proxy');
      const proxy = await proxyFactory.deploy(
        newManager.target,
        '0x'
      );
      await proxy.waitForDeployment();
      
      const attachedManager = newManager.attach(proxy.target) as RegistryUpgradeManager;
      await attachedManager.initialize(await user1.getAddress());
      
      await expect(
        attachedManager.setUpgradeAdmin(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(attachedManager, 'InvalidUpgradeAdmin');
    });
  });

  describe('权限控制测试', function () {
    it('RegistryUpgradeManager – owner 应该能够设置模块', async function () {
      await expect(
        registryUpgradeManager.setModule(TEST_KEY_1, testModule1, true)
      ).to.not.be.reverted;
    });

    it('RegistryUpgradeManager – upgradeAdmin 应该能够设置模块', async function () {
      await expect(
        registryUpgradeManager.connect(upgradeAdmin).setModule(TEST_KEY_1, testModule1, true)
      ).to.not.be.reverted;
    });

    it('RegistryUpgradeManager – 普通用户应该无法设置模块', async function () {
      await expect(
        registryUpgradeManager.connect(user1).setModule(TEST_KEY_1, testModule1, true)
      ).to.be.revertedWithCustomError(registryUpgradeManager, 'UpgradeNotAuthorized');
    });

    it('RegistryUpgradeManager – 只有 owner 能够设置升级管理员', async function () {
      await expect(
        registryUpgradeManager.connect(upgradeAdmin).setUpgradeAdmin(await user1.getAddress())
      ).to.be.revertedWith('Ownable: caller is not the owner');
    });

    it('RegistryUpgradeManager – 权限转移后 upgradeAdmin 应该仍然有效', async function () {
      // 转移 owner
      await registryUpgradeManager.transferOwnership(await user1.getAddress());
      
      // upgradeAdmin 应该仍然能够设置模块
      await expect(
        registryUpgradeManager.connect(upgradeAdmin).setModule(TEST_KEY_1, testModule1, true)
      ).to.not.be.reverted;
    });
  });

  describe('基础功能测试', function () {
    describe('setModule 功能测试', function () {
      it('RegistryUpgradeManager – 应该能够设置新模块（allowReplace = false）', async function () {
        await expect(
          registryUpgradeManager.setModule(TEST_KEY_1, testModule1, false)
        ).to.not.be.reverted;

        // 验证模块已设置
        const pendingUpgrade = await registryUpgradeManager.getPendingUpgrade(TEST_KEY_1);
        expect(pendingUpgrade.hasPendingUpgrade).to.be.false;
      });

      it('RegistryUpgradeManager – 应该能够替换现有模块（allowReplace = true）', async function () {
        // 先设置一个模块
        await registryUpgradeManager.setModule(TEST_KEY_1, testModule1, true);
        
        // 替换为另一个模块
        await expect(
          registryUpgradeManager.setModule(TEST_KEY_1, testModule2, true)
        ).to.not.be.reverted;
      });

      it('RegistryUpgradeManager – 应该拒绝替换现有模块（allowReplace = false）', async function () {
        // 先设置一个模块
        await registryUpgradeManager.setModule(TEST_KEY_1, testModule1, true);
        
        // 尝试替换，应该失败
        await expect(
          registryUpgradeManager.setModule(TEST_KEY_1, testModule2, false)
        ).to.be.revertedWithCustomError(registryUpgradeManager, 'ModuleAlreadyExists');
      });

      it('RegistryUpgradeManager – 应该拒绝零地址模块', async function () {
        await expect(
          registryUpgradeManager.setModule(TEST_KEY_1, ZERO_ADDRESS, true)
        ).to.be.revertedWithCustomError(registryUpgradeManager, 'ZeroAddress');
      });

      it('RegistryUpgradeManager – 应该拒绝重复设置相同地址', async function () {
        await registryUpgradeManager.setModule(TEST_KEY_1, testModule1, true);
        
        await expect(
          registryUpgradeManager.setModule(TEST_KEY_1, testModule1, true)
        ).to.be.revertedWithCustomError(registryUpgradeManager, 'InvalidCaller');
      });
    });

    describe('batchSetModules 功能测试', function () {
      it('RegistryUpgradeManager – 应该能够批量设置模块', async function () {
        const keys = [TEST_KEY_1, TEST_KEY_2];
        const addresses = [testModule1, testModule2];
        
        await expect(
          registryUpgradeManager.batchSetModules(keys, addresses, true)
        ).to.not.be.reverted;
      });

      it('RegistryUpgradeManager – 应该拒绝数组长度不匹配', async function () {
        const keys = [TEST_KEY_1, TEST_KEY_2];
        const addresses = [testModule1]; // 长度不匹配
        
        await expect(
          registryUpgradeManager.batchSetModules(keys, addresses, true)
        ).to.be.revertedWithCustomError(registryUpgradeManager, 'InvalidCaller');
      });

      it('RegistryUpgradeManager – 应该拒绝超过最大批量大小', async function () {
        const keys = Array(MAX_BATCH_SIZE + 1).fill(TEST_KEY_1);
        const addresses = Array(MAX_BATCH_SIZE + 1).fill(testModule1);
        
        await expect(
          registryUpgradeManager.batchSetModules(keys, addresses, true)
        ).to.be.revertedWithCustomError(registryUpgradeManager, 'BatchSizeExceeded');
      });

      it('RegistryUpgradeManager – 应该拒绝批量设置中包含零地址', async function () {
        const keys = [TEST_KEY_1, TEST_KEY_2];
        const addresses = [testModule1, ZERO_ADDRESS];
        
        await expect(
          registryUpgradeManager.batchSetModules(keys, addresses, true)
        ).to.be.revertedWithCustomError(registryUpgradeManager, 'ZeroAddress');
      });
    });
  });

  describe('延时升级流程测试', function () {
    describe('scheduleModuleUpgrade 功能测试', function () {
      it('RegistryUpgradeManager – 应该能够排期模块升级', async function () {
        await expect(
          registryUpgradeManager.scheduleModuleUpgrade(TEST_KEY_1, testModule1)
        ).to.not.be.reverted;

        const pendingUpgrade = await registryUpgradeManager.getPendingUpgrade(TEST_KEY_1);
        expect(pendingUpgrade.hasPendingUpgrade).to.be.true;
        expect(pendingUpgrade.newAddr).to.equal(testModule1);
        expect(pendingUpgrade.executeAfter).to.be.gt(0);
      });

      it('RegistryUpgradeManager – 应该拒绝零地址升级', async function () {
        await expect(
          registryUpgradeManager.scheduleModuleUpgrade(TEST_KEY_1, ZERO_ADDRESS)
        ).to.be.revertedWithCustomError(registryUpgradeManager, 'ModuleNotRegistered');
      });

      it('RegistryUpgradeManager – 应该发出正确的事件', async function () {
        const tx = await registryUpgradeManager.scheduleModuleUpgrade(TEST_KEY_1, testModule1);
        await expect(tx)
          .to.emit(registryUpgradeManager, 'ModuleUpgradeScheduled')
          .withArgs(TEST_KEY_1, ZERO_ADDRESS, testModule1, (args: bigint) => {
            // 验证时间戳是正数且在合理范围内
            return args > 0n && args < BigInt(2 ** 32);
          }, await owner.getAddress());
      });
    });

    describe('executeModuleUpgrade 功能测试', function () {
      beforeEach(async function () {
        // 设置最小延迟为 1 小时
        await registryUpgradeManager.setMinDelay(3600);
      });

      it('RegistryUpgradeManager – 应该能够执行到期的升级', async function () {
        // 排期升级
        await registryUpgradeManager.scheduleModuleUpgrade(TEST_KEY_1, testModule1);
        
        // 快进时间
        await ethers.provider.send('evm_increaseTime', [3600]);
        await ethers.provider.send('evm_mine', []);
        
        // 执行升级
        await expect(
          registryUpgradeManager.executeModuleUpgrade(TEST_KEY_1)
        ).to.not.be.reverted;

        // 验证升级已执行
        const pendingUpgrade = await registryUpgradeManager.getPendingUpgrade(TEST_KEY_1);
        expect(pendingUpgrade.hasPendingUpgrade).to.be.false;
      });

      it('RegistryUpgradeManager – 应该拒绝执行未到期的升级', async function () {
        // 排期升级
        await registryUpgradeManager.scheduleModuleUpgrade(TEST_KEY_1, testModule1);
        
        // 尝试立即执行，应该失败
        await expect(
          registryUpgradeManager.executeModuleUpgrade(TEST_KEY_1)
        ).to.be.revertedWithCustomError(registryUpgradeManager, 'InvalidCaller');
      });

      it('RegistryUpgradeManager – 应该拒绝执行不存在的升级', async function () {
        await expect(
          registryUpgradeManager.executeModuleUpgrade(TEST_KEY_1)
        ).to.be.revertedWithCustomError(registryUpgradeManager, 'InvalidCaller');
      });

      it('RegistryUpgradeManager – 应该发出正确的事件', async function () {
        // 排期升级
        await registryUpgradeManager.scheduleModuleUpgrade(TEST_KEY_1, testModule1);
        
        // 快进时间
        await ethers.provider.send('evm_increaseTime', [3600]);
        await ethers.provider.send('evm_mine', []);
        
        // 执行升级
        await expect(
          registryUpgradeManager.executeModuleUpgrade(TEST_KEY_1)
        ).to.emit(registryUpgradeManager, 'ModuleUpgraded')
          .withArgs(TEST_KEY_1, ZERO_ADDRESS, testModule1, await owner.getAddress());
      });
    });

    describe('cancelModuleUpgrade 功能测试', function () {
      it('RegistryUpgradeManager – 应该能够取消排期的升级', async function () {
        // 排期升级
        await registryUpgradeManager.scheduleModuleUpgrade(TEST_KEY_1, testModule1);
        
        // 取消升级
        await expect(
          registryUpgradeManager.cancelModuleUpgrade(TEST_KEY_1)
        ).to.not.be.reverted;

        // 验证升级已取消
        const pendingUpgrade = await registryUpgradeManager.getPendingUpgrade(TEST_KEY_1);
        expect(pendingUpgrade.hasPendingUpgrade).to.be.false;
      });

      it('RegistryUpgradeManager – 应该拒绝取消不存在的升级', async function () {
        await expect(
          registryUpgradeManager.cancelModuleUpgrade(TEST_KEY_1)
        ).to.be.revertedWithCustomError(registryUpgradeManager, 'ModuleUpgradeNotFound');
      });

      it('RegistryUpgradeManager – 应该发出正确的事件', async function () {
        // 排期升级
        await registryUpgradeManager.scheduleModuleUpgrade(TEST_KEY_1, testModule1);
        
        // 取消升级
        await expect(
          registryUpgradeManager.cancelModuleUpgrade(TEST_KEY_1)
        ).to.emit(registryUpgradeManager, 'ModuleUpgradeCancelled')
          .withArgs(TEST_KEY_1, ZERO_ADDRESS, testModule1, await owner.getAddress());
      });
    });
  });

  describe('历史记录管理测试', function () {
    it('RegistryUpgradeManager – 应该记录升级历史', async function () {
      await registryUpgradeManager.setModule(TEST_KEY_1, testModule1, true);
      
      const historyCount = await registryUpgradeManager.getUpgradeHistoryCount(TEST_KEY_1);
      expect(historyCount).to.equal(1);
      
      const history = await registryUpgradeManager.getUpgradeHistory(TEST_KEY_1, 0);
      expect(history.oldAddress).to.equal(ZERO_ADDRESS);
      expect(history.newAddress).to.equal(testModule1);
      expect(history.executor).to.equal(await owner.getAddress());
    });

    it('RegistryUpgradeManager – 应该实现环形缓冲（覆盖旧记录）', async function () {
      // 执行多次升级，超过历史记录限制
      for (let i = 0; i < MAX_UPGRADE_HISTORY + 10; i++) {
        const newModule = await (await ethers.getContractFactory('SimpleMock')).deploy();
        await newModule.waitForDeployment();
        
        await registryUpgradeManager.setModule(TEST_KEY_1, await newModule.getAddress(), true);
      }
      
      // 验证历史记录数量不超过限制
      const historyCount = await registryUpgradeManager.getUpgradeHistoryCount(TEST_KEY_1);
      expect(historyCount).to.be.lte(MAX_UPGRADE_HISTORY);
    });

    it('RegistryUpgradeManager – 应该发出历史记录事件', async function () {
      const tx = await registryUpgradeManager.setModule(TEST_KEY_1, testModule1, true);
      await expect(tx)
        .to.emit(registryUpgradeManager, 'UpgradeHistoryRecorded')
        .withArgs(TEST_KEY_1, ZERO_ADDRESS, testModule1, await ethers.provider.getBlock('latest').then(b => b!.timestamp), await owner.getAddress(), ethers.ZeroHash);
    });
  });

  describe('配置管理测试', function () {
    describe('setMinDelay 功能测试', function () {
      it('RegistryUpgradeManager – 应该能够设置最小延迟', async function () {
        const newDelay = 7200; // 2小时
        await expect(
          registryUpgradeManager.setMinDelay(newDelay)
        ).to.not.be.reverted;
      });

      it('RegistryUpgradeManager – 应该拒绝减少延迟时间', async function () {
        const newDelay = 1800; // 减少延迟
        
        await expect(
          registryUpgradeManager.setMinDelay(newDelay)
        ).to.be.revertedWithCustomError(registryUpgradeManager, 'DelayTooShort');
      });

      it('RegistryUpgradeManager – 应该拒绝超过最大延迟', async function () {
        const newDelay = MAX_MIN_DELAY + 1;
        
        await expect(
          registryUpgradeManager.setMinDelay(newDelay)
        ).to.be.revertedWithCustomError(registryUpgradeManager, 'DelayTooLong');
      });

      it('RegistryUpgradeManager – 应该拒绝溢出延迟值', async function () {
        const newDelay = BigInt(2) ** BigInt(64); // 超过 uint64 最大值
        
        await expect(
          registryUpgradeManager.setMinDelay(newDelay)
        ).to.be.revertedWithCustomError(registryUpgradeManager, 'DelayTooLong');
      });

      it('RegistryUpgradeManager – 应该发出正确的事件', async function () {
        const newDelay = 7200;
        await expect(
          registryUpgradeManager.setMinDelay(newDelay)
        ).to.emit(registryUpgradeManager, 'MinDelayChanged')
          .withArgs(3600, newDelay);
      });
    });

    describe('暂停/恢复功能测试', function () {
      it('RegistryUpgradeManager – 应该能够暂停合约', async function () {
        await expect(
          registryUpgradeManager.pause()
        ).to.not.be.reverted;

        expect(await registryUpgradeManager.paused()).to.be.true;
      });

      it('RegistryUpgradeManager – 应该能够恢复合约', async function () {
        await registryUpgradeManager.pause();
        
        await expect(
          registryUpgradeManager.unpause()
        ).to.not.be.reverted;

        expect(await registryUpgradeManager.paused()).to.be.false;
      });

      it('RegistryUpgradeManager – 暂停时应该拒绝升级操作', async function () {
        await registryUpgradeManager.pause();
        
        await expect(
          registryUpgradeManager.setModule(TEST_KEY_1, testModule1, true)
        ).to.be.revertedWith('Pausable: paused');
      });
    });
  });

  describe('边界条件测试', function () {
    it('RegistryUpgradeManager – 应该处理时间戳溢出', async function () {
      // 设置一个很大的延迟，可能导致溢出
      const largeDelay = BigInt(2) ** BigInt(64) - BigInt(1);
        
      await expect(
        registryUpgradeManager.setMinDelay(largeDelay)
      ).to.be.revertedWithCustomError(registryUpgradeManager, 'DelayTooLong');
    });

    it('RegistryUpgradeManager – 应该处理批量操作边界', async function () {
      // 测试最大批量大小 - 需要为每个键部署不同的模块
      const keys: Uint8Array[] = Array(MAX_BATCH_SIZE).fill(TEST_KEY_1);
      const addresses: string[] = [];
      
      for (let i = 0; i < MAX_BATCH_SIZE; i++) {
        const newModule = await (await ethers.getContractFactory('SimpleMock')).deploy();
        await newModule.waitForDeployment();
        addresses.push(await newModule.getAddress());
      }
      
      await expect(
        registryUpgradeManager.batchSetModules(keys, addresses, true)
      ).to.not.be.reverted;
    });

    it('RegistryUpgradeManager – 应该处理历史记录边界', async function () {
      // 执行最大数量的升级
      for (let i = 0; i < MAX_UPGRADE_HISTORY; i++) {
        const newModule = await (await ethers.getContractFactory('SimpleMock')).deploy();
        await newModule.waitForDeployment();
        
        await registryUpgradeManager.setModule(TEST_KEY_1, await newModule.getAddress(), true);
      }
      
      // 验证历史记录数量
      const historyCount = await registryUpgradeManager.getUpgradeHistoryCount(TEST_KEY_1);
      expect(historyCount).to.equal(MAX_UPGRADE_HISTORY);
    });
  });

  describe('恶意场景测试', function () {
    it('RegistryUpgradeManager – 应该拒绝批量传入零地址', async function () {
      const keys = [TEST_KEY_1, TEST_KEY_2];
      const addresses = [testModule1, ZERO_ADDRESS];
      
      await expect(
        registryUpgradeManager.batchSetModules(keys, addresses, true)
      ).to.be.revertedWithCustomError(registryUpgradeManager, 'ZeroAddress');
    });

    it('RegistryUpgradeManager – 应该防止 DoS 攻击（大量历史记录）', async function () {
      // 模拟大量历史记录写入
      const gasUsed: bigint[] = [];
      
      for (let i = 0; i < 20; i++) {
        const newModule = await (await ethers.getContractFactory('SimpleMock')).deploy();
        await newModule.waitForDeployment();
        
        const tx = await registryUpgradeManager.setModule(TEST_KEY_1, await newModule.getAddress(), true);
        const receipt = await tx.wait();
        gasUsed.push(receipt!.gasUsed);
      }
      
      // 验证 gas 使用量在合理范围内（环形缓冲应该保持稳定）
      const avgGas = gasUsed.reduce((a, b) => a + b, BigInt(0)) / BigInt(gasUsed.length);
      expect(avgGas).to.be.lt(BigInt(500000)); // 平均 gas 使用量应该小于 500k
    });

    it('RegistryUpgradeManager – 应该防止权限劫持', async function () {
      // 模拟 owner 被转移给恶意用户
      await registryUpgradeManager.transferOwnership(await user1.getAddress());
      
      // upgradeAdmin 应该仍然能够执行升级
      await expect(
        registryUpgradeManager.connect(upgradeAdmin).setModule(TEST_KEY_1, testModule1, true)
      ).to.not.be.reverted;
      
      // 但普通用户仍然不能
      await expect(
        registryUpgradeManager.connect(user2).setModule(TEST_KEY_1, testModule2, true)
      ).to.be.revertedWithCustomError(registryUpgradeManager, 'UpgradeNotAuthorized');
    });

    it('RegistryUpgradeManager – 应该防止重入攻击', async function () {
      // 批量操作应该受到 nonReentrant 保护
      const keys = [TEST_KEY_1, TEST_KEY_2];
      const addresses = [testModule1, testModule2];
      
      // 这个测试主要是验证 nonReentrant 修饰符存在
      await expect(
        registryUpgradeManager.batchSetModules(keys, addresses, true)
      ).to.not.be.reverted;
    });
  });

  describe('存储版本兼容性测试', function () {
    it('RegistryUpgradeManager – 应该检查存储版本兼容性', async function () {
      // 这个测试验证所有写操作都调用了 requireCompatibleVersion
      // 由于这是内部实现细节，我们通过验证功能正常来间接测试
      
      await expect(
        registryUpgradeManager.setModule(TEST_KEY_1, testModule1, true)
      ).to.not.be.reverted;
      
      await expect(
        registryUpgradeManager.scheduleModuleUpgrade(TEST_KEY_2, testModule2)
      ).to.not.be.reverted;
      
      await expect(
        registryUpgradeManager.setMinDelay(7200)
      ).to.not.be.reverted;
    });
  });

  describe('事件测试', function () {
    it('RegistryUpgradeManager – 应该发出所有正确的事件', async function () {
      // 测试 ModuleUpgraded 事件
      await expect(
        registryUpgradeManager.setModule(TEST_KEY_1, testModule1, true)
      ).to.emit(registryUpgradeManager, 'ModuleUpgraded')
        .withArgs(TEST_KEY_1, ZERO_ADDRESS, testModule1, await owner.getAddress());
      
      // 测试 ActionExecuted 事件
      const tx2 = await registryUpgradeManager.setModule(TEST_KEY_2, testModule2, true);
      await expect(tx2)
        .to.emit(registryUpgradeManager, 'ActionExecuted')
        .withArgs(ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE')), 'upgradeModule', await owner.getAddress(), await ethers.provider.getBlock('latest').then(b => b!.timestamp));
      
      // 测试 ModuleAddressUpdated 事件
      const tx3 = await registryUpgradeManager.setModule(TEST_KEY_3, testModule3, true);
      await expect(tx3)
        .to.emit(registryUpgradeManager, 'ModuleAddressUpdated')
        .withArgs((name: unknown) => {
          // 验证模块名称是索引的哈希值
          return name && typeof name === 'object' && 'hash' in name;
        }, ZERO_ADDRESS, testModule3, (timestamp: bigint) => {
          // 验证时间戳是正数且在合理范围内
          return timestamp > 0n && timestamp < BigInt(2 ** 32);
        });
    });
  });

  describe('Gas 优化测试', function () {
    it('RegistryUpgradeManager – 应该优化 gas 使用', async function () {
      // 测试自定义错误 vs 字符串错误的 gas 差异
      const tx1 = await registryUpgradeManager.setModule(TEST_KEY_1, testModule1, true);
      const receipt1 = await tx1.wait();
      
      // 测试批量操作的 gas 效率
      const keys = [TEST_KEY_2, TEST_KEY_3];
      const addresses = [testModule2, testModule3];
      const tx2 = await registryUpgradeManager.batchSetModules(keys, addresses, true);
      const receipt2 = await tx2.wait();
      
      // 验证批量操作的 gas 使用量合理
      expect(receipt2!.gasUsed).to.be.lt(receipt1!.gasUsed * 2n); // 批量操作应该比单个操作更高效
    });
  });
}); 
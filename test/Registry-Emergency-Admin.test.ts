/**
 * Registry Emergency Admin – 紧急管理员权限测试
 * 
 * 测试目标:
 * - 验证紧急管理员可以暂停系统
 * - 验证紧急管理员可以取消升级计划
 * - 验证紧急管理员可以取消所有升级计划
 * - 验证紧急管理员不能恢复系统（只有owner可以）
 * - 验证非紧急管理员不能执行紧急操作
 */

import { expect } from 'chai';
import { ethers } from 'hardhat';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

// 导入合约类型
import type { Registry } from '../../types';

describe('Registry 紧急管理员测试', function () {
  let registry: Registry;
  let emergencyAdmin: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;

  // 测试常量定义
  const KEY_LE = ethers.keccak256(ethers.toUtf8Bytes('LENDING_ENGINE')) as `0x${string}`;
  const KEY_CM = ethers.keccak256(ethers.toUtf8Bytes('COLLATERAL_MANAGER')) as `0x${string}`;

  async function deployRegistryFixture() {
    const [owner, emergencyAdmin, user1, user2] = await ethers.getSigners();
        
    // 部署实现和代理
    const Registry = await ethers.getContractFactory('Registry');
    const implementation = await Registry.deploy();
    await implementation.waitForDeployment();
        
    // 部署代理
    const ERC1967Proxy = await ethers.getContractFactory('ERC1967Proxy');
    const proxy = await ERC1967Proxy.deploy(
      await implementation.getAddress(),
      implementation.interface.encodeFunctionData('initialize', [BigInt(3600), await owner.getAddress(), await owner.getAddress()])
    );
    await proxy.waitForDeployment();
        
    const registry = implementation.attach(await proxy.getAddress()) as Registry;
        
    // 设置紧急管理员
    await registry.setEmergencyAdmin(await emergencyAdmin.getAddress());
        
    return { registry, owner, emergencyAdmin, user1, user2 };
  }

  beforeEach(async function () {
    const fixture = await loadFixture(deployRegistryFixture);
    registry = fixture.registry;
    emergencyAdmin = fixture.emergencyAdmin;
    user1 = fixture.user1;
    user2 = fixture.user2;
  });

  describe('紧急管理员 - 暂停系统', function () {
    it('应该允许紧急管理员暂停系统', async function () {
      // 紧急管理员暂停系统
      await expect(registry.connect(emergencyAdmin).pause())
        .to.not.be.reverted;
        
      expect(await registry.paused()).to.be.true;
      console.log('紧急管理员暂停系统测试通过');
    });

    it('应该允许所有者暂停系统', async function () {
      // owner 暂停系统
      await expect(registry.pause())
        .to.not.be.reverted;
        
      expect(await registry.paused()).to.be.true;
      console.log('所有者暂停系统测试通过');
    });

    it('不应该允许非紧急管理员暂停系统', async function () {
      // 非紧急管理员不能暂停系统
      await expect(registry.connect(user1).pause())
        .to.be.revertedWithCustomError(registry, 'EmergencyAdminNotAuthorized')
        .withArgs(await user1.getAddress(), await emergencyAdmin.getAddress());
        
      console.log('非紧急管理员暂停系统限制测试通过');
    });

    it('不应该允许紧急管理员恢复系统', async function () {
      // 先暂停系统
      await registry.pause();
      expect(await registry.paused()).to.be.true;
      
      // 紧急管理员不能恢复系统
      await expect(registry.connect(emergencyAdmin).unpause())
        .to.be.revertedWith('Ownable: caller is not the owner');
        
      console.log('紧急管理员恢复系统限制测试通过');
    });
  });

  describe('紧急管理员 - 取消升级', function () {
    beforeEach(async function () {
      // 设置一些升级计划
      await registry.scheduleModuleUpgrade(KEY_LE, await user1.getAddress());
      await registry.scheduleModuleUpgrade(KEY_CM, await user2.getAddress());
    });

    it('应该允许紧急管理员取消特定升级', async function () {
      // 紧急管理员取消特定升级
      await expect(registry.connect(emergencyAdmin).cancelModuleUpgrade(KEY_LE))
        .to.not.be.reverted;
        
      // 验证升级已被取消
      const [, , hasPendingUpgrade] = await registry.getPendingUpgrade(KEY_LE);
      expect(hasPendingUpgrade).to.be.false;
        
      console.log('紧急管理员取消特定升级测试通过');
    });

    it('应该允许所有者取消特定升级', async function () {
      // owner 取消特定升级
      await expect(registry.cancelModuleUpgrade(KEY_LE))
        .to.not.be.reverted;
        
      // 验证升级已被取消
      const [, , hasPendingUpgrade] = await registry.getPendingUpgrade(KEY_LE);
      expect(hasPendingUpgrade).to.be.false;
        
      console.log('所有者取消特定升级测试通过');
    });

    it('不应该允许非紧急管理员取消升级', async function () {
      // 非紧急管理员不能取消升级
      await expect(registry.connect(user1).cancelModuleUpgrade(KEY_LE))
        .to.be.revertedWithCustomError(registry, 'EmergencyAdminNotAuthorized')
        .withArgs(await user1.getAddress(), await emergencyAdmin.getAddress());
        
      console.log('非紧急管理员取消升级限制测试通过');
    });

    it('应该允许紧急管理员取消所有升级', async function () {
      // 紧急管理员取消所有升级
      await expect(registry.connect(emergencyAdmin).emergencyCancelAllUpgrades())
        .to.not.be.reverted;
        
      // 验证所有升级都被取消
      const [, , hasPendingUpgrade1] = await registry.getPendingUpgrade(KEY_LE);
      const [, , hasPendingUpgrade2] = await registry.getPendingUpgrade(KEY_CM);
      
      expect(hasPendingUpgrade1).to.be.false;
      expect(hasPendingUpgrade2).to.be.false;
        
      console.log('紧急管理员取消所有升级测试通过');
    });

    it('不应该允许非紧急管理员取消所有升级', async function () {
      // 非紧急管理员不能取消所有升级
      await expect(registry.connect(user1).emergencyCancelAllUpgrades())
        .to.be.revertedWithCustomError(registry, 'EmergencyAdminNotAuthorized')
        .withArgs(await user1.getAddress(), await emergencyAdmin.getAddress());
        
      console.log('非紧急管理员取消所有升级限制测试通过');
    });
  });

  describe('紧急管理员 - 恢复功能', function () {
    it('应该允许紧急管理员恢复升级权限', async function () {
      // 紧急管理员恢复升级权限
      await expect(registry.connect(emergencyAdmin).emergencyRecoverUpgrade())
        .to.not.be.reverted;
        
      // 验证升级管理员已被设置为紧急管理员
      expect(await registry.getUpgradeAdmin()).to.equal(await emergencyAdmin.getAddress());
        
      console.log('紧急管理员恢复升级权限测试通过');
    });

    it('不应该允许非紧急管理员恢复升级权限', async function () {
      // 非紧急管理员不能恢复升级权限
      await expect(registry.connect(user1).emergencyRecoverUpgrade())
        .to.be.revertedWithCustomError(registry, 'EmergencyAdminNotAuthorized')
        .withArgs(await user1.getAddress(), await emergencyAdmin.getAddress());
        
      console.log('非紧急管理员恢复升级权限限制测试通过');
    });
  });

  describe('紧急管理员 - 攻击场景', function () {
    it('应该处理攻击场景（暂停和取消）', async function () {
      // 模拟攻击场景：设置恶意升级
      await registry.scheduleModuleUpgrade(KEY_LE, await user1.getAddress());
      await registry.scheduleModuleUpgrade(KEY_CM, await user2.getAddress());
      
      // 紧急管理员发现攻击，立即暂停系统
      await registry.connect(emergencyAdmin).pause();
      expect(await registry.paused()).to.be.true;
      
      // 取消所有恶意升级
      await registry.connect(emergencyAdmin).emergencyCancelAllUpgrades();
      
      // 验证系统已暂停且升级已取消
      const [, , hasPendingUpgrade1] = await registry.getPendingUpgrade(KEY_LE);
      const [, , hasPendingUpgrade2] = await registry.getPendingUpgrade(KEY_CM);
      
      expect(await registry.paused()).to.be.true;
      expect(hasPendingUpgrade1).to.be.false;
      expect(hasPendingUpgrade2).to.be.false;
      
      console.log('攻击场景处理测试通过');
    });

    it('应该防止暂停状态下的恶意升级', async function () {
      // 紧急管理员暂停系统
      await registry.connect(emergencyAdmin).pause();
      
      // 尝试设置恶意模块（应该被阻止）
      await expect(
        registry.setModule(KEY_LE, await user1.getAddress())
      ).to.be.revertedWith('Pausable: paused');
      
      // 尝试排期恶意升级（应该被阻止）
      await expect(
        registry.scheduleModuleUpgrade(KEY_LE, await user1.getAddress())
      ).to.be.revertedWith('Pausable: paused');
      
      console.log('暂停状态下恶意升级防护测试通过');
    });
  });
}); 
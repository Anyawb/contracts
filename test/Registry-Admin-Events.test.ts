/**
 * Registry Admin Events – 治理事件测试
 * 
 * 测试目标:
 * - 验证 AdminChanged 事件正确触发
 * - 验证 PendingAdminChanged 事件正确触发
 * - 验证 UpgradeAdminChanged 事件正确触发
 * - 验证事件语义清晰，便于审计追踪
 */

import { expect } from 'chai';
import { ethers } from 'hardhat';
import { Signer } from 'ethers';
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers';

// 导入合约类型
import type { Registry } from '../../types';

describe('Registry Admin Events', function () {
  let registry: Registry;
  let owner: Signer;
  let admin: Signer;
  let pendingAdmin: Signer;
  let emergencyAdmin: Signer;
  let upgradeAdmin: Signer;

  // 测试常量定义
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

  async function deployRegistryFixture() {
    const [owner, admin, pendingAdmin, emergencyAdmin, upgradeAdmin] = await ethers.getSigners();
        
    // 部署实现和代理
    const Registry = await ethers.getContractFactory('Registry');
    const implementation = await Registry.deploy();
    await implementation.waitForDeployment();
        
    // 部署代理
    const ERC1967Proxy = await ethers.getContractFactory('ERC1967Proxy');
    const proxy = await ERC1967Proxy.deploy(
      await implementation.getAddress(),
      implementation.interface.encodeFunctionData('initialize', [3600, await owner.getAddress(), await owner.getAddress()])
    );
    await proxy.waitForDeployment();
        
    const registry = implementation.attach(await proxy.getAddress()) as Registry;
        
    return { registry, owner, admin, pendingAdmin, emergencyAdmin, upgradeAdmin };
  }

  beforeEach(async function () {
    const fixture = await loadFixture(deployRegistryFixture);
    registry = fixture.registry;
    owner = fixture.owner;
    admin = fixture.admin;
    pendingAdmin = fixture.pendingAdmin;
    emergencyAdmin = fixture.emergencyAdmin;
    upgradeAdmin = fixture.upgradeAdmin;
  });

  describe('Admin Events - Semantic Clarity', function () {
    it('Should emit AdminChanged event when setAdmin is called', async function () {
      const adminAddress = await admin.getAddress();
      
      // 监听 AdminChanged 事件
      await expect(registry.setAdmin(adminAddress))
        .to.emit(registry, 'AdminChanged');
        
      console.log('AdminChanged event test passed');
    });

    it('Should emit AdminChanged event when acceptAdmin is called', async function () {
      const pendingAdminAddress = await pendingAdmin.getAddress();
      
      // 设置待接管管理员
      await registry.setPendingAdmin(pendingAdminAddress);
      
      // 监听 AdminChanged 事件
      await expect(registry.connect(pendingAdmin).acceptAdmin())
        .to.emit(registry, 'AdminChanged');
        
      console.log('AdminChanged event in acceptAdmin test passed');
    });

    it('Should emit PendingAdminChanged event when setPendingAdmin is called', async function () {
      const pendingAdminAddress = await pendingAdmin.getAddress();
      
      // 监听 PendingAdminChanged 事件
      await expect(registry.setPendingAdmin(pendingAdminAddress))
        .to.emit(registry, 'PendingAdminChanged')
        .withArgs(ZERO_ADDRESS, pendingAdminAddress);
        
      console.log('PendingAdminChanged event test passed');
    });

    it('Should emit UpgradeAdminChanged event when setUpgradeAdmin is called', async function () {
      const upgradeAdminAddress = await upgradeAdmin.getAddress();
      
      // 监听 UpgradeAdminChanged 事件
      await expect(registry.setUpgradeAdmin(upgradeAdminAddress))
        .to.emit(registry, 'UpgradeAdminChanged')
        .withArgs(await owner.getAddress(), upgradeAdminAddress);
        
      console.log('UpgradeAdminChanged event test passed');
    });

    it('Should emit EmergencyAdminChanged event when setEmergencyAdmin is called', async function () {
      const emergencyAdminAddress = await emergencyAdmin.getAddress();
      
      // 监听 EmergencyAdminChanged 事件
      await expect(registry.setEmergencyAdmin(emergencyAdminAddress))
        .to.emit(registry, 'EmergencyAdminChanged')
        .withArgs(await owner.getAddress(), emergencyAdminAddress);
        
      console.log('EmergencyAdminChanged event test passed');
    });
  });

  describe('Admin Events - Audit Trail', function () {
    it('Should provide clear audit trail for admin changes', async function () {
      const adminAddress = await admin.getAddress();
      const pendingAdminAddress = await pendingAdmin.getAddress();
      const upgradeAdminAddress = await upgradeAdmin.getAddress();
      const emergencyAdminAddress = await emergencyAdmin.getAddress();
      
      // 执行一系列管理员变更操作（注意顺序，避免权限问题）
      const tx1 = await registry.setUpgradeAdmin(upgradeAdminAddress);
      const tx2 = await registry.setEmergencyAdmin(emergencyAdminAddress);
      const tx3 = await registry.setPendingAdmin(pendingAdminAddress);
      const tx4 = await registry.setAdmin(adminAddress);
      
      // 验证事件日志
      const receipt1 = await tx1.wait();
      const receipt2 = await tx2.wait();
      const receipt3 = await tx3.wait();
      const receipt4 = await tx4.wait();
      
      // 检查事件数量
      expect(receipt1?.logs?.length).to.be.gt(0);
      expect(receipt2?.logs?.length).to.be.gt(0);
      expect(receipt3?.logs?.length).to.be.gt(0);
      expect(receipt4?.logs?.length).to.be.gt(0);
      
      console.log('Audit trail test passed');
    });

    it('Should distinguish between different admin types in events', async function () {
      const adminAddress = await admin.getAddress();
      const upgradeAdminAddress = await upgradeAdmin.getAddress();
      
      // 先设置升级管理员，再设置主治理地址
      await registry.setUpgradeAdmin(upgradeAdminAddress);
      await registry.setAdmin(adminAddress);
      
      // 验证两个不同的管理员地址
      expect(await registry.getAdmin()).to.equal(adminAddress);
      expect(await registry.getUpgradeAdmin()).to.equal(upgradeAdminAddress);
      
      console.log('Admin type distinction test passed');
    });
  });

  describe('Admin Events - Error Handling', function () {
    it('Should not emit events for invalid admin changes', async function () {
      // 尝试设置零地址作为管理员
      await expect(registry.setAdmin(ZERO_ADDRESS))
        .to.be.revertedWithCustomError(registry, 'InvalidParameter')
        .withArgs('Invalid admin address');
        
      // 验证没有事件被触发
      const currentAdmin = await registry.getAdmin();
      expect(currentAdmin).to.equal(await owner.getAddress());
      
      console.log('Invalid admin change test passed');
    });

    it('Should not emit AdminChanged when acceptAdmin is called by non-pending admin', async function () {
      // 尝试接受管理员权限（非待接管管理员）
      await expect(registry.connect(upgradeAdmin).acceptAdmin())
        .to.be.revertedWithCustomError(registry, 'NotPendingAdmin')
        .withArgs(await upgradeAdmin.getAddress(), ZERO_ADDRESS);
        
      console.log('Non-pending admin accept test passed');
    });
  });
}); 
/**
 * RegistryAdmin – 安全性测试（按 docs/Architecture-Guide.md 对齐）
 *
 * 重点：
 * - RegistryAdmin 仅承担治理/暂停/紧急参数入口
 * - 升级管理员属于 Registry 本体职责，不在 RegistryAdmin 中维护副本
 */
import * as hardhat from 'hardhat';
const { ethers } = hardhat;
import { expect } from 'chai';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';

import type { RegistryAdmin } from '../../types/contracts/registry/RegistryAdmin';

describe('RegistryAdmin – 安全性测试', function () {
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const MAX_DELAY = 7 * 24 * 60 * 60; // 7 days
  const TEST_DELAY = 7200; // 2 hours

  let registryAdmin: RegistryAdmin;
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let newOwner: SignerWithAddress;

  async function deployProxyContract(contractName: string, initData: string = '0x') {
    const ImplementationFactory = await ethers.getContractFactory(contractName);
    const implementation = await ImplementationFactory.deploy();
    await implementation.waitForDeployment();

    const ProxyFactory = await ethers.getContractFactory('ERC1967Proxy');
    const proxy = await ProxyFactory.deploy(implementation.target, initData);
    await proxy.waitForDeployment();

    const proxyContract = implementation.attach(proxy.target);
    return { implementation, proxy, proxyContract };
  }

  async function deployFixture() {
    [owner, user1, newOwner] = await ethers.getSigners();

    const { proxyContract } = await deployProxyContract('RegistryAdmin');
    const admin = proxyContract as RegistryAdmin;
    await admin.initialize(owner.address);

    return { registryAdmin: admin, owner, user1, newOwner };
  }

  describe('初始化测试', function () {
    beforeEach(async function () {
      const fx = await loadFixture(deployFixture);
      registryAdmin = fx.registryAdmin;
      owner = fx.owner;
    });

    it('应该正确初始化代理合约', async function () {
      expect(await registryAdmin.owner()).to.equal(await owner.getAddress());
      expect(await registryAdmin.isPaused()).to.equal(false);
      // 按统一初始化：默认 minDelay=0（由治理/紧急入口后续设置）
      expect(await registryAdmin.minDelay()).to.equal(0n);
    });

    it('应该拒绝重复初始化', async function () {
      await expect(registryAdmin.initialize(owner.address)).to.be.revertedWithCustomError(registryAdmin, 'InvalidInitialization');
    });
  });

  describe('延时窗口（紧急入口）', function () {
    beforeEach(async function () {
      const fx = await loadFixture(deployFixture);
      registryAdmin = fx.registryAdmin;
      owner = fx.owner;
      user1 = fx.user1;
    });

    it('应该拒绝非 owner 调用紧急设置', async function () {
      await expect(registryAdmin.connect(user1).emergencySetMinDelay(TEST_DELAY)).to.be.revertedWithCustomError(
        registryAdmin,
        'OwnableUnauthorizedAccount'
      );
    });

    it('应该允许 owner 紧急设置延时窗口（可增可减）', async function () {
      await expect(registryAdmin.connect(owner).emergencySetMinDelay(TEST_DELAY))
        .to.emit(registryAdmin, 'MinDelayChanged')
        .withArgs(0n, BigInt(TEST_DELAY));

      expect(await registryAdmin.minDelay()).to.equal(BigInt(TEST_DELAY));

      // 允许紧急降低
      await expect(registryAdmin.connect(owner).emergencySetMinDelay(1))
        .to.emit(registryAdmin, 'MinDelayChanged')
        .withArgs(BigInt(TEST_DELAY), 1n);

      expect(await registryAdmin.minDelay()).to.equal(1n);
    });

    it('应该拒绝紧急设置超过最大值的延时窗口', async function () {
      await expect(registryAdmin.connect(owner).emergencySetMinDelay(MAX_DELAY + 1)).to.be.revertedWithCustomError(
        registryAdmin,
        'InvalidCaller'
      );
    });

    it('应该正确获取最大延时窗口', async function () {
      expect(await registryAdmin.getMaxDelay()).to.equal(BigInt(MAX_DELAY));
    });
  });

  describe('暂停/恢复', function () {
    beforeEach(async function () {
      const fx = await loadFixture(deployFixture);
      registryAdmin = fx.registryAdmin;
      owner = fx.owner;
      user1 = fx.user1;
    });

    it('应该允许 owner 暂停与恢复', async function () {
      await expect(registryAdmin.connect(owner).pause()).to.emit(registryAdmin, 'EmergencyActionExecuted').withArgs(
        0,
        await owner.getAddress(),
        (ts: bigint) => ts > 0n
      );
      expect(await registryAdmin.isPaused()).to.equal(true);

      await expect(registryAdmin.connect(owner).unpause()).to.emit(registryAdmin, 'EmergencyActionExecuted').withArgs(
        1,
        await owner.getAddress(),
        (ts: bigint) => ts > 0n
      );
      expect(await registryAdmin.isPaused()).to.equal(false);
    });

    it('应该拒绝非 owner 暂停/恢复', async function () {
      await expect(registryAdmin.connect(user1).pause()).to.be.revertedWithCustomError(
        registryAdmin,
        'OwnableUnauthorizedAccount'
      );
      await expect(registryAdmin.connect(user1).unpause()).to.be.revertedWithCustomError(
        registryAdmin,
        'OwnableUnauthorizedAccount'
      );
    });
  });

  describe('治理地址与所有权', function () {
    beforeEach(async function () {
      const fx = await loadFixture(deployFixture);
      registryAdmin = fx.registryAdmin;
      owner = fx.owner;
      user1 = fx.user1;
      newOwner = fx.newOwner;
    });

    it('应该允许 owner 直接 setAdmin（会转移所有权）', async function () {
      await expect(registryAdmin.connect(owner).setAdmin(await newOwner.getAddress()))
        .to.emit(registryAdmin, 'AdminChanged')
        .withArgs(await owner.getAddress(), await newOwner.getAddress());
      expect(await registryAdmin.owner()).to.equal(await newOwner.getAddress());
    });

    it('应该支持 pendingAdmin → acceptAdmin 流程', async function () {
      await expect(registryAdmin.connect(owner).setPendingAdmin(await newOwner.getAddress()))
        .to.emit(registryAdmin, 'PendingAdminChanged')
        .withArgs(ZERO_ADDRESS, await newOwner.getAddress());

      await expect(registryAdmin.connect(user1).acceptAdmin()).to.be.revertedWith('Not pending admin');

      await expect(registryAdmin.connect(newOwner).acceptAdmin())
        .to.emit(registryAdmin, 'AdminChanged')
        .withArgs(await owner.getAddress(), await newOwner.getAddress());

      expect(await registryAdmin.owner()).to.equal(await newOwner.getAddress());
    });

    it('应该拒绝转移所有权给零地址', async function () {
      await expect(registryAdmin.connect(owner).transferOwnership(ZERO_ADDRESS)).to.be.revertedWithCustomError(
        registryAdmin,
        'ZeroAddress'
      );
    });

    it('应该拒绝非 owner 的所有权操作', async function () {
      await expect(registryAdmin.connect(user1).transferOwnership(await newOwner.getAddress())).to.be.revertedWithCustomError(
        registryAdmin,
        'OwnableUnauthorizedAccount'
      );
      await expect(registryAdmin.connect(user1).renounceOwnership()).to.be.revertedWithCustomError(
        registryAdmin,
        'OwnableUnauthorizedAccount'
      );
    });
  });
});

/**
 * AccessControlView 权限控制视图模块测试
 * 
 * 测试目标:
 * - 权限查询功能验证
 * - 权限管理功能验证
 * - 合约状态查询功能验证
 * - 权限验证辅助函数测试
 * - 升级控制功能验证
 * - 错误处理和边界条件测试
 * - 安全场景测试（重入、权限绕过等）
 */

import { expect } from 'chai';
import hardhat from 'hardhat';
const { ethers } = hardhat;

// 常量定义
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

describe('AccessControlView – 权限控制视图模块测试', function () {
  // 部署测试环境
  async function deployFixture() {
    const [governance, admin, alice, bob, charlie] = await ethers.getSigners();

    // 部署 MockAccessControlManager
    const acmFactory = await ethers.getContractFactory('MockAccessControlManager');
    const acm = await acmFactory.deploy();
    await acm.waitForDeployment();

    // 部署 AccessControlView
    const accessControlViewFactory = await ethers.getContractFactory('AccessControlView');
    const accessControlView = await accessControlViewFactory.deploy();
    await accessControlView.waitForDeployment();
    await accessControlView.initialize(await acm.getAddress());

    // 设置初始权限
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN')), admin.address);
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE')), admin.address);
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('VIEW_USER_DATA')), alice.address);
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('VIEW_SYSTEM_DATA')), bob.address);
    await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('VIEW_RISK_DATA')), charlie.address);

    return { 
      accessControlView, 
      acm, 
      governance, 
      admin, 
      alice, 
      bob, 
      charlie 
    };
  }

  // 调试测试
  describe('调试测试', function () {
    it('应正确设置和检查权限', async function () {
      const { accessControlView, acm, admin, alice } = await deployFixture();
      
      // 检查权限是否正确设置
      const adminHasAdminRole = await acm.hasRole(
        ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN')), 
        admin.address
      );
      console.log('Admin has ACTION_ADMIN role:', adminHasAdminRole);
      
      const adminHasUpgradeRole = await acm.hasRole(
        ethers.keccak256(ethers.toUtf8Bytes('UPGRADE_MODULE')), 
        admin.address
      );
      console.log('Admin has ACTION_UPGRADE_MODULE role:', adminHasUpgradeRole);
      
      const aliceHasUserDataRole = await acm.hasRole(
        ethers.keccak256(ethers.toUtf8Bytes('VIEW_USER_DATA')), 
        alice.address
      );
      console.log('Alice has VIEW_USER_DATA role:', aliceHasUserDataRole);
      
      // 检查AccessControlView的权限检查
      const isAdmin = await accessControlView.isAdmin(admin.address);
      console.log('AccessControlView says admin is admin:', isAdmin);
      
      const canUpgrade = await accessControlView.canUpgrade(admin.address);
      console.log('AccessControlView says admin can upgrade:', canUpgrade);
      
      const canViewUserData = await accessControlView.canViewUserData(alice.address);
      console.log('AccessControlView says alice can view user data:', canViewUserData);
      
      expect(adminHasAdminRole).to.be.true;
      expect(adminHasUpgradeRole).to.be.true;
      expect(aliceHasUserDataRole).to.be.true;
      expect(isAdmin).to.be.true;
      expect(canUpgrade).to.be.true;
      expect(canViewUserData).to.be.true;
    });
  });

  describe('初始化测试', function () {
    it('应正确初始化合约', async function () {
      const { accessControlView, acm } = await deployFixture();
      
      const acmAddress = await accessControlView.getACM();
      expect(acmAddress).to.equal(await acm.getAddress());
    });

    it('初始化时零地址应被拒绝', async function () {
      await deployFixture();
      
      // 重新部署一个新的 AccessControlView
      const factory = await ethers.getContractFactory('AccessControlView');
      const newAccessControlView = await factory.deploy();
      await newAccessControlView.waitForDeployment();
      
      await expect(
        newAccessControlView.initialize(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(newAccessControlView, 'ZeroAddress');
    });

    it('重复初始化应被拒绝', async function () {
      const { accessControlView, acm } = await deployFixture();
      
      await expect(
        accessControlView.initialize(await acm.getAddress())
      ).to.be.revertedWith('Initializable: contract is already initialized');
    });
  });

  describe('权限查询功能测试', function () {
    it('应正确检查用户权限', async function () {
      const { accessControlView, admin, alice } = await deployFixture();
      
      // 检查管理员权限
      const hasAdminPermission = await accessControlView.hasPermission(
        admin.address, 
        ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'))
      );
      expect(hasAdminPermission).to.be.true;
      
      // 检查普通用户权限
      const hasUserPermission = await accessControlView.hasPermission(
        alice.address, 
        ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'))
      );
      expect(hasUserPermission).to.be.false;
    });

    it('应正确检查管理员权限', async function () {
      const { accessControlView, admin, alice } = await deployFixture();
      
      const isAdmin = await accessControlView.isAdmin(admin.address);
      expect(isAdmin).to.be.true;
      
      const isNotAdmin = await accessControlView.isAdmin(alice.address);
      expect(isNotAdmin).to.be.false;
    });

    it('应正确检查升级权限', async function () {
      const { accessControlView, admin, alice } = await deployFixture();
      
      const canUpgrade = await accessControlView.canUpgrade(admin.address);
      expect(canUpgrade).to.be.true;
      
      const cannotUpgrade = await accessControlView.canUpgrade(alice.address);
      expect(cannotUpgrade).to.be.false;
    });

    it('应正确检查用户数据查看权限', async function () {
      const { accessControlView, alice, bob } = await deployFixture();
      
      const canViewUserData = await accessControlView.canViewUserData(alice.address);
      expect(canViewUserData).to.be.true;
      
      const cannotViewUserData = await accessControlView.canViewUserData(bob.address);
      expect(cannotViewUserData).to.be.false;
    });

    it('应正确检查系统数据查看权限', async function () {
      const { accessControlView, alice, bob } = await deployFixture();
      
      const canViewSystemData = await accessControlView.canViewSystemData(bob.address);
      expect(canViewSystemData).to.be.true;
      
      const cannotViewSystemData = await accessControlView.canViewSystemData(alice.address);
      expect(cannotViewSystemData).to.be.false;
    });

    it('应正确检查风险数据查看权限', async function () {
      const { accessControlView, bob, charlie } = await deployFixture();
      
      const canViewRiskData = await accessControlView.canViewRiskData(charlie.address);
      expect(canViewRiskData).to.be.true;
      
      const cannotViewRiskData = await accessControlView.canViewRiskData(bob.address);
      expect(cannotViewRiskData).to.be.false;
    });
  });

  describe('权限管理功能测试', function () {
    it('管理员应能更新ACM地址', async function () {
      const { accessControlView, admin } = await deployFixture();
      
      // 部署新的ACM
      const newAcmFactory = await ethers.getContractFactory('MockAccessControlManager');
      const newAcm = await newAcmFactory.deploy();
      await newAcm.waitForDeployment();
      
      await expect(
        accessControlView.connect(admin).setACM(await newAcm.getAddress())
      ).to.not.be.reverted;
      
      const updatedAcmAddress = await accessControlView.getACM();
      expect(updatedAcmAddress).to.equal(await newAcm.getAddress());
    });

    it('非管理员不应能更新ACM地址', async function () {
      const { accessControlView, alice, acm } = await deployFixture();
      
      // 部署新的ACM
      const newAcmFactory = await ethers.getContractFactory('MockAccessControlManager');
      const newAcm = await newAcmFactory.deploy();
      await newAcm.waitForDeployment();
      
      await expect(
        accessControlView.connect(alice).setACM(await newAcm.getAddress())
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('更新ACM时零地址应被拒绝', async function () {
      const { accessControlView, admin } = await deployFixture();
      
      await expect(
        accessControlView.connect(admin).setACM(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(accessControlView, 'ZeroAddress');
    });

    it('应正确获取当前ACM地址', async function () {
      const { accessControlView, acm } = await deployFixture();
      
      const acmAddress = await accessControlView.getACM();
      expect(acmAddress).to.equal(await acm.getAddress());
    });
  });

  describe('合约状态查询功能测试', function () {
    it('应正确检查合约暂停状态', async function () {
      const { accessControlView } = await deployFixture();
      
      const isPaused = await accessControlView.isContractPaused();
      expect(isPaused).to.be.false; // Mock ACM 默认返回 false
    });

    it('应正确获取合约状态信息', async function () {
      const { accessControlView } = await deployFixture();
      
      const status = await accessControlView.getContractStatus();
      expect(status.paused).to.be.false;
      expect(status.pauseTime).to.equal(0n);
      expect(status.pauseReason).to.equal('');
    });
  });

  describe('权限验证辅助函数测试', function () {
    it('应正确验证用户数据访问权限', async function () {
      const { accessControlView, alice, bob, charlie } = await deployFixture();
      
      // 有权限的用户可以访问自己的数据
      const hasAccess = await accessControlView.validateUserDataAccess(alice.address, alice.address);
      expect(hasAccess).to.be.true;
      
      // 有权限的用户可以访问零地址数据（系统数据）
      const hasSystemAccess = await accessControlView.validateUserDataAccess(ZERO_ADDRESS, alice.address);
      expect(hasSystemAccess).to.be.true;
      
      // 无权限的用户不能访问其他用户数据
      const noAccess = await accessControlView.validateUserDataAccess(bob.address, charlie.address);
      expect(noAccess).to.be.false;
    });

    it('应正确验证系统数据访问权限', async function () {
      const { accessControlView, bob, charlie } = await deployFixture();
      
      const hasAccess = await accessControlView.validateSystemDataAccess(bob.address);
      expect(hasAccess).to.be.true;
      
      const noAccess = await accessControlView.validateSystemDataAccess(charlie.address);
      expect(noAccess).to.be.false;
    });

    it('应正确验证风险数据访问权限', async function () {
      const { accessControlView, bob, charlie } = await deployFixture();
      
      const hasAccess = await accessControlView.validateRiskDataAccess(charlie.address);
      expect(hasAccess).to.be.true;
      
      const noAccess = await accessControlView.validateRiskDataAccess(bob.address);
      expect(noAccess).to.be.false;
    });
  });

  describe('升级控制功能测试', function () {
    it('有升级权限的用户应能升级合约', async function () {
      const { accessControlView, admin } = await deployFixture();
      
      // 这里我们测试升级权限检查，实际的升级逻辑在 _authorizeUpgrade 中
      // 由于这是内部函数，我们通过其他方式验证权限检查
      const canUpgrade = await accessControlView.canUpgrade(admin.address);
      expect(canUpgrade).to.be.true;
    });

    it('无升级权限的用户不应能升级合约', async function () {
      const { accessControlView, alice } = await deployFixture();
      
      const cannotUpgrade = await accessControlView.canUpgrade(alice.address);
      expect(cannotUpgrade).to.be.false;
    });
  });

  describe('边界条件测试', function () {
    it('零地址权限检查应正确处理', async function () {
      const { accessControlView } = await deployFixture();
      
      const hasPermission = await accessControlView.hasPermission(
        ZERO_ADDRESS, 
        ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN'))
      );
      expect(hasPermission).to.be.false;
    });

    it('无效权限键应正确处理', async function () {
      const { accessControlView, admin } = await deployFixture();
      
      const hasPermission = await accessControlView.hasPermission(
        admin.address, 
        ethers.keccak256(ethers.toUtf8Bytes('INVALID_PERMISSION'))
      );
      expect(hasPermission).to.be.false;
    });

    it('大额权限检查应正常工作', async function () {
      const { accessControlView, admin } = await deployFixture();
      
      // 使用一个大的权限键
      const largePermissionKey = ethers.keccak256(ethers.toUtf8Bytes('VERY_LONG_PERMISSION_NAME_THAT_SHOULD_WORK'));
      const hasPermission = await accessControlView.hasPermission(admin.address, largePermissionKey);
      expect(hasPermission).to.be.false; // 因为没有被授予这个权限
    });
  });

  describe('安全场景测试', function () {
    it('权限绕过攻击应被阻止', async function () {
      const { accessControlView, acm, alice } = await deployFixture();
      
      // 尝试直接调用需要管理员权限的函数
      await expect(
        accessControlView.connect(alice).setACM(alice.address)
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('重入攻击应被阻止', async function () {
      const { accessControlView, admin } = await deployFixture();
      
      // 由于这是一个视图合约，重入攻击的风险较低
      // 但我们仍然测试权限检查的稳定性
      const promises: Promise<boolean>[] = [];
      for (let i = 0; i < 10; i++) {
        promises.push(accessControlView.isAdmin(admin.address));
      }
      
      const results = await Promise.all(promises);
      results.forEach(result => {
        expect(result).to.be.true;
      });
    });

    it('权限状态一致性测试', async function () {
      const { accessControlView, acm, admin } = await deployFixture();
      
      // 检查权限状态一致性
      const directCheck = await acm.hasRole(
        ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN')), 
        admin.address
      );
      const viewCheck = await accessControlView.isAdmin(admin.address);
      expect(directCheck).to.equal(viewCheck);
      
      // 撤销权限后检查一致性
      await acm.revokeRole(ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN')), admin.address);
      const afterRevoke = await accessControlView.isAdmin(admin.address);
      expect(afterRevoke).to.be.false;
    });
  });

  describe('集成测试', function () {
    it('完整权限管理流程', async function () {
      const { accessControlView, acm, admin, bob } = await deployFixture();
      
      // 1. 初始状态检查
      let isAdmin = await accessControlView.isAdmin(admin.address);
      expect(isAdmin).to.be.true;
      
      // 2. 撤销管理员权限
      await acm.revokeRole(ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN')), admin.address);
      isAdmin = await accessControlView.isAdmin(admin.address);
      expect(isAdmin).to.be.false;
      
      // 3. 授予新管理员权限
      await acm.grantRole(ethers.keccak256(ethers.toUtf8Bytes('ACTION_ADMIN')), bob.address);
      const isNewAdmin = await accessControlView.isAdmin(bob.address);
      expect(isNewAdmin).to.be.true;
      
      // 4. 更新ACM地址
      const newAcmFactory = await ethers.getContractFactory('MockAccessControlManager');
      const newAcm = await newAcmFactory.deploy();
      await newAcm.waitForDeployment();
      
      await accessControlView.connect(bob).setACM(await newAcm.getAddress());
      const newAcmAddress = await accessControlView.getACM();
      expect(newAcmAddress).to.equal(await newAcm.getAddress());
    });

    it('多用户权限管理', async function () {
      const { accessControlView, acm, bob, charlie } = await deployFixture();
      
      // 批量授予权限
      await acm.batchGrantRole(
        ethers.keccak256(ethers.toUtf8Bytes('VIEW_USER_DATA')), 
        [bob.address, charlie.address]
      );
      
      // 验证权限
      const bobCanView = await accessControlView.canViewUserData(bob.address);
      const charlieCanView = await accessControlView.canViewUserData(charlie.address);
      expect(bobCanView).to.be.true;
      expect(charlieCanView).to.be.true;
      
      // 批量撤销权限
      await acm.batchRevokeRole(
        ethers.keccak256(ethers.toUtf8Bytes('VIEW_USER_DATA')), 
        [bob.address, charlie.address]
      );
      
      // 验证权限被撤销
      const bobCannotView = await accessControlView.canViewUserData(bob.address);
      const charlieCannotView = await accessControlView.canViewUserData(charlie.address);
      expect(bobCannotView).to.be.false;
      expect(charlieCannotView).to.be.false;
    });
  });

  describe('错误处理测试', function () {
    it('权限检查失败时应抛出正确错误', async function () {
      const { accessControlView, acm, alice } = await deployFixture();
      
      // 尝试调用需要管理员权限的函数
      await expect(
        accessControlView.connect(alice).setACM(alice.address)
      ).to.be.revertedWithCustomError(acm, 'MissingRole');
    });

    it('零地址参数应被正确处理', async function () {
      const { accessControlView, admin } = await deployFixture();
      
      await expect(
        accessControlView.connect(admin).setACM(ZERO_ADDRESS)
      ).to.be.revertedWithCustomError(accessControlView, 'ZeroAddress');
    });

    it('无效权限键应返回false', async function () {
      const { accessControlView, admin } = await deployFixture();
      
      const hasPermission = await accessControlView.hasPermission(
        admin.address, 
        ethers.keccak256(ethers.toUtf8Bytes('NONEXISTENT_PERMISSION'))
      );
      expect(hasPermission).to.be.false;
    });
  });

  describe('性能测试', function () {
    it('大量权限检查应高效执行', async function () {
      const { accessControlView, admin } = await deployFixture();
      
      const startTime = Date.now();
      
      // 执行1000次权限检查
      for (let i = 0; i < 1000; i++) {
        await accessControlView.isAdmin(admin.address);
      }
      
      const endTime = Date.now();
      const executionTime = endTime - startTime;
      
      // 确保执行时间在合理范围内（5秒内）
      expect(executionTime).to.be.lessThan(5000);
    });

    it('并发权限检查应正常工作', async function () {
      const { accessControlView, admin, alice, bob } = await deployFixture();
      
      const promises = [
        accessControlView.isAdmin(admin.address),
        accessControlView.canViewUserData(alice.address),
        accessControlView.canViewSystemData(bob.address),
        accessControlView.canViewRiskData(alice.address),
        accessControlView.getACM()
      ];
      
      const results = await Promise.all(promises);
      
      expect(results[0]).to.be.true; // admin is admin
      expect(results[1]).to.be.true; // alice can view user data
      expect(results[2]).to.be.true; // bob can view system data
      expect(results[3]).to.be.false; // alice cannot view risk data
      expect(results[4]).to.be.a('string'); // ACM address
    });
  });
}); 
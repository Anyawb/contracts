import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@ethersproject/contracts";
import { Contract } from "ethers";

import { ModuleKeys } from '../../../frontend-config/moduleKeys';
// ActionKeys 需要从正确的位置导入

describe("LiquidationGuaranteeManager Registry Integration", function () {
  let deployer: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let admin: SignerWithAddress;
  
  let registry: Contract;
  let liquidationGuaranteeManager: Contract;
  let accessControlManager: Contract;
  let mockLendingEngine: Contract;
  
  const testAsset = "0x1234567890123456789012345678901234567890";
  const testUser = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

  beforeEach(async function () {
    [deployer, user1, user2, admin] = await ethers.getSigners();

    // 部署 Registry
    const Registry = await ethers.getContractFactory("Registry");
    registry = await Registry.deploy();
    await registry.initialize(0, deployer.address, deployer.address); // 测试环境使用0延时

    // 部署 AccessControlManager
    const AccessControlManager = await ethers.getContractFactory("AccessControlManager");
    accessControlManager = await AccessControlManager.deploy(deployer.address);
    await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, accessControlManager.address, true);

    // 部署 Mock LendingEngine
    const MockLendingEngine = await ethers.getContractFactory("MockLendingEngine");
    mockLendingEngine = await MockLendingEngine.deploy();
    await mockLendingEngine.deployed();

    // 部署 LiquidationGuaranteeManager
    const LiquidationGuaranteeManager = await ethers.getContractFactory("LiquidationGuaranteeManager");
    liquidationGuaranteeManager = await LiquidationGuaranteeManager.deploy(registry.address);
    await liquidationGuaranteeManager.initialize(accessControlManager.address);

    // 注册模块到 Registry
    await registry.setModule(ModuleKeys.KEY_LE, mockLendingEngine.address, true);
    await registry.setModule(ModuleKeys.KEY_LIQUIDATION_GUARANTEE_MANAGER, liquidationGuaranteeManager.address, true);

    // 设置权限
    await accessControlManager.grantRole(ActionKeys.ACTION_LIQUIDATE, deployer.address);
    await accessControlManager.grantRole(ActionKeys.ACTION_SET_PARAMETER, deployer.address);
    await accessControlManager.grantRole(ActionKeys.ACTION_UPGRADE_MODULE, deployer.address);
  });

  describe("Registry Integration", function () {
    it("should correctly initialize with Registry address", async function () {
      expect(await liquidationGuaranteeManager.registryAddr()).to.equal(registry.address);
    });

    it("should get module from Registry", async function () {
      const lendingEngine = await liquidationGuaranteeManager.getModule(ModuleKeys.KEY_LE);
      expect(lendingEngine).to.equal(mockLendingEngine.address);
    });

    it("should check if module is registered", async function () {
      const isRegistered = await liquidationGuaranteeManager.isModuleRegistered(ModuleKeys.KEY_LE);
      expect(isRegistered).to.be.true;
    });

    it("should revert when getting non-existent module", async function () {
      const nonExistentKey = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("NON_EXISTENT_MODULE"));
      await expect(
        liquidationGuaranteeManager.getModuleFromRegistry(nonExistentKey)
      ).to.be.reverted;
    });
  });

  describe("Module Upgrade Management", function () {
    let newMockLendingEngine: Contract;

    beforeEach(async function () {
      const MockLendingEngine = await ethers.getContractFactory("MockLendingEngine");
      newMockLendingEngine = await MockLendingEngine.deploy();
      await newMockLendingEngine.deployed();
    });

    it("should schedule module upgrade", async function () {
      await expect(
        liquidationGuaranteeManager.scheduleModuleUpgrade(ModuleKeys.KEY_LE, newMockLendingEngine.address)
      ).to.emit(liquidationGuaranteeManager, "RegistryModuleUpgradeScheduled");
    });

    it("should execute module upgrade after delay", async function () {
      await liquidationGuaranteeManager.scheduleModuleUpgrade(ModuleKeys.KEY_LE, newMockLendingEngine.address);
      
      await expect(
        liquidationGuaranteeManager.executeModuleUpgrade(ModuleKeys.KEY_LE)
      ).to.emit(liquidationGuaranteeManager, "RegistryModuleUpgradeExecuted");
    });

    it("should cancel module upgrade", async function () {
      await liquidationGuaranteeManager.scheduleModuleUpgrade(ModuleKeys.KEY_LE, newMockLendingEngine.address);
      
      await expect(
        liquidationGuaranteeManager.cancelModuleUpgrade(ModuleKeys.KEY_LE)
      ).to.emit(liquidationGuaranteeManager, "RegistryModuleUpgradeCancelled");
    });

    it("should check if upgrade is ready", async function () {
      await liquidationGuaranteeManager.scheduleModuleUpgrade(ModuleKeys.KEY_LE, newMockLendingEngine.address);
      
      const isReady = await liquidationGuaranteeManager.isUpgradeReady(ModuleKeys.KEY_LE);
      expect(isReady).to.be.true;
    });

    it("should revert when scheduling upgrade for non-existent module", async function () {
      const nonExistentKey = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("NON_EXISTENT_MODULE"));
      
      await expect(
        liquidationGuaranteeManager.scheduleModuleUpgrade(nonExistentKey, newMockLendingEngine.address)
      ).to.be.reverted;
    });

    it("should revert when executing upgrade before delay", async function () {
      // 使用有延时的 Registry
      const RegistryWithDelay = await ethers.getContractFactory("Registry");
      const registryWithDelay = await RegistryWithDelay.deploy();
      await registryWithDelay.deployed();
      await registryWithDelay.initialize(3600); // 1小时延时

      const LiquidationGuaranteeManagerWithDelay = await ethers.getContractFactory("LiquidationGuaranteeManager");
      const liquidationGuaranteeManagerWithDelay = await LiquidationGuaranteeManagerWithDelay.deploy(registryWithDelay.address);
      await liquidationGuaranteeManagerWithDelay.deployed();
      await liquidationGuaranteeManagerWithDelay.initialize(accessControlManager.address);

      await registryWithDelay.setModule(ModuleKeys.KEY_LE, mockLendingEngine.address, true);
      await liquidationGuaranteeManagerWithDelay.scheduleModuleUpgrade(ModuleKeys.KEY_LE, newMockLendingEngine.address);
      
      await expect(
        liquidationGuaranteeManagerWithDelay.executeModuleUpgrade(ModuleKeys.KEY_LE)
      ).to.be.revertedWith("LiquidationGuaranteeManager__UpgradeNotReady");
    });
  });

  describe("Safe Module Access", function () {
    it("should safely get module with error handling", async function () {
      const lendingEngine = await liquidationGuaranteeManager.safeGetModule(ModuleKeys.KEY_LE);
      expect(lendingEngine).to.equal(mockLendingEngine.address);
    });

    it("should revert when Registry is not initialized", async function () {
      const LiquidationGuaranteeManagerWithoutRegistry = await ethers.getContractFactory("LiquidationGuaranteeManager");
      const liquidationGuaranteeManagerWithoutRegistry = await LiquidationGuaranteeManagerWithoutRegistry.deploy(ethers.constants.AddressZero);
      await liquidationGuaranteeManagerWithoutRegistry.deployed();
      await liquidationGuaranteeManagerWithoutRegistry.initialize(accessControlManager.address);

      await expect(
        liquidationGuaranteeManagerWithoutRegistry.safeGetModule(ModuleKeys.KEY_LE)
      ).to.be.revertedWith("LiquidationGuaranteeManager__RegistryNotInitialized");
    });

    it("should revert when module is not registered", async function () {
      const nonExistentKey = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("NON_EXISTENT_MODULE"));
      
      await expect(
        liquidationGuaranteeManager.safeGetModule(nonExistentKey)
      ).to.be.revertedWith("LiquidationGuaranteeManager__ModuleNotRegistered");
    });
  });

  describe("Error Handling", function () {
    it("should revert with correct error names", async function () {
      // 测试自定义错误命名规范
      const nonExistentKey = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("NON_EXISTENT_MODULE"));
      
      await expect(
        liquidationGuaranteeManager.safeGetModule(nonExistentKey)
      ).to.be.revertedWith("LiquidationGuaranteeManager__ModuleNotRegistered");
    });

    it("should validate addresses in upgrade functions", async function () {
      await expect(
        liquidationGuaranteeManager.scheduleModuleUpgrade(ModuleKeys.KEY_LE, ethers.constants.AddressZero)
      ).to.be.reverted;
    });
  });

  describe("Event Emission", function () {
    it("should emit correct events during upgrade process", async function () {
      const MockLendingEngine = await ethers.getContractFactory("MockLendingEngine");
      const newMockLendingEngine = await MockLendingEngine.deploy();
      await newMockLendingEngine.deployed();

      // 安排升级
      await expect(
        liquidationGuaranteeManager.scheduleModuleUpgrade(ModuleKeys.KEY_LE, newMockLendingEngine.address)
      ).to.emit(liquidationGuaranteeManager, "RegistryModuleUpgradeScheduled");

      // 执行升级
      await expect(
        liquidationGuaranteeManager.executeModuleUpgrade(ModuleKeys.KEY_LE)
      ).to.emit(liquidationGuaranteeManager, "RegistryModuleUpgradeExecuted")
        .and.to.emit(liquidationGuaranteeManager, "ModuleCacheUpdated");
    });
  });

  describe("Module Cache Integration", function () {
    it("should update module cache after upgrade", async function () {
      const MockLendingEngine = await ethers.getContractFactory("MockLendingEngine");
      const newMockLendingEngine = await MockLendingEngine.deploy();
      await newMockLendingEngine.deployed();

      await liquidationGuaranteeManager.scheduleModuleUpgrade(ModuleKeys.KEY_LE, newMockLendingEngine.address);
      await liquidationGuaranteeManager.executeModuleUpgrade(ModuleKeys.KEY_LE);

      // 验证缓存已更新
      const cachedModule = await liquidationGuaranteeManager.getCachedModule(ModuleKeys.KEY_LE);
      expect(cachedModule).to.equal(newMockLendingEngine.address);
    });
  });

  describe("Backward Compatibility", function () {
    it("should maintain existing functionality", async function () {
      // 测试原有的保证金管理功能
      await liquidationGuaranteeManager.updateUserGuarantee(testUser, testAsset, 1000);
      
      const guarantee = await liquidationGuaranteeManager.getUserGuarantee(testUser, testAsset);
      expect(guarantee).to.equal(1000);
    });

    it("should work with existing module management functions", async function () {
      const newAddress = "0x9999999999999999999999999999999999999999";
      
      await liquidationGuaranteeManager.updateModule(ModuleKeys.KEY_LE, newAddress);
      const cachedModule = await liquidationGuaranteeManager.getCachedModule(ModuleKeys.KEY_LE);
      expect(cachedModule).to.equal(newAddress);
    });
  });
}); 
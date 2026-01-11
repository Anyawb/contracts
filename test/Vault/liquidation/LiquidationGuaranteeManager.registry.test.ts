import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@ethersproject/contracts";
import { Contract } from "ethers";

import { ModuleKeys } from '../../../frontend-config/moduleKeys';

// Action role hashes (aligned with ActionKeys.sol)
const ACTION_LIQUIDATE = ethers.id("LIQUIDATE");
const ACTION_SET_PARAMETER = ethers.id("SET_PARAMETER");
const ACTION_UPGRADE_MODULE = ethers.id("UPGRADE_MODULE");

// NOTE: LiquidationGuaranteeManager contract has been removed from src; keep tests skipped until module returns.
describe.skip("LiquidationGuaranteeManager Registry Integration", function () {
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

    // 部署 Registry (UUPS) via ERC1967Proxy to allow initializer
    const Registry = await ethers.getContractFactory("Registry");
    const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const registryImpl = await Registry.deploy();
    await registryImpl.waitForDeployment();
    const proxy = await ERC1967Proxy.deploy(
      await registryImpl.getAddress(),
      registryImpl.interface.encodeFunctionData("initialize", [0, deployer.address, deployer.address])
    );
    await proxy.waitForDeployment();
    registry = Registry.attach(await proxy.getAddress());

    // 部署 AccessControlManager
    const AccessControlManager = await ethers.getContractFactory("AccessControlManager");
    accessControlManager = await AccessControlManager.deploy(deployer.address);
    await accessControlManager.waitForDeployment();
    await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, await accessControlManager.getAddress());

    // 部署 Mock LendingEngine
    const MockLendingEngine = await ethers.getContractFactory("MockLendingEngine");
    mockLendingEngine = await MockLendingEngine.deploy();
    await mockLendingEngine.waitForDeployment();

    // 部署 LiquidationGuaranteeManager
    const LiquidationGuaranteeManager = await ethers.getContractFactory("LiquidationGuaranteeManager");
    liquidationGuaranteeManager = await LiquidationGuaranteeManager.deploy(await registry.getAddress());
    await liquidationGuaranteeManager.waitForDeployment();
    await liquidationGuaranteeManager.initialize(await accessControlManager.getAddress());

    // 注册模块到 Registry
    await registry.setModule(ModuleKeys.KEY_LE, await mockLendingEngine.getAddress());
    await registry.setModule(ModuleKeys.KEY_LIQUIDATION_GUARANTEE_MANAGER, await liquidationGuaranteeManager.getAddress());

    // 设置权限
    await accessControlManager.grantRole(ACTION_LIQUIDATE, deployer.address);
    await accessControlManager.grantRole(ACTION_SET_PARAMETER, deployer.address);
    await accessControlManager.grantRole(ACTION_UPGRADE_MODULE, deployer.address);
  });

  describe("Registry Integration", function () {
    it("should correctly initialize with Registry address", async function () {
      expect(await liquidationGuaranteeManager.registryAddr()).to.equal(await registry.getAddress());
    });

    it("should get module from Registry", async function () {
      const lendingEngine = await liquidationGuaranteeManager.getModule(ModuleKeys.KEY_LE);
      expect(lendingEngine).to.equal(await mockLendingEngine.getAddress());
    });

    it("should check if module is registered", async function () {
      const isRegistered = await liquidationGuaranteeManager.isModuleRegistered(ModuleKeys.KEY_LE);
      expect(isRegistered).to.be.true;
    });

    it("should revert when getting non-existent module", async function () {
      const nonExistentKey = ethers.keccak256(ethers.toUtf8Bytes("NON_EXISTENT_MODULE"));
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
      await newMockLendingEngine.waitForDeployment();
    });

    it("should schedule module upgrade", async function () {
      await expect(
        liquidationGuaranteeManager.scheduleModuleUpgrade(ModuleKeys.KEY_LE, await newMockLendingEngine.getAddress())
      ).to.emit(liquidationGuaranteeManager, "RegistryModuleUpgradeScheduled");
    });

    it("should execute module upgrade after delay", async function () {
      await liquidationGuaranteeManager.scheduleModuleUpgrade(ModuleKeys.KEY_LE, await newMockLendingEngine.getAddress());
      
      await expect(
        liquidationGuaranteeManager.executeModuleUpgrade(ModuleKeys.KEY_LE)
      ).to.emit(liquidationGuaranteeManager, "RegistryModuleUpgradeExecuted");
    });

    it("should cancel module upgrade", async function () {
      await liquidationGuaranteeManager.scheduleModuleUpgrade(ModuleKeys.KEY_LE, await newMockLendingEngine.getAddress());
      
      await expect(
        liquidationGuaranteeManager.cancelModuleUpgrade(ModuleKeys.KEY_LE)
      ).to.emit(liquidationGuaranteeManager, "RegistryModuleUpgradeCancelled");
    });

    it("should check if upgrade is ready", async function () {
      await liquidationGuaranteeManager.scheduleModuleUpgrade(ModuleKeys.KEY_LE, await newMockLendingEngine.getAddress());
      
      const isReady = await liquidationGuaranteeManager.isUpgradeReady(ModuleKeys.KEY_LE);
      expect(isReady).to.be.true;
    });

    it("should revert when scheduling upgrade for non-existent module", async function () {
      const nonExistentKey = ethers.keccak256(ethers.toUtf8Bytes("NON_EXISTENT_MODULE"));
      
      await expect(
        liquidationGuaranteeManager.scheduleModuleUpgrade(nonExistentKey, await newMockLendingEngine.getAddress())
      ).to.be.reverted;
    });

    it("should revert when executing upgrade before delay", async function () {
      // 使用有延时的 Registry
      const RegistryWithDelay = await ethers.getContractFactory("Registry");
      const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
      const registryImplWithDelay = await RegistryWithDelay.deploy();
      await registryImplWithDelay.waitForDeployment();
      const registryProxy = await ERC1967Proxy.deploy(
        await registryImplWithDelay.getAddress(),
        registryImplWithDelay.interface.encodeFunctionData("initialize", [3600, deployer.address, deployer.address])
      );
      await registryProxy.waitForDeployment();
      const registryWithDelay = RegistryWithDelay.attach(await registryProxy.getAddress());

      const LiquidationGuaranteeManagerWithDelay = await ethers.getContractFactory("LiquidationGuaranteeManager");
      const liquidationGuaranteeManagerWithDelay = await LiquidationGuaranteeManagerWithDelay.deploy(await registryWithDelay.getAddress());
      await liquidationGuaranteeManagerWithDelay.waitForDeployment();
      await liquidationGuaranteeManagerWithDelay.initialize(await accessControlManager.getAddress());

      await registryWithDelay.setModule(ModuleKeys.KEY_LE, await mockLendingEngine.getAddress());
      await liquidationGuaranteeManagerWithDelay.scheduleModuleUpgrade(ModuleKeys.KEY_LE, await newMockLendingEngine.getAddress());
      
      await expect(
        liquidationGuaranteeManagerWithDelay.executeModuleUpgrade(ModuleKeys.KEY_LE)
      ).to.be.revertedWith("LiquidationGuaranteeManager__UpgradeNotReady");
    });
  });

  describe("Safe Module Access", function () {
    it("should safely get module with error handling", async function () {
      const lendingEngine = await liquidationGuaranteeManager.safeGetModule(ModuleKeys.KEY_LE);
      expect(lendingEngine).to.equal(await mockLendingEngine.getAddress());
    });

    it("should revert when Registry is not initialized", async function () {
      const LiquidationGuaranteeManagerWithoutRegistry = await ethers.getContractFactory("LiquidationGuaranteeManager");
      const liquidationGuaranteeManagerWithoutRegistry = await LiquidationGuaranteeManagerWithoutRegistry.deploy(ethers.ZeroAddress);
      await liquidationGuaranteeManagerWithoutRegistry.waitForDeployment();
      await liquidationGuaranteeManagerWithoutRegistry.initialize(await accessControlManager.getAddress());

      await expect(
        liquidationGuaranteeManagerWithoutRegistry.safeGetModule(ModuleKeys.KEY_LE)
      ).to.be.revertedWith("LiquidationGuaranteeManager__RegistryNotInitialized");
    });

    it("should revert when module is not registered", async function () {
      const nonExistentKey = ethers.keccak256(ethers.toUtf8Bytes("NON_EXISTENT_MODULE"));
      
      await expect(
        liquidationGuaranteeManager.safeGetModule(nonExistentKey)
      ).to.be.revertedWith("LiquidationGuaranteeManager__ModuleNotRegistered");
    });
  });

  describe("Error Handling", function () {
    it("should revert with correct error names", async function () {
      // 测试自定义错误命名规范
      const nonExistentKey = ethers.keccak256(ethers.toUtf8Bytes("NON_EXISTENT_MODULE"));
      
      await expect(
        liquidationGuaranteeManager.safeGetModule(nonExistentKey)
      ).to.be.revertedWith("LiquidationGuaranteeManager__ModuleNotRegistered");
    });

    it("should validate addresses in upgrade functions", async function () {
      await expect(
        liquidationGuaranteeManager.scheduleModuleUpgrade(ModuleKeys.KEY_LE, ethers.ZeroAddress)
      ).to.be.reverted;
    });
  });

  describe("Event Emission", function () {
    it("should emit correct events during upgrade process", async function () {
      const MockLendingEngine = await ethers.getContractFactory("MockLendingEngine");
      const newMockLendingEngine = await MockLendingEngine.deploy();
      await newMockLendingEngine.waitForDeployment();

      // 安排升级
      await expect(
        liquidationGuaranteeManager.scheduleModuleUpgrade(ModuleKeys.KEY_LE, await newMockLendingEngine.getAddress())
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
      await newMockLendingEngine.waitForDeployment();

      await liquidationGuaranteeManager.scheduleModuleUpgrade(ModuleKeys.KEY_LE, await newMockLendingEngine.getAddress());
      await liquidationGuaranteeManager.executeModuleUpgrade(ModuleKeys.KEY_LE);

      // 验证缓存已更新
      const cachedModule = await liquidationGuaranteeManager.getCachedModule(ModuleKeys.KEY_LE);
      expect(cachedModule).to.equal(await newMockLendingEngine.getAddress());
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
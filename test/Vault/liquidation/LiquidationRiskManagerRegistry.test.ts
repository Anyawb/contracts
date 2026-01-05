import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { Contract, Signer } from "ethers";
import { ModuleKeys } from "../contracts/constants/ModuleKeys";

describe("LiquidationRiskManager Registry Upgrade", function () {
    let liquidationRiskManager: Contract;
    let registry: Contract;
    let mockAccessControl: Contract;
    let mockLendingEngine: Contract;
    let mockCollateralManager: Contract;
    let owner: Signer;
    let user: Signer;

    beforeEach(async function () {
        [owner, user] = await ethers.getSigners();

        // 部署 Registry（按照架构初始化）
        const Registry = await ethers.getContractFactory("Registry");
        registry = await Registry.deploy();
        await registry.initialize(7 * 24 * 60 * 60, owner.address, owner.address); // 7天延时

        // 部署 Mock AccessControl（单参数 owner）
        const MockAccessControl = await ethers.getContractFactory("MockAccessControlManager");
        mockAccessControl = await MockAccessControl.deploy();
        await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, mockAccessControl.address, true);

        // 部署 Mock LendingEngine
        const MockLendingEngine = await ethers.getContractFactory("MockLendingEngine");
        mockLendingEngine = await MockLendingEngine.deploy();

        // 部署 Mock CollateralManager
        const MockCollateralManager = await ethers.getContractFactory("MockCollateralManager");
        mockCollateralManager = await MockCollateralManager.deploy();

        // 在 Registry 中注册模块
        await registry.setModule(ModuleKeys.KEY_LE, mockLendingEngine.address, true);
        await registry.setModule(ModuleKeys.KEY_CM, mockCollateralManager.address, true);

        // 部署依赖库
        const riskLibFactory = await ethers.getContractFactory("src/Vault/liquidation/libraries/LiquidationRiskLib.sol:LiquidationRiskLib");
        const riskLib = await riskLibFactory.deploy();
        await riskLib.waitForDeployment();

        const riskBatchLibFactory = await ethers.getContractFactory("src/Vault/liquidation/libraries/LiquidationRiskBatchLib.sol:LiquidationRiskBatchLib");
        const riskBatchLib = await riskBatchLibFactory.deploy();
        await riskBatchLib.waitForDeployment();

        // 使用 UUPS Proxy 部署 LiquidationRiskManager
        const LiquidationRiskManager = await ethers.getContractFactory(
            "LiquidationRiskManager",
            {
                libraries: {
                    LiquidationRiskLib: await riskLib.getAddress(),
                    LiquidationRiskBatchLib: await riskBatchLib.getAddress(),
                },
            }
        );
        liquidationRiskManager = await upgrades.deployProxy(
            LiquidationRiskManager,
            [
                registry.address,
                mockAccessControl.address,
                300, // maxCacheDuration
                50   // maxBatchSize
            ],
            {
                unsafeAllowLinkedLibraries: true,
                kind: "uups",
            }
        );
        await liquidationRiskManager.waitForDeployment();
    });

    describe("Registry Integration", function () {
        it("should initialize with Registry address", async function () {
            expect(await liquidationRiskManager.registryAddr()).to.equal(registry.address);
        });

        it("should get module from Registry", async function () {
            const lendingEngine = await liquidationRiskManager.getModuleFromRegistry(ModuleKeys.KEY_LE);
            expect(lendingEngine).to.equal(mockLendingEngine.address);
        });

        it("should check if module is registered", async function () {
            const isRegistered = await liquidationRiskManager.isModuleRegistered(ModuleKeys.KEY_LE);
            expect(isRegistered).to.be.true;
        });
    });

    describe("Upgrade Flow", function () {
        it("should schedule module upgrade", async function () {
            const newModuleAddress = ethers.Wallet.createRandom().address;
            
            await expect(
                liquidationRiskManager.scheduleModuleUpgrade(ModuleKeys.KEY_LE, newModuleAddress)
            ).to.emit(liquidationRiskManager, "ModuleUpgradeScheduled")
                .withArgs(ModuleKeys.KEY_LE, ethers.ZeroAddress, newModuleAddress);
        });

        it("should get pending upgrade info", async function () {
            const newModuleAddress = ethers.Wallet.createRandom().address;
            await liquidationRiskManager.scheduleModuleUpgrade(ModuleKeys.KEY_LE, newModuleAddress);
            
            const [newAddress, executeAfter, hasPending] = await liquidationRiskManager.getPendingUpgrade(ModuleKeys.KEY_LE);
            expect(newAddress).to.equal(newModuleAddress);
            expect(hasPending).to.be.true;
        });

        it("should check if upgrade is ready", async function () {
            const newModuleAddress = ethers.Wallet.createRandom().address;
            await liquidationRiskManager.scheduleModuleUpgrade(ModuleKeys.KEY_LE, newModuleAddress);
            
            // 升级应该还没有准备就绪（需要等待延时）
            const isReady = await liquidationRiskManager.isUpgradeReady(ModuleKeys.KEY_LE);
            expect(isReady).to.be.false;
        });

        it("should cancel module upgrade", async function () {
            const newModuleAddress = ethers.Wallet.createRandom().address;
            await liquidationRiskManager.scheduleModuleUpgrade(ModuleKeys.KEY_LE, newModuleAddress);
            
            await expect(
                liquidationRiskManager.cancelModuleUpgrade(ModuleKeys.KEY_LE)
            ).to.emit(liquidationRiskManager, "ModuleUpgradeCancelled");
        });
    });

    describe("Naming Convention Compliance", function () {
        it("should use correct variable naming", async function () {
            // 检查状态变量命名是否符合规范
            expect(await liquidationRiskManager.liquidationThresholdVar()).to.be.a("bigint");
            expect(await liquidationRiskManager.minHealthFactorVar()).to.be.a("bigint");
            expect(await liquidationRiskManager.maxCacheDurationVar()).to.be.a("bigint");
            expect(await liquidationRiskManager.maxBatchSizeVar()).to.be.a("bigint");
        });

        it("should provide compatibility functions", async function () {
            // 检查兼容性函数
            expect(await liquidationRiskManager.liquidationThreshold()).to.be.a("bigint");
            expect(await liquidationRiskManager.minHealthFactor()).to.be.a("bigint");
            expect(await liquidationRiskManager.maxCacheDuration()).to.be.a("bigint");
            expect(await liquidationRiskManager.maxBatchSize()).to.be.a("bigint");
        });
    });

    describe("Error Handling", function () {
        it("should revert with correct error for zero address", async function () {
            await expect(
                liquidationRiskManager.scheduleModuleUpgrade(ModuleKeys.KEY_LE, ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(liquidationRiskManager, "ZeroAddress");
        });

        it("should revert with correct error for invalid batch size", async function () {
            const users = Array(51).fill(ethers.Wallet.createRandom().address);
            await expect(
                liquidationRiskManager.batchIsLiquidatable(users)
            ).to.be.revertedWithCustomError(liquidationRiskManager, "LiquidationRiskManager__InvalidBatchSize");
        });
    });
}); 
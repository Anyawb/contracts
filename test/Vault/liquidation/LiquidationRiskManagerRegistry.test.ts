import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { ModuleKeys } from "../contracts/constants/ModuleKeys";

describe("LiquidationRiskManager Registry Upgrade", function () {
    let liquidationRiskManager: any;
    let registry: any;
    let mockAccessControl: any;
    let mockLendingEngine: any;
    let mockCollateralManager: any;
    let mockPriceOracle: any;
    let mockSettlementToken: any;
    let healthView: any;
    let owner: any;
    let user: any;

    beforeEach(async function () {
        [owner, user] = await ethers.getSigners();

        // 部署 Registry（使用 UUPS Proxy）
        const Registry = await ethers.getContractFactory("Registry");
        registry = await upgrades.deployProxy(
            Registry,
            [7 * 24 * 60 * 60, owner.address, owner.address], // 7天延时
            { kind: "uups" }
        );
        await registry.waitForDeployment();

        // 部署 Mock AccessControl（单参数 owner）
        const MockAccessControl = await ethers.getContractFactory("MockAccessControlManager");
        mockAccessControl = await MockAccessControl.deploy();
        await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, await mockAccessControl.getAddress());

        // 部署 Mock LendingEngine
        const MockLendingEngine = await ethers.getContractFactory("MockLendingEngine");
        mockLendingEngine = await MockLendingEngine.deploy();
        await mockLendingEngine.waitForDeployment();

        // 部署 Mock CollateralManager
        const MockCollateralManager = await ethers.getContractFactory("MockCollateralManager");
        mockCollateralManager = await MockCollateralManager.deploy();
        await mockCollateralManager.waitForDeployment();

        // 部署 Mock PriceOracle
        const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
        mockPriceOracle = await MockPriceOracle.deploy();
        await mockPriceOracle.waitForDeployment();

        // 部署 Mock SettlementToken（ERC20）
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        mockSettlementToken = await MockERC20.deploy("MockSettlement", "MSET", 18);
        await mockSettlementToken.waitForDeployment();

        // 部署 HealthView（UUPS Proxy）
        const HealthView = await ethers.getContractFactory("HealthView");
        healthView = await upgrades.deployProxy(HealthView, [await registry.getAddress()], { kind: "uups" });
        await healthView.waitForDeployment();

        // 在 Registry 中注册模块
        await registry.setModule(ModuleKeys.KEY_LE, await mockLendingEngine.getAddress());
        await registry.setModule(ModuleKeys.KEY_CM, await mockCollateralManager.getAddress());
        await registry.setModule(ModuleKeys.KEY_PRICE_ORACLE, await mockPriceOracle.getAddress());
        await registry.setModule(ModuleKeys.KEY_SETTLEMENT_TOKEN, await mockSettlementToken.getAddress());
        await registry.setModule(ModuleKeys.KEY_HEALTH_VIEW, await healthView.getAddress());

        // 使用 UUPS Proxy 部署 LiquidationRiskManager
        // (LiquidationRiskLib and LiquidationRiskBatchLib functions are internal and will be inlined)
        const LiquidationRiskManager = await ethers.getContractFactory("LiquidationRiskManager");
        liquidationRiskManager = await upgrades.deployProxy(
            LiquidationRiskManager,
            [
                await registry.getAddress(),
                await mockAccessControl.getAddress(),
                300, // maxCacheDuration
                50   // maxBatchSize
            ],
            {
                kind: "uups",
            }
        );
        await liquidationRiskManager.waitForDeployment();
    });

    describe("Registry Integration", function () {
        it("should initialize with Registry address", async function () {
            expect(await liquidationRiskManager.registryAddr()).to.equal(await registry.getAddress());
        });

        it("should get module from Registry", async function () {
            const lendingEngine = await liquidationRiskManager.getModuleFromRegistry(ModuleKeys.KEY_LE);
            expect(lendingEngine).to.equal(await mockLendingEngine.getAddress());
        });

        it("should check if module is registered", async function () {
            const isRegistered = await liquidationRiskManager.isModuleRegistered(ModuleKeys.KEY_LE);
            expect(isRegistered).to.be.true;
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
        it("should revert with correct error for invalid batch size", async function () {
            const users = Array(51).fill(ethers.Wallet.createRandom().address);
            await expect(
                liquidationRiskManager.batchIsLiquidatable(users)
            ).to.be.revertedWithCustomError(liquidationRiskManager, "LiquidationRiskManager__InvalidBatchSize");
        });
    });
}); 
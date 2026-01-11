import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { ModuleKeys } from "../contracts/constants/ModuleKeys";

/**
 * Architecture-aligned tests (post-refactor):
 * - LiquidationRiskManager no longer performs oracle graceful degradation.
 * - Valuation + graceful degradation is centralized in LendingEngine valuation.
 * - RiskManager reads aggregated values from ledger modules (CM/LE).
 *
 * NOTE:
 * This file keeps the historical filename for continuity, but assertions reflect the new design.
 */
describe("LiquidationRiskManager - Valuation Centralization", function () {
    const ACTION_VIEW_PUSH = ethers.id("ACTION_VIEW_PUSH");

    const deployFixture = async () => {
        const [deployer, alice, bob] = await ethers.getSigners();

        // Registry (UUPS proxy)
        const Registry = await ethers.getContractFactory("Registry");
        const registry = await upgrades.deployProxy(
            Registry,
            [7 * 24 * 60 * 60, deployer.address, deployer.address],
            { kind: "uups" }
        );
        await registry.waitForDeployment();

        // AccessControl (required by RiskManager initializer)
        const AccessControlManager = await ethers.getContractFactory("AccessControlManager");
        const accessControl = await AccessControlManager.deploy(alice.address);
        await accessControl.waitForDeployment();
        await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, await accessControl.getAddress());
        // Allow the deployer (used in test calls) to push view cache data
        await accessControl.connect(alice).grantRole(ACTION_VIEW_PUSH, deployer.address);

        // Mocks
        const MockCollateralManager = await ethers.getContractFactory("MockCollateralManager");
        const collateralManager = await MockCollateralManager.deploy();
        await collateralManager.waitForDeployment();

        const MockLendingEngine = await ethers.getContractFactory("MockLendingEngine");
        const lendingEngine = await MockLendingEngine.deploy();
        await lendingEngine.waitForDeployment();

        // PositionView valuation source (minimal mock that exposes IPositionViewValuation)
        // NOTE: Risk score path reads:
        // - debt value from LendingEngine.getUserTotalDebtValue
        // - collateral value from PositionView.getUserTotalCollateralValue
        const MockPV = await ethers.getContractFactory("MockPositionViewValuation");
        const positionView = await MockPV.deploy();
        await positionView.waitForDeployment();

        const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
        const priceOracle = await MockPriceOracle.deploy();
        await priceOracle.waitForDeployment();

        const MockERC20 = await ethers.getContractFactory("MockERC20");
        const settlementToken = await MockERC20.deploy("Settlement Token", "SETT", 6);
        const testAsset = await MockERC20.deploy("Test Asset", "TEST", 18);
        await settlementToken.waitForDeployment();
        await testAsset.waitForDeployment();

        // Register modules BEFORE deploying RiskManager (it primes CM/LE in initialize)
        await registry.setModule(ModuleKeys.KEY_CM, await collateralManager.getAddress());
        await registry.setModule(ModuleKeys.KEY_LE, await lendingEngine.getAddress());
        await registry.setModule(ModuleKeys.KEY_POSITION_VIEW, await positionView.getAddress());

        // HealthView (required: RiskManager reads HF from HealthView cache)
        const HealthView = await ethers.getContractFactory("HealthView");
        const healthView = await upgrades.deployProxy(HealthView, [await registry.getAddress()], { kind: "uups" });
        await healthView.waitForDeployment();
        await registry.setModule(ModuleKeys.KEY_HEALTH_VIEW, await healthView.getAddress());

        // Optional modules (kept for completeness)
        await registry.setModule(ModuleKeys.KEY_PRICE_ORACLE, await priceOracle.getAddress());
        await registry.setModule(ModuleKeys.KEY_SETTLEMENT_TOKEN, await settlementToken.getAddress());

        // Deploy RiskManager (UUPS proxy)
        const LiquidationRiskManager = await ethers.getContractFactory("LiquidationRiskManager");
        const liquidationRiskManager = await upgrades.deployProxy(
            LiquidationRiskManager,
            [await registry.getAddress(), await alice.getAddress(), 300, 50],
            { kind: "uups" }
        );
        await liquidationRiskManager.waitForDeployment();

        return {
            liquidationRiskManager,
            healthView,
            collateralManager,
            lendingEngine,
            positionView,
            testAsset,
            settlementToken,
            alice,
        };
    };

    it("isLiquidatable uses HealthView cache (no oracle dependency)", async function () {
        const { liquidationRiskManager, healthView, collateralManager, lendingEngine, testAsset, settlementToken, alice } =
            await loadFixture(deployFixture);

        // Seed ledger values (used for risk score path)
        await collateralManager.setUserCollateral(alice.address, await testAsset.getAddress(), ethers.parseUnits("1000", 18));
        await lendingEngine.setUserDebt(alice.address, await settlementToken.getAddress(), ethers.parseUnits("500", 18));

        // Seed HealthView cache (timestamp=0 => use block.timestamp)
        // Granting roles is outside scope here; HealthView push is not role-gated in this minimal test environment.
        await healthView.pushRiskStatus(alice.address, 20_000, 10_000, false, 0);

        expect(await liquidationRiskManager.isLiquidatable(alice.address)).to.equal(false);
    });

    it("computes risk score from CM/LE aggregated values", async function () {
        const { liquidationRiskManager, lendingEngine, positionView, testAsset, settlementToken, alice } =
            await loadFixture(deployFixture);

        // collateral=1000, debt=500 => LTV=5000 => riskScore=60 (per LiquidationRiskLib thresholds).
        // NOTE: collateral value is read from PositionView.getUserTotalCollateralValue
        await positionView.setTotal(alice.address, ethers.parseUnits("1000", 18));
        await lendingEngine.setUserDebt(alice.address, await settlementToken.getAddress(), ethers.parseUnits("500", 18));

        const score = await liquidationRiskManager.getLiquidationRiskScore(alice.address);
        expect(score).to.equal(60n);
    });

    // NOTE: oracle health checks should be served by ValuationOracleView, not RiskManager.
});


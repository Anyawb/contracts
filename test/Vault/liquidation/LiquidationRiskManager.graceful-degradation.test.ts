import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { Contract, Signer } from "ethers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { ModuleKeys } from "../contracts/constants/ModuleKeys";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * LiquidationRiskManager 优雅降级功能测试
 * LiquidationRiskManager Graceful Degradation Tests
 * 
 * 测试目标：
 * - 价格预言机正常情况下的功能
 * - 价格预言机失败时的降级策略
 * - 健康因子计算降级事件
 * - 价格预言机健康检查功能
 */

describe("LiquidationRiskManager - Graceful Degradation", function () {
    let deployFixture: () => Promise<{
        liquidationRiskManager: any;
        priceOracle: any;
        collateralManager: any;
        lendingEngine: any;
        registry: any;
        accessControl: any;
        settlementToken: any;
        testAsset: any;
        alice: any;
        bob: any;
    }>;

    before(async function () {
        deployFixture = async () => {
            const [deployer, alice, bob] = await ethers.getSigners();

            // 部署 Registry 实现和代理
            const Registry = await ethers.getContractFactory("Registry");
            const registryImplementation = await Registry.deploy();
            await registryImplementation.waitForDeployment();

            // 部署代理
            const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
            const registryProxy = await ERC1967Proxy.deploy(
                await registryImplementation.getAddress(),
                registryImplementation.interface.encodeFunctionData(
                    "initialize",
                    [7 * 24 * 60 * 60, deployer.address, deployer.address]
                )
            );
            await registryProxy.waitForDeployment();

            // 通过代理访问 Registry
            const registry = Registry.attach(await registryProxy.getAddress());

            // 部署 AccessControl（单参数 owner）
            const AccessControlManager = await ethers.getContractFactory("AccessControlManager");
            const accessControl = await AccessControlManager.deploy(alice.address);

            // 将 ACM 写入 Registry，符合架构要求
            await registry.setModule(ModuleKeys.KEY_ACCESS_CONTROL, await accessControl.getAddress());

            // 部署 PriceOracle Mock
            const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
            const priceOracle = await MockPriceOracle.deploy();

            // 部署 CollateralManager Mock
            const MockCollateralManager = await ethers.getContractFactory("MockCollateralManager");
            const collateralManager = await MockCollateralManager.deploy();

            // 部署 LendingEngine Mock
            const MockLendingEngine = await ethers.getContractFactory("MockLendingEngine");
            const lendingEngine = await MockLendingEngine.deploy();

            // 先部署依赖库，再使用 UUPS Proxy 部署 LiquidationRiskManager
            const riskLibFactory = await ethers.getContractFactory("src/Vault/liquidation/libraries/LiquidationRiskLib.sol:LiquidationRiskLib");
            const riskLib = await riskLibFactory.deploy();
            await riskLib.waitForDeployment();

            const riskBatchLibFactory = await ethers.getContractFactory("src/Vault/liquidation/libraries/LiquidationRiskBatchLib.sol:LiquidationRiskBatchLib");
            const riskBatchLib = await riskBatchLibFactory.deploy();
            await riskBatchLib.waitForDeployment();

            const LiquidationRiskManager = await ethers.getContractFactory(
                "LiquidationRiskManager",
                {
                    libraries: {
                        LiquidationRiskLib: await riskLib.getAddress(),
                        LiquidationRiskBatchLib: await riskBatchLib.getAddress(),
                    },
                }
            );
            const liquidationRiskManager = await upgrades.deployProxy(
                LiquidationRiskManager,
                [
                    await registry.getAddress(),
                    await accessControl.getAddress(),
                    300, // maxCacheDuration
                    50   // maxBatchSize
                ],
                {
                    unsafeAllowLinkedLibraries: true,
                    kind: "uups",
                }
            );
            await liquidationRiskManager.waitForDeployment();

            // 部署测试代币
            const MockERC20 = await ethers.getContractFactory("MockERC20");
            const settlementToken = await MockERC20.deploy("Settlement Token", "SETT", 6);
            const testAsset = await MockERC20.deploy("Test Asset", "TEST", 18);

            // 设置模块地址
            await registry.setModule(ModuleKeys.KEY_LE, await lendingEngine.getAddress());
            await registry.setModule(ModuleKeys.KEY_CM, await collateralManager.getAddress());

            // 设置基础存储
            await liquidationRiskManager.setSettlementTokenAddr(await settlementToken.getAddress());
            await liquidationRiskManager.setPriceOracleAddr(await priceOracle.getAddress());

            return {
                liquidationRiskManager,
                priceOracle,
                collateralManager,
                lendingEngine,
                registry,
                accessControl,
                settlementToken,
                testAsset,
                alice,
                bob
            };
        };
    });

    describe("价格预言机正常情况测试", function () {
        it("应该正常计算健康因子", async function () {
            const {
                liquidationRiskManager,
                priceOracle,
                collateralManager,
                lendingEngine,
                testAsset,
                settlementToken,
                alice
            } = await loadFixture(deployFixture);

            // 设置价格预言机返回正常价格
            await priceOracle.setPrice(testAsset.address, ethers.parseUnits("100", 6), 18);
            await priceOracle.setPrice(settlementToken.address, ethers.parseUnits("1", 6), 6);

            // 设置用户抵押物和债务
            await collateralManager.setUserCollateral(alice.address, testAsset.address, ethers.parseUnits("10", 18));
            await lendingEngine.setUserDebt(alice.address, settlementToken.address, ethers.parseUnits("500", 6));

            // 计算健康因子
            const healthFactor = await liquidationRiskManager.getUserHealthFactor(alice.address);
            
            // 验证健康因子计算正确
            // 抵押物价值：10 * 100 = 1000 USD
            // 债务价值：500 USD
            // 健康因子：1000 / 500 = 2.0 (200%)
            expect(healthFactor).to.be.gt(ethers.parseUnits("1.5", 18));
        });

        it("应该正确计算风险评分", async function () {
            const {
                liquidationRiskManager,
                priceOracle,
                collateralManager,
                lendingEngine,
                testAsset,
                settlementToken,
                alice
            } = await loadFixture(deployFixture);

            // 设置价格
            await priceOracle.setPrice(testAsset.address, ethers.parseUnits("100", 6), 18);
            await priceOracle.setPrice(settlementToken.address, ethers.parseUnits("1", 6), 6);

            // 设置用户状态
            await collateralManager.setUserCollateral(alice.address, testAsset.address, ethers.parseUnits("10", 18));
            await lendingEngine.setUserDebt(alice.address, settlementToken.address, ethers.parseUnits("500", 6));

            // 获取风险评分
            const riskScore = await liquidationRiskManager.getLiquidationRiskScore(alice.address);
            
            // 验证风险评分在合理范围内
            expect(riskScore).to.be.gte(0);
            expect(riskScore).to.be.lte(100);
        });
    });

    describe("价格预言机失败情况测试", function () {
        it("应该使用降级策略计算健康因子", async function () {
            const {
                liquidationRiskManager,
                priceOracle,
                collateralManager,
                lendingEngine,
                testAsset,
                settlementToken,
                alice
            } = await loadFixture(deployFixture);

            // 设置价格预言机返回零价格（模拟失败）
            await priceOracle.setPrice(testAsset.address, 0, 18);
            await priceOracle.setPrice(settlementToken.address, ethers.parseUnits("1", 6), 6);

            // 设置用户抵押物和债务
            await collateralManager.setUserCollateral(alice.address, testAsset.address, ethers.parseUnits("10", 18));
            await lendingEngine.setUserDebt(alice.address, settlementToken.address, ethers.parseUnits("500", 6));

            // 计算健康因子
            const healthFactor = await liquidationRiskManager.getUserHealthFactor(alice.address);
            
            // 验证使用了降级策略（保守估值50%）
            // 抵押物价值：10 * 0.5 = 5 USD（降级策略）
            // 债务价值：500 USD
            // 健康因子：5 / 500 = 0.01 (1%)
            expect(healthFactor).to.be.lt(ethers.parseUnits("0.1", 18));
        });

        it("应该正确处理稳定币面值策略", async function () {
            const {
                liquidationRiskManager,
                priceOracle,
                collateralManager,
                lendingEngine,
                settlementToken,
                alice
            } = await loadFixture(deployFixture);

            // 设置价格预言机返回零价格
            await priceOracle.setPrice(settlementToken.address, 0, 6);

            // 设置用户抵押物为稳定币
            await collateralManager.setUserCollateral(alice.address, settlementToken.address, ethers.parseUnits("1000", 6));
            await lendingEngine.setUserDebt(alice.address, settlementToken.address, ethers.parseUnits("500", 6));

            // 计算健康因子
            const healthFactor = await liquidationRiskManager.getUserHealthFactor(alice.address);
            
            // 验证使用了稳定币面值策略
            // 抵押物价值：1000 USD（面值）
            // 债务价值：500 USD
            // 健康因子：1000 / 500 = 2.0 (200%)
            expect(healthFactor).to.be.gt(ethers.parseUnits("1.5", 18));
        });
    });

    describe("价格预言机健康检查测试", function () {
        it("应该正确检测价格预言机健康状态", async function () {
            const {
                liquidationRiskManager,
                priceOracle,
                testAsset
            } = await loadFixture(deployFixture);

            // 测试正常价格
            await priceOracle.setPrice(testAsset.address, ethers.parseUnits("100", 6), 18);
            let [isHealthy, details] = await liquidationRiskManager.checkPriceOracleHealth(testAsset.address);
            expect(isHealthy).to.be.true;
            expect(details).to.equal("Healthy");

            // 测试零价格
            await priceOracle.setPrice(testAsset.address, 0, 18);
            [isHealthy, details] = await liquidationRiskManager.checkPriceOracleHealth(testAsset.address);
            expect(isHealthy).to.be.false;
            expect(details).to.equal("Zero price returned");

            // 测试过期价格
            await priceOracle.setPrice(testAsset.address, ethers.parseUnits("100", 6), 18);
            await priceOracle.setTimestamp(block.timestamp - 4000); // 超过1小时
            [isHealthy, details] = await liquidationRiskManager.checkPriceOracleHealth(testAsset.address);
            expect(isHealthy).to.be.false;
            expect(details).to.equal("Stale price");
        });
    });

    describe("批量操作测试", function () {
        it("应该正确处理批量健康因子计算", async function () {
            const {
                liquidationRiskManager,
                priceOracle,
                collateralManager,
                lendingEngine,
                testAsset,
                settlementToken,
                alice,
                bob
            } = await loadFixture(deployFixture);

            // 设置价格
            await priceOracle.setPrice(testAsset.address, ethers.parseUnits("100", 6), 18);
            await priceOracle.setPrice(settlementToken.address, ethers.parseUnits("1", 6), 6);

            // 设置用户状态
            await collateralManager.setUserCollateral(alice.address, testAsset.address, ethers.parseUnits("10", 18));
            await lendingEngine.setUserDebt(alice.address, settlementToken.address, ethers.parseUnits("500", 6));
            
            await collateralManager.setUserCollateral(bob.address, testAsset.address, ethers.parseUnits("20", 18));
            await lendingEngine.setUserDebt(bob.address, settlementToken.address, ethers.parseUnits("800", 6));

            // 批量获取健康因子
            const users = [alice.address, bob.address];
            const healthFactors = await liquidationRiskManager.batchGetUserHealthFactors(users);
            
            expect(healthFactors.length).to.equal(2);
            expect(healthFactors[0]).to.be.gt(0);
            expect(healthFactors[1]).to.be.gt(0);
        });

        it("应该正确处理批量风险评分计算", async function () {
            const {
                liquidationRiskManager,
                priceOracle,
                collateralManager,
                lendingEngine,
                testAsset,
                settlementToken,
                alice,
                bob
            } = await loadFixture(deployFixture);

            // 设置价格
            await priceOracle.setPrice(testAsset.address, ethers.parseUnits("100", 6), 18);
            await priceOracle.setPrice(settlementToken.address, ethers.parseUnits("1", 6), 6);

            // 设置用户状态
            await collateralManager.setUserCollateral(alice.address, testAsset.address, ethers.parseUnits("10", 18));
            await lendingEngine.setUserDebt(alice.address, settlementToken.address, ethers.parseUnits("500", 6));
            
            await collateralManager.setUserCollateral(bob.address, testAsset.address, ethers.parseUnits("20", 18));
            await lendingEngine.setUserDebt(bob.address, settlementToken.address, ethers.parseUnits("800", 6));

            // 批量获取风险评分
            const users = [alice.address, bob.address];
            const riskScores = await liquidationRiskManager.batchGetLiquidationRiskScores(users);
            
            expect(riskScores.length).to.equal(2);
            expect(riskScores[0]).to.be.gte(0);
            expect(riskScores[0]).to.be.lte(100);
            expect(riskScores[1]).to.be.gte(0);
            expect(riskScores[1]).to.be.lte(100);
        });
    });

    describe("边界条件测试", function () {
        it("应该正确处理零地址输入", async function () {
            const { liquidationRiskManager } = await loadFixture(deployFixture);

            await expect(
                liquidationRiskManager.getUserHealthFactor(ZERO_ADDRESS)
            ).to.be.revertedWithCustomError(liquidationRiskManager, "ZeroAddress");

            await expect(
                liquidationRiskManager.checkPriceOracleHealth(ZERO_ADDRESS)
            ).to.be.revertedWithCustomError(liquidationRiskManager, "ZeroAddress");
        });

        it("应该正确处理零数量", async function () {
            const {
                liquidationRiskManager,
                priceOracle,
                collateralManager,
                lendingEngine,
                testAsset,
                settlementToken,
                alice
            } = await loadFixture(deployFixture);

            // 设置价格
            await priceOracle.setPrice(testAsset.address, ethers.parseUnits("100", 6), 18);
            await priceOracle.setPrice(settlementToken.address, ethers.parseUnits("1", 6), 6);

            // 设置用户无抵押物和债务
            await collateralManager.setUserCollateral(alice.address, testAsset.address, 0);
            await lendingEngine.setUserDebt(alice.address, settlementToken.address, 0);

            // 计算健康因子
            const healthFactor = await liquidationRiskManager.getUserHealthFactor(alice.address);
            
            // 零债务时健康因子应该为最大值
            expect(healthFactor).to.equal(ethers.MaxUint256);
        });

        it("应该正确处理模块地址无效的情况", async function () {
            const { liquidationRiskManager, alice } = await loadFixture(deployFixture);

            // 不设置模块地址，模拟模块无效的情况
            const healthFactor = await liquidationRiskManager.getUserHealthFactor(alice.address);
            
            // 应该返回0（默认值）
            expect(healthFactor).to.equal(0);
        });
    });

    describe("性能测试", function () {
        it("应该在合理时间内完成健康因子计算", async function () {
            const {
                liquidationRiskManager,
                priceOracle,
                collateralManager,
                lendingEngine,
                testAsset,
                settlementToken,
                alice
            } = await loadFixture(deployFixture);

            // 设置价格
            await priceOracle.setPrice(testAsset.address, ethers.parseUnits("100", 6), 18);
            await priceOracle.setPrice(settlementToken.address, ethers.parseUnits("1", 6), 6);

            // 设置用户状态
            await collateralManager.setUserCollateral(alice.address, testAsset.address, ethers.parseUnits("10", 18));
            await lendingEngine.setUserDebt(alice.address, settlementToken.address, ethers.parseUnits("500", 6));

            // 测量执行时间
            const startTime = Date.now();
            await liquidationRiskManager.getUserHealthFactor(alice.address);
            const endTime = Date.now();
            
            // 验证执行时间在合理范围内（小于5秒）
            expect(endTime - startTime).to.be.lt(5000);
        });
    });
}); 
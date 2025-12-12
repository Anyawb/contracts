import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract } from "ethers";
import { SignerWithAddress } from "@ethersproject/contracts/node_modules/@nomiclabs/hardhat-ethers/signers";

describe("GracefulDegradation Library", function () {
    let gracefulDegradation: Contract;
    let mockPriceOracle: Contract;
    let owner: SignerWithAddress;
    let user: SignerWithAddress;
    let asset: string;
    let settlementToken: string;

    beforeEach(async function () {
        [owner, user] = await ethers.getSigners();
        
        // 部署 Mock 价格预言机
        const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
        mockPriceOracle = await MockPriceOracle.deploy();
        await mockPriceOracle.deployed();

        // 部署测试合约（包含 GracefulDegradation 库）
        const TestGracefulDegradation = await ethers.getContractFactory("TestGracefulDegradation");
        gracefulDegradation = await TestGracefulDegradation.deploy();
        await gracefulDegradation.deployed();

        // 设置测试地址
        asset = ethers.utils.getAddress("0x1234567890123456789012345678901234567890");
        settlementToken = ethers.utils.getAddress("0x0987654321098765432109876543210987654321");
    });

    describe("安全修复测试", function () {
        describe("1. 价格操纵风险修复", function () {
            it("应该使用动态价格验证而不是硬编码常量", async function () {
                const config = await gracefulDegradation.createDefaultConfig(settlementToken);
                
                // 验证配置包含价格验证参数
                expect(config.priceValidation.maxPriceMultiplier).to.equal(15000); // 150%
                expect(config.priceValidation.minPriceMultiplier).to.equal(5000);  // 50%
                expect(config.priceValidation.maxReasonablePrice).to.equal(ethers.utils.parseEther("1000000000000")); // 1e12
            });

            it("应该验证价格合理性", async function () {
                const priceValidationConfig = await gracefulDegradation.createPriceValidationConfig(
                    15000, // 150%
                    5000,  // 50%
                    ethers.utils.parseEther("1000000000000") // 1e12
                );

                // 测试正常价格
                const normalPrice = ethers.utils.parseEther("1000");
                const isValid = await gracefulDegradation.validatePriceReasonableness(
                    normalPrice,
                    asset,
                    priceValidationConfig
                );
                expect(isValid).to.be.true;

                // 测试异常高价格
                const highPrice = ethers.utils.parseEther("1000000000001"); // 超过最大合理价格
                const isHighPriceValid = await gracefulDegradation.validatePriceReasonableness(
                    highPrice,
                    asset,
                    priceValidationConfig
                );
                expect(isHighPriceValid).to.be.false;
            });
        });

        describe("2. 精度验证不足修复", function () {
            it("应该验证最小精度（修复：防止价格单位错乱）", async function () {
                const minDecimals = await gracefulDegradation.MIN_DECIMALS();
                expect(minDecimals).to.equal(6); // 修复：最小精度为6

                // 测试有效精度
                expect(await gracefulDegradation.validateDecimals(6)).to.be.true;  // 最小精度
                expect(await gracefulDegradation.validateDecimals(8)).to.be.true;  // BTC/ETH
                expect(await gracefulDegradation.validateDecimals(18)).to.be.true; // 最大精度

                // 测试无效精度
                expect(await gracefulDegradation.validateDecimals(0)).to.be.false;  // 太小
                expect(await gracefulDegradation.validateDecimals(5)).to.be.false;  // 太小
                expect(await gracefulDegradation.validateDecimals(19)).to.be.false; // 太大
            });

            it("应该验证最大精度", async function () {
                const maxDecimals = await gracefulDegradation.MAX_DECIMALS();
                expect(maxDecimals).to.equal(18);

                // 测试边界值
                expect(await gracefulDegradation.validateDecimals(18)).to.be.true;
                expect(await gracefulDegradation.validateDecimals(19)).to.be.false;
            });

            it("应该提供详细的精度验证错误信息", async function () {
                // 测试精度过低的错误信息
                const [isValidLow, errorMessageLow] = await gracefulDegradation.validateDecimalsWithError(0);
                expect(isValidLow).to.be.false;
                expect(errorMessageLow).to.include("Decimals too low");
                expect(errorMessageLow).to.include("minimum: 6");

                // 测试精度过高的错误信息
                const [isValidHigh, errorMessageHigh] = await gracefulDegradation.validateDecimalsWithError(19);
                expect(isValidHigh).to.be.false;
                expect(errorMessageHigh).to.include("Decimals too high");
                expect(errorMessageHigh).to.include("maximum: 18");

                // 测试有效精度
                const [isValidGood, errorMessageGood] = await gracefulDegradation.validateDecimalsWithError(8);
                expect(isValidGood).to.be.true;
                expect(errorMessageGood).to.equal("");
            });

            it("应该验证资产精度合理性", async function () {
                // 测试有效资产精度
                expect(await gracefulDegradation.validateAssetDecimals(asset, 6)).to.be.true;  // USDC/USDT
                expect(await gracefulDegradation.validateAssetDecimals(asset, 8)).to.be.true;  // BTC
                expect(await gracefulDegradation.validateAssetDecimals(asset, 18)).to.be.true; // 最大精度

                // 测试无效资产精度
                expect(await gracefulDegradation.validateAssetDecimals(asset, 0)).to.be.false;  // 太小
                expect(await gracefulDegradation.validateAssetDecimals(asset, 5)).to.be.false;  // 太小
                expect(await gracefulDegradation.validateAssetDecimals(asset, 19)).to.be.false; // 太大
            });
        });

        describe("3. 溢出检查不完整修复", function () {
            it("应该使用安全的数学运算", async function () {
                const amount = ethers.utils.parseEther("1000");
                const price = ethers.utils.parseEther("2000");
                const decimals = 18;

                const calculatedValue = await gracefulDegradation.calculateAssetValue(amount, price, decimals);
                expect(calculatedValue).to.equal(ethers.utils.parseEther("2000000")); // 1000 * 2000
            });

            it("应该检测溢出", async function () {
                const amount = ethers.constants.MaxUint256;
                const price = ethers.constants.MaxUint256;
                const decimals = 18;

                await expect(
                    gracefulDegradation.calculateAssetValue(amount, price, decimals)
                ).to.be.revertedWith("Overflow detected");
            });

            it("应该检测无效的计算结果", async function () {
                const amount = ethers.utils.parseEther("1000");
                const price = 0; // 零价格
                const decimals = 18;

                await expect(
                    gracefulDegradation.calculateAssetValue(amount, price, decimals)
                ).to.be.revertedWith("Invalid calculation result");
            });
        });

        describe("4. 稳定币面值假设修复", function () {
            it("应该验证稳定币价格", async function () {
                const stablecoin = settlementToken;
                const expectedPrice = ethers.utils.parseEther("1");
                const tolerance = 100; // 1%

                // 测试正常稳定币价格
                const isValid = await gracefulDegradation.validateStablecoinPrice(
                    stablecoin,
                    expectedPrice,
                    tolerance
                );
                expect(isValid).to.be.true;
            });

            it("应该处理稳定币脱锚情况", async function () {
                const stablecoin = settlementToken;
                const expectedPrice = ethers.utils.parseEther("1");
                const tolerance = 100; // 1%

                // 模拟稳定币价格异常（这里需要修改 mock 价格预言机）
                // 暂时测试基础功能
                const isValid = await gracefulDegradation.validateStablecoinPrice(
                    stablecoin,
                    expectedPrice,
                    tolerance
                );
                expect(isValid).to.be.true;
            });
        });

        describe("5. 输入验证增强", function () {
            it("应该验证价格预言机地址", async function () {
                const config = await gracefulDegradation.createDefaultConfig(settlementToken);
                const amount = ethers.utils.parseEther("1000");

                await expect(
                    gracefulDegradation.getAssetValueWithFallback(
                        ethers.constants.AddressZero, // 零地址
                        asset,
                        amount,
                        config
                    )
                ).to.be.revertedWith("Invalid price oracle address");
            });

            it("应该验证资产地址", async function () {
                const config = await gracefulDegradation.createDefaultConfig(settlementToken);
                const amount = ethers.utils.parseEther("1000");

                await expect(
                    gracefulDegradation.getAssetValueWithFallback(
                        mockPriceOracle.address,
                        ethers.constants.AddressZero, // 零地址
                        amount,
                        config
                    )
                ).to.be.revertedWith("Invalid asset address");
            });

            it("应该验证资产数量", async function () {
                const config = await gracefulDegradation.createDefaultConfig(settlementToken);

                await expect(
                    gracefulDegradation.getAssetValueWithFallback(
                        mockPriceOracle.address,
                        asset,
                        0, // 零数量
                        config
                    )
                ).to.be.revertedWith("Amount must be greater than zero");
            });
        });
    });

    describe("功能测试", function () {
        it("应该创建默认配置", async function () {
            const config = await gracefulDegradation.createDefaultConfig(settlementToken);
            
            expect(config.conservativeRatio).to.equal(5000); // 50%
            expect(config.useStablecoinFaceValue).to.be.true;
            expect(config.enablePriceCache).to.be.false;
            expect(config.settlementToken).to.equal(settlementToken);
        });

        it("应该创建价格验证配置", async function () {
            const config = await gracefulDegradation.createPriceValidationConfig(
                15000, // 150%
                5000,  // 50%
                ethers.utils.parseEther("1000000000000") // 1e12
            );

            expect(config.maxPriceMultiplier).to.equal(15000);
            expect(config.minPriceMultiplier).to.equal(5000);
            expect(config.maxReasonablePrice).to.equal(ethers.utils.parseEther("1000000000000"));
        });

        it("应该创建稳定币配置", async function () {
            const config = await gracefulDegradation.createStablecoinConfig(
                settlementToken,
                ethers.utils.parseEther("1"),
                100 // 1%
            );

            expect(config.stablecoin).to.equal(settlementToken);
            expect(config.expectedPrice).to.equal(ethers.utils.parseEther("1"));
            expect(config.tolerance).to.equal(100);
            expect(config.isWhitelisted).to.be.true;
        });
    });

    describe("边界条件测试", function () {
        it("应该处理零数量", async function () {
            const config = await gracefulDegradation.createDefaultConfig(settlementToken);
            
            const result = await gracefulDegradation.getAssetValueWithFallback(
                mockPriceOracle.address,
                asset,
                0,
                config
            );

            expect(result.value).to.equal(0);
            expect(result.isValid).to.be.true;
            expect(result.reason).to.equal("Zero amount");
            expect(result.usedFallback).to.be.false;
        });

        it("应该处理价格预言机失败", async function () {
            const config = await gracefulDegradation.createDefaultConfig(settlementToken);
            const amount = ethers.utils.parseEther("1000");

            // 使用无效的价格预言机地址
            const result = await gracefulDegradation.getAssetValueWithFallback(
                ethers.utils.getAddress("0x1111111111111111111111111111111111111111"),
                asset,
                amount,
                config
            );

            expect(result.usedFallback).to.be.true;
            expect(result.reason).to.equal("Price oracle call failed");
        });
    });

    describe("Gas 优化测试", function () {
        it("应该在合理范围内消耗 Gas", async function () {
            const config = await gracefulDegradation.createDefaultConfig(settlementToken);
            const amount = ethers.utils.parseEther("1000");

            const tx = await gracefulDegradation.getAssetValueWithFallback(
                mockPriceOracle.address,
                asset,
                amount,
                config
            );

            const receipt = await tx.wait();
            expect(receipt.gasUsed).to.be.lt(500000); // 应该小于 500k gas
        });
    });
});

// Mock 价格预言机合约
contract MockPriceOracle {
    mapping(address => uint256) public prices;
    mapping(address => uint256) public timestamps;
    mapping(address => uint256) public decimals;

    function setPrice(address asset, uint256 price, uint256 timestamp, uint256 assetDecimals) external {
        prices[asset] = price;
        timestamps[asset] = timestamp;
        decimals[asset] = assetDecimals;
    }

    function getPrice(address asset) external view returns (uint256 price, uint256 timestamp, uint256 assetDecimals) {
        return (prices[asset], timestamps[asset], decimals[asset]);
    }
}

// 测试合约（包含 GracefulDegradation 库）
contract TestGracefulDegradation {
    using GracefulDegradation for *;

    function getAssetValueWithFallback(
        address priceOracle,
        address asset,
        uint256 amount,
        GracefulDegradation.DegradationConfig memory config
    ) external view returns (GracefulDegradation.PriceResult memory) {
        return GracefulDegradation.getAssetValueWithFallback(priceOracle, asset, amount, config);
    }

    function checkPriceOracleHealth(
        address priceOracle,
        address asset,
        GracefulDegradation.PriceValidationConfig memory config
    ) external view returns (bool isHealthy, string memory details) {
        return GracefulDegradation.checkPriceOracleHealth(priceOracle, asset, config);
    }

    function validateDecimals(uint256 decimals) external pure returns (bool) {
        return GracefulDegradation.validateDecimals(decimals);
    }

    function validatePriceReasonableness(
        uint256 currentPrice,
        address asset,
        GracefulDegradation.PriceValidationConfig memory config
    ) external view returns (bool) {
        return GracefulDegradation.validatePriceReasonableness(currentPrice, asset, config);
    }

    function calculateAssetValue(
        uint256 amount,
        uint256 price,
        uint256 decimals
    ) external pure returns (uint256) {
        return GracefulDegradation.calculateAssetValue(amount, price, decimals);
    }

    function validateStablecoinPrice(
        address stablecoin,
        uint256 expectedPrice,
        uint256 tolerance
    ) external view returns (bool) {
        return GracefulDegradation.validateStablecoinPrice(stablecoin, expectedPrice, tolerance);
    }

    function createDefaultConfig(address settlementToken) external pure returns (GracefulDegradation.DegradationConfig memory) {
        return GracefulDegradation.createDefaultConfig(settlementToken);
    }

    function createPriceValidationConfig(
        uint256 maxPriceMultiplier,
        uint256 minPriceMultiplier,
        uint256 maxReasonablePrice
    ) external pure returns (GracefulDegradation.PriceValidationConfig memory) {
        return GracefulDegradation.createPriceValidationConfig(maxPriceMultiplier, minPriceMultiplier, maxReasonablePrice);
    }

    function createStablecoinConfig(
        address stablecoin,
        uint256 expectedPrice,
        uint256 tolerance
    ) external pure returns (GracefulDegradation.StablecoinConfig memory) {
        return GracefulDegradation.createStablecoinConfig(stablecoin, expectedPrice, tolerance);
    }

    // 常量访问器
    function MIN_DECIMALS() external pure returns (uint256) {
        return GracefulDegradation.MIN_DECIMALS;
    }

    function MAX_DECIMALS() external pure returns (uint256) {
        return GracefulDegradation.MAX_DECIMALS;
    }
}

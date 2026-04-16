import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract } from "ethers";

describe("GracefulDegradation Library", function () {
    let gracefulDegradation: Contract;
    let mockPriceOracle: Contract;
    let asset: string;
    let settlementToken: string;
    let hkdToken: string;

    beforeEach(async function () {
        const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
        mockPriceOracle = await MockPriceOracle.deploy();
        await mockPriceOracle.waitForDeployment();

        const TestGracefulDegradation = await ethers.getContractFactory("TestGracefulDegradation");
        gracefulDegradation = await TestGracefulDegradation.deploy();
        await gracefulDegradation.waitForDeployment();

        asset = ethers.getAddress("0x1234567890123456789012345678901234567890");
        settlementToken = ethers.getAddress("0x0987654321098765432109876543210987654321");
        hkdToken = ethers.getAddress("0x2222222222222222222222222222222222222222");
    });

    function buildDefaultConfig(overrides?: {
        stablecoinConfig?: Record<string, unknown>;
        additionalStablecoinConfigs?: Array<Record<string, unknown>>;
    }) {
        return {
            conservativeRatio: 5000n,
            useStablecoinFaceValue: true,
            enablePriceCache: false,
            settlementToken,
            priceValidation: {
                maxPriceMultiplier: 15000n,
                minPriceMultiplier: 5000n,
                priceUpdateThreshold: 300n,
                maxPriceAgeBlocks: 300n,
                maxReasonablePrice: 1000000000000n,
                enableHistoricalValidation: false,
            },
            stablecoinConfig: {
                stablecoin: settlementToken,
                isWhitelisted: true,
                enableDepegDetection: false,
                expectedPrice: 0n,
                tolerance: 100n,
                assetDecimals: 0n,
                ...(overrides?.stablecoinConfig ?? {}),
            },
            additionalStablecoinConfigs: overrides?.additionalStablecoinConfigs ?? [],
            retryConfig: {
                maxRetryCount: 1n,
                retryDelay: 0n,
                maxGasLimit: 500000n,
                enableRetry: true,
                retryOnNetworkError: true,
                retryOnTimeout: true,
            },
        };
    }

    it("创建默认配置时应延迟到 assetDecimals 决定 stablecoin peg 精度", async function () {
        const config = await gracefulDegradation.createDefaultConfig(settlementToken);

        expect(config.conservativeRatio).to.equal(5000n);
        expect(config.useStablecoinFaceValue).to.equal(true);
        expect(config.enablePriceCache).to.equal(false);
        expect(config.settlementToken).to.equal(settlementToken);
        expect(config.stablecoinConfig.expectedPrice).to.equal(0n);
    });

    it("应继续校验 decimals 边界", async function () {
        expect(await gracefulDegradation.validateDecimals(6)).to.equal(true);
        expect(await gracefulDegradation.validateDecimals(18)).to.equal(true);
        expect(await gracefulDegradation.validateDecimals(5)).to.equal(false);
        expect(await gracefulDegradation.validateDecimals(19)).to.equal(false);
    });

    it("应按 token decimals 计算 asset-native 价值", async function () {
        const amount = 1_500_000n;
        const price = 1_000_000n;
        const value = await gracefulDegradation.calculateAssetValue(amount, price, 6);
        expect(value).to.equal(1_500_000n);
    });

    it("应基于实际 oracle price 做 stablecoin 脱锚校验", async function () {
        expect(
            await gracefulDegradation.validateStablecoinPrice(1_000_000n, 1_000_000n, 100)
        ).to.equal(true);
        expect(
            await gracefulDegradation.validateStablecoinPrice(970_000n, 1_000_000n, 100)
        ).to.equal(false);
    });

    it("settlement token 在 oracle 返回零价时应回退到 asset-native peg 估值", async function () {
        await mockPriceOracle.configureAsset(settlementToken, "mock-usdc", 6, 300);
        await mockPriceOracle.setPrice(settlementToken, 0, await ethers.provider.getBlockNumber(), 6);

        const config = buildDefaultConfig();
        const amount = 1_000_000n;
        const result = await gracefulDegradation.getAssetValueWithFallback(
            await mockPriceOracle.getAddress(),
            settlementToken,
            amount,
            config
        );

        expect(result.usedFallback).to.equal(true);
        expect(result.isValid).to.equal(true);
        expect(result.value).to.equal(1_000_000n);
    });

    it("已显式配置的 mHKD 应按其 peg 价格做 fallback 估值", async function () {
        await mockPriceOracle.configureAsset(hkdToken, "mock-hkd", 6, 300);
        await mockPriceOracle.setPrice(hkdToken, 0, await ethers.provider.getBlockNumber(), 6);

        const config = buildDefaultConfig({
            additionalStablecoinConfigs: [
                {
                    stablecoin: hkdToken,
                    isWhitelisted: true,
                    enableDepegDetection: true,
                    expectedPrice: 128000n,
                    tolerance: 150n,
                    assetDecimals: 6n,
                },
            ],
        });

        const amount = 100_000_000n;
        const result = await gracefulDegradation.getAssetValueWithFallback(
            await mockPriceOracle.getAddress(),
            hkdToken,
            amount,
            config
        );

        expect(result.usedFallback).to.equal(true);
        expect(result.isValid).to.equal(true);
        expect(result.value).to.equal(12_800_000n);
    });

    it("已显式配置的 stablecoin 在 oracle 明确脱锚时应转为保守估值", async function () {
        await mockPriceOracle.configureAsset(hkdToken, "mock-hkd", 6, 300);
        await mockPriceOracle.setPrice(hkdToken, 100000n, await ethers.provider.getBlockNumber(), 6);

        const config = buildDefaultConfig({
            additionalStablecoinConfigs: [
                {
                    stablecoin: hkdToken,
                    isWhitelisted: true,
                    enableDepegDetection: true,
                    expectedPrice: 128000n,
                    tolerance: 100n,
                    assetDecimals: 6n,
                },
            ],
        });

        const amount = 100_000_000n;
        const result = await gracefulDegradation.getAssetValueWithFallback(
            await mockPriceOracle.getAddress(),
            hkdToken,
            amount,
            config
        );

        expect(result.usedFallback).to.equal(true);
        expect(result.reason).to.equal("Stablecoin depeg detected");
        expect(result.value).to.equal(50000000n);
    });

    it("未配置为 stablecoin 的资产仍应走保守 fallback", async function () {
        await mockPriceOracle.configureAsset(asset, "mock-risk", 18, 300);
        await mockPriceOracle.setShouldFail(true);

        const config = buildDefaultConfig();
        const amount = ethers.parseEther("10");
        const result = await gracefulDegradation.getAssetValueWithFallback(
            await mockPriceOracle.getAddress(),
            asset,
            amount,
            config
        );

        expect(result.usedFallback).to.equal(true);
        expect(result.value).to.equal(ethers.parseEther("5"));
    });
});

import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("LiquidationDebtManager - 新增积分功能", function () {
    let liquidationDebtManager: Contract;
    let rewardManager: Contract;
    let mockToken: Contract;
    let owner: Signer;
    let liquidator: Signer;
    let user: Signer;
    let feeReceiver: Signer;

    async function deployFixture() {
        const [owner, liquidator, user, feeReceiver] = await ethers.getSigners();

        // 部署Mock合约
        const MockToken = await ethers.getContractFactory("MockERC20");
        const mockToken = await MockToken.deploy("Mock Token", "MTK");

        const MockRewardManager = await ethers.getContractFactory("MockRewardManager");
        const rewardManager = await MockRewardManager.deploy();

        const MockAccessControlManager = await ethers.getContractFactory("MockAccessControlManager");
        const accessControlManager = await MockAccessControlManager.deploy();

        const MockVaultStorage = await ethers.getContractFactory("MockVaultStorage");
        const vaultStorage = await MockVaultStorage.deploy();

        const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
        const priceOracle = await MockPriceOracle.deploy();

        // 部署LiquidationDebtManager
        const LiquidationDebtManager = await ethers.getContractFactory("LiquidationDebtManager");
        const liquidationDebtManager = await LiquidationDebtManager.deploy();

        // 初始化合约
        await liquidationDebtManager.initialize(
            await accessControlManager.getAddress(),
            await vaultStorage.getAddress(),
            await priceOracle.getAddress(),
            await mockToken.getAddress()
        );

        // 设置权限
        await accessControlManager.grantRole(ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATE")), await owner.getAddress());

        return {
            liquidationDebtManager,
            rewardManager,
            mockToken,
            owner,
            liquidator,
            user,
            feeReceiver
        };
    }

    beforeEach(async function () {
        const fixture = await loadFixture(deployFixture);
        liquidationDebtManager = fixture.liquidationDebtManager;
        rewardManager = fixture.rewardManager;
        mockToken = fixture.mockToken;
        owner = fixture.owner;
        liquidator = fixture.liquidator;
        user = fixture.user;
        feeReceiver = fixture.feeReceiver;
    });

    describe("清算积分奖励功能", function () {
        it("应该正确计算清算人奖励积分", async function () {
            const debtValue = ethers.parseEther("100"); // 100 USDC
            const expectedReward = debtValue * 500n / 10000n; // 5% = 5 USDC

            const rewardPoints = await liquidationDebtManager.calculateLiquidationReward(debtValue);
            expect(rewardPoints).to.equal(expectedReward);
        });

        it("应该正确计算清算惩罚积分", async function () {
            const debtValue = ethers.parseEther("100"); // 100 USDC
            const expectedPenalty = debtValue * 100n / 10000n; // 1% = 1 USDC

            const penaltyPoints = await liquidationDebtManager.calculateLiquidationPenalty(debtValue);
            expect(penaltyPoints).to.equal(expectedPenalty);
        });

        it("应该为零债务值返回零积分", async function () {
            const rewardPoints = await liquidationDebtManager.calculateLiquidationReward(0);
            const penaltyPoints = await liquidationDebtManager.calculateLiquidationPenalty(0);

            expect(rewardPoints).to.equal(0);
            expect(penaltyPoints).to.equal(0);
        });
    });

    describe("清算统计功能", function () {
        it("应该正确获取初始清算统计", async function () {
            const stats = await liquidationDebtManager.getLiquidationStats();
            
            expect(stats.totalLiquidations).to.equal(0);
            expect(stats.totalRewardPoints).to.equal(0);
            expect(stats.totalPenaltyPoints).to.equal(0);
        });

        it("应该正确获取清算人统计", async function () {
            const liquidatorAddress = await liquidator.getAddress();
            const stats = await liquidationDebtManager.getLiquidatorStats(liquidatorAddress);
            
            expect(stats.totalLiquidations).to.equal(0);
            expect(stats.totalRewardPoints).to.equal(0);
        });

        it("应该正确获取被清算用户统计", async function () {
            const userAddress = await user.getAddress();
            const stats = await liquidationDebtManager.getUserLiquidationStats(userAddress);
            
            expect(stats.totalLiquidations).to.equal(0);
            expect(stats.totalPenaltyPoints).to.equal(0);
        });
    });

    describe("管理功能", function () {
        it("应该允许管理员更新清算奖励比例", async function () {
            const newRate = 1000; // 10%
            await liquidationDebtManager.connect(owner).updateLiquidationRewardRate(newRate);
            
            const updatedRate = await liquidationDebtManager.liquidationRewardRate();
            expect(updatedRate).to.equal(newRate);
        });

        it("应该允许管理员更新清算惩罚比例", async function () {
            const newRate = 200; // 2%
            await liquidationDebtManager.connect(owner).updateLiquidationPenaltyRate(newRate);
            
            const updatedRate = await liquidationDebtManager.liquidationPenaltyRate();
            expect(updatedRate).to.equal(newRate);
        });

        it("应该拒绝非管理员更新比例", async function () {
            const newRate = 1000;
            
            await expect(
                liquidationDebtManager.connect(liquidator).updateLiquidationRewardRate(newRate)
            ).to.be.revertedWithCustomError(liquidationDebtManager, "MissingRole");

            await expect(
                liquidationDebtManager.connect(liquidator).updateLiquidationPenaltyRate(newRate)
            ).to.be.revertedWithCustomError(liquidationDebtManager, "MissingRole");
        });
    });

    describe("批量处理功能", function () {
        it("应该正确处理批量清算积分", async function () {
            const users = [await user.getAddress()];
            const debtValues = [ethers.parseEther("100")];

            const result = await liquidationDebtManager.connect(owner).batchProcessLiquidationPoints(
                await liquidator.getAddress(),
                users,
                debtValues
            );

            expect(result.totalRewardPoints).to.be.gt(0);
            expect(result.totalPenaltyPoints).to.be.gt(0);
        });

        it("应该拒绝无效的批量大小", async function () {
            const users = new Array(51).fill(await user.getAddress());
            const debtValues = new Array(51).fill(ethers.parseEther("100"));

            await expect(
                liquidationDebtManager.connect(owner).batchProcessLiquidationPoints(
                    await liquidator.getAddress(),
                    users,
                    debtValues
                )
            ).to.be.revertedWith("Invalid batch size");
        });

        it("应该拒绝长度不匹配的数组", async function () {
            const users = [await user.getAddress()];
            const debtValues = [ethers.parseEther("100"), ethers.parseEther("200")];

            await expect(
                liquidationDebtManager.connect(owner).batchProcessLiquidationPoints(
                    await liquidator.getAddress(),
                    users,
                    debtValues
                )
            ).to.be.revertedWith("Length mismatch");
        });
    });

    describe("权限控制", function () {
        it("应该拒绝非授权用户调用清算积分功能", async function () {
            const debtValue = ethers.parseEther("100");

            await expect(
                liquidationDebtManager.connect(liquidator).issueLiquidationReward(
                    await liquidator.getAddress(),
                    await user.getAddress(),
                    debtValue
                )
            ).to.be.revertedWithCustomError(liquidationDebtManager, "MissingRole");

            await expect(
                liquidationDebtManager.connect(liquidator).batchProcessLiquidationPoints(
                    await liquidator.getAddress(),
                    [await user.getAddress()],
                    [debtValue]
                )
            ).to.be.revertedWithCustomError(liquidationDebtManager, "MissingRole");
        });
    });
}); 
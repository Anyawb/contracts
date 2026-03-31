import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

/**
 * Funds-Flow (SSOT) – Repay authority path
 *
 * Doc reference:
 * - docs/Usage-Guide/Funds-Flow-Architecture-Guide.md §4 (Repay → Settle)
 *
 * Assertions (chain facts):
 * - VaultCore.repay transfers funds to SettlementManager
 * - SettlementManager calls OrderEngine.repay and emits RepayAndSettleProcessed
 * - When debt clears, collateral is released via CollateralManager
 * - DataPushed(REPAY_AND_SETTLE) and DataPushed(COLLATERAL_RELEASED)
 * - Only VaultCore can call SettlementManager.repayAndSettle
 */

describe("Funds-Flow – Repay authority path", function () {
  const KEY_VAULT_CORE = ethers.id("VAULT_CORE");
  const KEY_SETTLEMENT_MANAGER = ethers.id("SETTLEMENT_MANAGER");
  const KEY_LE = ethers.id("LENDING_ENGINE");
  const KEY_CM = ethers.id("COLLATERAL_MANAGER");
  const KEY_ORDER_ENGINE = ethers.id("ORDER_ENGINE");

  const DATA_TYPE_REPAY_AND_SETTLE = ethers.keccak256(ethers.toUtf8Bytes("REPAY_AND_SETTLE"));
  const DATA_TYPE_COLLATERAL_RELEASED = ethers.keccak256(ethers.toUtf8Bytes("COLLATERAL_RELEASED"));

  const DATA_PUSH_IFACE = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
  const DATA_PUSH_TOPIC0 = ethers.id("DataPushed(bytes32,bytes)").toLowerCase();

  function getDataPushTypes(receipt: any): string[] {
    return receipt.logs
      .filter((log: any) => (log.topics?.[0] || "").toLowerCase() === DATA_PUSH_TOPIC0)
      .map((log: any) => DATA_PUSH_IFACE.parseLog(log).args.dataTypeHash.toLowerCase());
  }

  async function deployFixture() {
    const [owner, borrower] = await ethers.getSigners();

    const RegistryF = await ethers.getContractFactory("MockRegistry");
    const registry = await RegistryF.deploy();

    const CMF = await ethers.getContractFactory("MockCollateralManager");
    const cm = await CMF.deploy();

    const LEF = await ethers.getContractFactory("MockLendingEngineBasic");
    const le = await LEF.deploy();

    const OrderEngineF = await ethers.getContractFactory("MockOrderEngineForSettlementManager");
    const orderEngine = await OrderEngineF.deploy();
    await orderEngine.setLendingEngine(le.target);

    const VaultRouterF = await ethers.getContractFactory("MockVaultRouter");
    const vaultRouter = await VaultRouterF.deploy();

    const VaultCoreF = await ethers.getContractFactory("VaultCore");
    const vaultCore = await upgrades.deployProxy(
      VaultCoreF,
      [registry.target, await vaultRouter.getAddress()],
      { kind: "uups", initializer: "initialize" }
    );

    const SettlementManagerF = await ethers.getContractFactory("SettlementManager");
    const settlementManager = await upgrades.deployProxy(
      SettlementManagerF,
      [registry.target],
      { kind: "uups", initializer: "initialize" }
    );

    const TokenF = await ethers.getContractFactory("MockERC20");
    const debtToken = await TokenF.deploy("Mock USDC", "USDC", 18, ethers.parseUnits("1000000", 18));
    const collateralToken = await TokenF.deploy("Mock ETH", "mETH", 18, ethers.parseUnits("1000000", 18));

    await registry.setModule(KEY_VAULT_CORE, vaultCore.target);
    await registry.setModule(KEY_SETTLEMENT_MANAGER, settlementManager.target);
    await registry.setModule(KEY_LE, le.target);
    await registry.setModule(KEY_CM, cm.target);
    await registry.setModule(KEY_ORDER_ENGINE, orderEngine.target);

    return {
      owner,
      borrower,
      registry,
      cm,
      le,
      orderEngine,
      vaultCore,
      settlementManager,
      debtToken,
      collateralToken,
    };
  }

  it("routes VaultCore.repay -> SettlementManager, releases collateral when debt clears", async function () {
    const {
      borrower,
      cm,
      le,
      orderEngine,
      vaultCore,
      settlementManager,
      debtToken,
      collateralToken,
    } = await loadFixture(deployFixture);

    const debtAsset = debtToken.target;
    const collateralAsset = collateralToken.target;
    const principal = ethers.parseUnits("1000", 18);
    const collateralAmount = ethers.parseUnits("500", 18);

    await orderEngine.setOrder(0, {
      principal,
      rate: 0n,
      term: 1n,
      borrower: borrower.address,
      lender: ethers.Wallet.createRandom().address,
      asset: debtAsset,
      startTimestamp: 1n,
      maturity: 100n,
      repaidAmount: 0n,
    });

    await le.setUserDebt(borrower.address, debtAsset, principal);
    await cm.setUserCollateral(borrower.address, collateralAsset, collateralAmount);

    await collateralToken.mint(cm.target, collateralAmount);

    await debtToken.transfer(borrower.address, principal);
    await debtToken.connect(borrower).approve(vaultCore.target, principal);

    const borrowerCollateralBefore = await collateralToken.balanceOf(borrower.address);

    const tx = await vaultCore.connect(borrower).repay(0, debtAsset, principal);
    const receipt = await tx.wait();

    await expect(tx)
      .to.emit(settlementManager, "RepayAndSettleProcessed")
      .withArgs(borrower.address, debtAsset, principal, 0, true, anyValue);

    const dataTypes = getDataPushTypes(receipt);
    expect(dataTypes).to.include(DATA_TYPE_REPAY_AND_SETTLE.toLowerCase());
    expect(dataTypes).to.include(DATA_TYPE_COLLATERAL_RELEASED.toLowerCase());

    expect(await le.getUserTotalDebtValue(borrower.address)).to.equal(0n);
    expect(await cm.getCollateral(borrower.address, collateralAsset)).to.equal(0n);

    const borrowerCollateralAfter = await collateralToken.balanceOf(borrower.address);
    expect(borrowerCollateralAfter - borrowerCollateralBefore).to.equal(collateralAmount);
  });

  it("rejects direct call to SettlementManager.repayAndSettle (onlyVaultCore)", async function () {
    const { borrower, settlementManager, debtToken } = await loadFixture(deployFixture);

    await expect(
      settlementManager.connect(borrower).repayAndSettle(borrower.address, debtToken.target, 1, 0)
    ).to.be.revertedWithCustomError(settlementManager, "SettlementManager__OnlyVaultCore");
  });
});

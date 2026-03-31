import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

/**
 * Funds-Flow (SSOT) – Match authority path
 *
 * Doc reference:
 * - docs/Usage-Guide/Funds-Flow-Architecture-Guide.md §2.1, §2.2, §3.1
 *
 * Assertions (chain facts):
 * - reserveForLending pulls funds into LenderPoolVault and emits DataPushed(RESERVE_FOR_LENDING)
 * - finalizeMatch consumes reserve, writes debt via VaultCore->LE, creates OrderEngine order
 * - finalizeMatch routes borrow fee through FeeRouter and emits FeeDistributed + DataPushed(FEE_DISTRIBUTED)
 * - lender in order = LenderPoolVault (pool-based SSOT)
 */

describe("Funds-Flow – Match authority path", function () {
  const KEY_ACCESS_CONTROL = ethers.id("ACCESS_CONTROL_MANAGER");
  const KEY_ASSET_WHITELIST = ethers.id("ASSET_WHITELIST");
  const KEY_LE = ethers.id("LENDING_ENGINE");
  const KEY_ORDER_ENGINE = ethers.id("ORDER_ENGINE");
  const KEY_VAULT_CORE = ethers.id("VAULT_CORE");
  const KEY_LENDER_POOL_VAULT = ethers.id("LENDER_POOL_VAULT");
  const KEY_VAULT_BUSINESS_LOGIC = ethers.id("VAULT_BUSINESS_LOGIC");
  const KEY_FR = ethers.id("FEE_ROUTER");
  const KEY_CM = ethers.id("COLLATERAL_MANAGER");

  const ACTION_ORDER_CREATE = ethers.keccak256(ethers.toUtf8Bytes("ORDER_CREATE"));
  const ACTION_DEPOSIT = ethers.keccak256(ethers.toUtf8Bytes("DEPOSIT"));
  const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes("SET_PARAMETER"));

  const DATA_TYPE_RESERVE_FOR_LENDING = ethers.keccak256(ethers.toUtf8Bytes("RESERVE_FOR_LENDING"));
  const DATA_TYPE_RESERVE_CONSUMED = ethers.keccak256(ethers.toUtf8Bytes("RESERVE_CONSUMED"));
  const DATA_TYPE_FEE_DISTRIBUTED = ethers.keccak256(ethers.toUtf8Bytes("FEE_DISTRIBUTED"));

  const BORROW_INTENT_TYPES = {
    BorrowIntent: [
      { name: "borrower", type: "address" },
      { name: "collateralAsset", type: "address" },
      { name: "collateralAmount", type: "uint256" },
      { name: "borrowAsset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "termDays", type: "uint16" },
      { name: "rateBps", type: "uint256" },
      { name: "expireAt", type: "uint256" },
      { name: "salt", type: "bytes32" },
    ],
  } as const;

  const LEND_INTENT_TYPES = {
    LendIntent: [
      { name: "lenderSigner", type: "address" },
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "minTermDays", type: "uint16" },
      { name: "maxTermDays", type: "uint16" },
      { name: "minRateBps", type: "uint256" },
      { name: "expireAt", type: "uint256" },
      { name: "salt", type: "bytes32" },
    ],
  } as const;

  const DATA_PUSH_IFACE = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
  const DATA_PUSH_TOPIC0 = ethers.id("DataPushed(bytes32,bytes)").toLowerCase();

  function getDataPushTypes(receipt: any): string[] {
    return receipt.logs
      .filter((log: any) => (log.topics?.[0] || "").toLowerCase() === DATA_PUSH_TOPIC0)
      .map((log: any) => DATA_PUSH_IFACE.parseLog(log).args.dataTypeHash.toLowerCase());
  }

  async function buildMatchData(params: {
    vbl: any;
    borrower: any;
    lender: any;
    token: any;
    principal: bigint;
    rateBps: bigint;
    termDays: number;
  }) {
    const { vbl, borrower, lender, token, principal, rateBps, termDays } = params;
    const network = await ethers.provider.getNetwork();
    const domain = {
      name: "RwaLending",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await vbl.getAddress(),
    };

    const currentBlock = await ethers.provider.getBlockNumber();
    const expireAt = BigInt(currentBlock + 10_000);

    const borrowIntent = {
      borrower: borrower.address,
      collateralAsset: ethers.ZeroAddress,
      collateralAmount: 0n,
      borrowAsset: await token.getAddress(),
      amount: principal,
      termDays,
      rateBps,
      expireAt,
      salt: ethers.keccak256(ethers.toUtf8Bytes(`borrow-${borrower.address}-${principal}-${Date.now()}`)),
    };

    const lendIntent = {
      lenderSigner: lender.address,
      asset: await token.getAddress(),
      amount: principal,
      minTermDays: termDays,
      maxTermDays: termDays,
      minRateBps: rateBps,
      expireAt,
      salt: ethers.keccak256(ethers.toUtf8Bytes(`lend-${lender.address}-${principal}-${Date.now()}`)),
    };

    const lendIntentHash = ethers.TypedDataEncoder.hashStruct("LendIntent", LEND_INTENT_TYPES, lendIntent);

    const sigBorrower = await borrower.signTypedData(domain, BORROW_INTENT_TYPES, borrowIntent);
    const sigLender = await lender.signTypedData(domain, LEND_INTENT_TYPES, lendIntent);

    return { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender };
  }

  async function deployFixture() {
    const [owner, lender, borrower] = await ethers.getSigners();

    const RegistryF = await ethers.getContractFactory("MockRegistry");
    const registry = await RegistryF.deploy();

    const ACMF = await ethers.getContractFactory("MockAccessControlManager");
    const acm = await ACMF.deploy();

    const AssetWhitelistF = await ethers.getContractFactory("MockAssetWhitelist");
    const assetWhitelist = await AssetWhitelistF.deploy();

    const CMF = await ethers.getContractFactory("MockCollateralManager");
    const cm = await CMF.deploy();

    const TokenF = await ethers.getContractFactory("MockERC20");
    const token = await TokenF.deploy("Mock USDC", "USDC", 18, ethers.parseUnits("1000000", 18));

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

    const LenderPoolVaultF = await ethers.getContractFactory("LenderPoolVault");
    const lenderPoolVault = await upgrades.deployProxy(
      LenderPoolVaultF,
      [registry.target],
      { kind: "uups", initializer: "initialize" }
    );

    const FeeRouterF = await ethers.getContractFactory("FeeRouter");
    const feeRouter = await upgrades.deployProxy(
      FeeRouterF,
      [registry.target, owner.address, owner.address, 300, 0],
      { kind: "uups", initializer: "initialize" }
    );

    const VBLF = await ethers.getContractFactory("VaultBusinessLogic");
    const vbl = await upgrades.deployProxy(
      VBLF,
      [registry.target, token.target],
      { kind: "uups", initializer: "initialize" }
    );

    await registry.setModule(KEY_ACCESS_CONTROL, acm.target);
    await registry.setModule(KEY_ASSET_WHITELIST, assetWhitelist.target);
    await registry.setModule(KEY_LE, le.target);
    await registry.setModule(KEY_ORDER_ENGINE, orderEngine.target);
    await registry.setModule(KEY_VAULT_CORE, vaultCore.target);
    await registry.setModule(KEY_LENDER_POOL_VAULT, lenderPoolVault.target);
    await registry.setModule(KEY_VAULT_BUSINESS_LOGIC, vbl.target);
    await registry.setModule(KEY_FR, feeRouter.target);
    await registry.setModule(KEY_CM, cm.target);

    await acm.grantRole(ACTION_SET_PARAMETER, owner.address);
    await acm.grantRole(ACTION_ORDER_CREATE, vbl.target);
    await acm.grantRole(ACTION_DEPOSIT, vbl.target);

    await feeRouter.connect(owner).addSupportedToken(token.target);
    await assetWhitelist.setAssetAllowed(token.target, true);

    await token.transfer(lender.address, ethers.parseUnits("10000", 18));
    await token.transfer(borrower.address, ethers.parseUnits("100", 18));

    await token.connect(lender).approve(vbl.target, ethers.parseUnits("100000", 18));

    return {
      owner,
      lender,
      borrower,
      registry,
      acm,
      assetWhitelist,
      token,
      le,
      orderEngine,
      vaultCore,
      lenderPoolVault,
      feeRouter,
      vbl,
    };
  }

  it("reserveForLending transfers funds and emits DataPushed", async function () {
    const { lender, token, lenderPoolVault, vbl } = await loadFixture(deployFixture);

    const amount = ethers.parseUnits("1000", 18);
    const lendIntentHash = ethers.keccak256(ethers.toUtf8Bytes("lend-intent-ssot"));

    const lenderBalBefore = await token.balanceOf(lender.address);
    const poolBalBefore = await token.balanceOf(lenderPoolVault.target);

    const tx = await vbl.connect(lender).reserveForLending(lender.address, token.target, amount, lendIntentHash);
    const receipt = await tx.wait();

    const lenderBalAfter = await token.balanceOf(lender.address);
    const poolBalAfter = await token.balanceOf(lenderPoolVault.target);

    expect(lenderBalAfter).to.equal(lenderBalBefore - amount);
    expect(poolBalAfter).to.equal(poolBalBefore + amount);

    const dataTypes = getDataPushTypes(receipt);
    expect(dataTypes).to.include(DATA_TYPE_RESERVE_FOR_LENDING.toLowerCase());
  });

  it("finalizeMatch consumes reserve, creates order, and routes fees", async function () {
    const { owner, lender, borrower, token, le, orderEngine, lenderPoolVault, feeRouter, vbl } =
      await loadFixture(deployFixture);

    const principal = ethers.parseUnits("1000", 18);
    const rateBps = 1000n;
    const termDays = 30;

    const { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender } = await buildMatchData({
      vbl,
      borrower,
      lender,
      token,
      principal,
      rateBps,
      termDays,
    });

    await vbl.connect(lender).reserveForLending(lender.address, token.target, principal, lendIntentHash);

    const borrowerBalBefore = await token.balanceOf(borrower.address);
    const poolBalBefore = await token.balanceOf(lenderPoolVault.target);
    const ownerBalBefore = await token.balanceOf(owner.address);

    const tx = await vbl.connect(borrower).finalizeMatch(borrowIntent, [lendIntent], sigBorrower, [sigLender]);
    const receipt = await tx.wait();

    const feeBps = 300n;
    const expectedFee = (principal * feeBps) / 10_000n;
    const expectedNet = principal - expectedFee;

    const borrowerBalAfter = await token.balanceOf(borrower.address);
    const poolBalAfter = await token.balanceOf(lenderPoolVault.target);
    const ownerBalAfter = await token.balanceOf(owner.address);

    expect(borrowerBalAfter - borrowerBalBefore).to.equal(expectedNet);
    expect(poolBalAfter).to.equal(poolBalBefore - principal);
    expect(ownerBalAfter - ownerBalBefore).to.equal(expectedFee);

    // Order created and lender set to pool (SSOT)
    await expect(tx)
      .to.emit(orderEngine, "MockOrderCreated")
      .withArgs(0, borrower.address, lenderPoolVault.target, token.target, principal, anyValue);

    const order = await orderEngine.getLoanOrderForView(0);
    expect(order.borrower).to.equal(borrower.address);
    expect(order.lender).to.equal(lenderPoolVault.target);
    expect(order.asset).to.equal(token.target);
    expect(order.principal).to.equal(principal);

    expect(await le.getDebt(borrower.address, token.target)).to.equal(principal);

    await expect(tx).to.emit(feeRouter, "FeeDistributed").withArgs(token.target, expectedFee, 0);

    const dataTypes = getDataPushTypes(receipt);
    expect(dataTypes).to.include(DATA_TYPE_RESERVE_CONSUMED.toLowerCase());
    expect(dataTypes).to.include(DATA_TYPE_FEE_DISTRIBUTED.toLowerCase());
  });

  it("finalizeMatch reverts when ACTION_ORDER_CREATE is missing", async function () {
    const { acm, lender, borrower, token, vbl } = await loadFixture(deployFixture);

    const principal = ethers.parseUnits("100", 18);
    const rateBps = 1000n;
    const termDays = 30;

    const { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender } = await buildMatchData({
      vbl,
      borrower,
      lender,
      token,
      principal,
      rateBps,
      termDays,
    });

    await vbl.connect(lender).reserveForLending(lender.address, token.target, principal, lendIntentHash);
    await acm.revokeRole(ACTION_ORDER_CREATE, vbl.target);

    await expect(
      vbl.connect(borrower).finalizeMatch(borrowIntent, [lendIntent], sigBorrower, [sigLender])
    ).to.be.revertedWithCustomError(acm, "MissingRole");
  });

  it("finalizeMatch reverts when asset is not whitelisted", async function () {
    const { assetWhitelist, lender, borrower, token, vbl } = await loadFixture(deployFixture);

    const principal = ethers.parseUnits("100", 18);
    const rateBps = 1000n;
    const termDays = 30;

    const { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender } = await buildMatchData({
      vbl,
      borrower,
      lender,
      token,
      principal,
      rateBps,
      termDays,
    });

    await vbl.connect(lender).reserveForLending(lender.address, token.target, principal, lendIntentHash);
    await assetWhitelist.setAssetAllowed(token.target, false);

    await expect(
      vbl.connect(borrower).finalizeMatch(borrowIntent, [lendIntent], sigBorrower, [sigLender])
    ).to.be.revertedWithCustomError(vbl, "SettlementMatchLib__AssetNotAllowed");
  });
});

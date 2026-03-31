import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("Funds-Flow – Blocks-only authority path", function () {
  const KEY_ACCESS_CONTROL = ethers.id("ACCESS_CONTROL_MANAGER");
  const KEY_ASSET_WHITELIST = ethers.id("ASSET_WHITELIST");
  const KEY_LE = ethers.id("LENDING_ENGINE");
  const KEY_VAULT_CORE = ethers.id("VAULT_CORE");
  const KEY_LENDER_POOL_VAULT = ethers.id("LENDER_POOL_VAULT");
  const KEY_VAULT_BUSINESS_LOGIC = ethers.id("VAULT_BUSINESS_LOGIC");
  const KEY_BLOCKS_ONLY_COORDINATOR = ethers.id("BLOCKS_ONLY_COORDINATOR");
  const KEY_CM = ethers.id("COLLATERAL_MANAGER");
  const KEY_LIQUIDATION_MANAGER = ethers.id("LIQUIDATION_MANAGER");
  const KEY_LIQUIDATION_PAYOUT_MANAGER = ethers.id(
    "LIQUIDATION_PAYOUT_MANAGER",
  );

  const ACTION_LIQUIDATE = ethers.keccak256(ethers.toUtf8Bytes("LIQUIDATE"));

  const BORROW_INTENT_TYPES = {
    BorrowIntentBlocks: [
      { name: "borrower", type: "address" },
      { name: "collateralAsset", type: "address" },
      { name: "collateralAmount", type: "uint256" },
      { name: "borrowAsset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "termBlocks", type: "uint256" },
      { name: "rateBps", type: "uint256" },
      { name: "expireAt", type: "uint256" },
      { name: "salt", type: "bytes32" },
    ],
  } as const;

  const LEND_INTENT_TYPES = {
    LendIntentBlocks: [
      { name: "lenderSigner", type: "address" },
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "minTermBlocks", type: "uint256" },
      { name: "maxTermBlocks", type: "uint256" },
      { name: "minRateBps", type: "uint256" },
      { name: "expireAt", type: "uint256" },
      { name: "salt", type: "bytes32" },
    ],
  } as const;

  const DATA_TYPE_RESERVE_CONSUMED = ethers.keccak256(
    ethers.toUtf8Bytes("RESERVE_CONSUMED"),
  );
  const DATA_TYPE_BLOCKS_ONLY_MATCH_FINALIZED = ethers.keccak256(
    ethers.toUtf8Bytes("BLOCKS_ONLY_MATCH_FINALIZED"),
  );
  const DATA_TYPE_BLOCKS_ONLY_REPAID = ethers.keccak256(
    ethers.toUtf8Bytes("BLOCKS_ONLY_REPAID"),
  );
  const DATA_TYPE_BLOCKS_ONLY_SETTLED = ethers.keccak256(
    ethers.toUtf8Bytes("BLOCKS_ONLY_SETTLED"),
  );
  const DATA_TYPE_BLOCKS_ONLY_LIQUIDATED = ethers.keccak256(
    ethers.toUtf8Bytes("BLOCKS_ONLY_LIQUIDATED"),
  );
  const DATA_PUSH_IFACE = new ethers.Interface([
    "event DataPushed(bytes32 indexed dataTypeHash, bytes payload)",
  ]);
  const DATA_PUSH_TOPIC0 = ethers.id("DataPushed(bytes32,bytes)").toLowerCase();

  function getDataPushTypes(receipt: any): string[] {
    return receipt.logs
      .filter(
        (log: any) =>
          (log.topics?.[0] || "").toLowerCase() === DATA_PUSH_TOPIC0,
      )
      .map((log: any) =>
        DATA_PUSH_IFACE.parseLog(log).args.dataTypeHash.toLowerCase(),
      );
  }

  async function buildBlocksMatchData(params: {
    vbl: any;
    borrower: any;
    lender: any;
    token: any;
    principal: bigint;
    termBlocks: bigint;
    rateBps: bigint;
    collateralAsset?: string;
    collateralAmount?: bigint;
  }) {
    const {
      vbl,
      borrower,
      lender,
      token,
      principal,
      termBlocks,
      rateBps,
      collateralAsset,
      collateralAmount,
    } = params;
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
      collateralAsset: collateralAsset ?? ethers.ZeroAddress,
      collateralAmount: collateralAmount ?? 0n,
      borrowAsset: await token.getAddress(),
      amount: principal,
      termBlocks,
      rateBps,
      expireAt,
      salt: ethers.keccak256(
        ethers.toUtf8Bytes(`borrow-blocks-${borrower.address}-${principal}`),
      ),
    };

    const lendIntent = {
      lenderSigner: lender.address,
      asset: await token.getAddress(),
      amount: principal,
      minTermBlocks: termBlocks,
      maxTermBlocks: termBlocks,
      minRateBps: 0n,
      expireAt,
      salt: ethers.keccak256(
        ethers.toUtf8Bytes(`lend-blocks-${lender.address}-${principal}`),
      ),
    };

    const lendIntentHash = ethers.TypedDataEncoder.hashStruct(
      "LendIntentBlocks",
      LEND_INTENT_TYPES,
      lendIntent,
    );

    const sigBorrower = await borrower.signTypedData(
      domain,
      BORROW_INTENT_TYPES,
      borrowIntent,
    );
    const sigLender = await lender.signTypedData(
      domain,
      LEND_INTENT_TYPES,
      lendIntent,
    );

    return { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender };
  }

  async function deployFixture() {
    const [owner, lender, borrower] = await ethers.getSigners();

    const RegistryF = await ethers.getContractFactory("MockRegistry");
    const registry = await RegistryF.deploy();

    const ACMF = await ethers.getContractFactory("MockAccessControlManager");
    const acm = await ACMF.deploy();

    const AssetWhitelistF =
      await ethers.getContractFactory("MockAssetWhitelist");
    const assetWhitelist = await AssetWhitelistF.deploy();

    const CMF = await ethers.getContractFactory("MockCollateralManager");
    const cm = await CMF.deploy();

    const TokenF = await ethers.getContractFactory("MockERC20");
    const token = await TokenF.deploy(
      "Mock USDC",
      "USDC",
      18,
      ethers.parseUnits("1000000", 18),
    );
    const collateralToken = await TokenF.deploy(
      "Mock WETH",
      "WETH",
      18,
      ethers.parseUnits("1000000", 18),
    );

    const LEF = await ethers.getContractFactory("MockLendingEngineBasic");
    const le = await LEF.deploy();

    const VaultRouterF = await ethers.getContractFactory("MockVaultRouter");
    const vaultRouter = await VaultRouterF.deploy();

    const VaultCoreF = await ethers.getContractFactory("VaultCore");
    const vaultCore = await upgrades.deployProxy(
      VaultCoreF,
      [registry.target, await vaultRouter.getAddress()],
      { kind: "uups", initializer: "initialize" },
    );

    const LenderPoolVaultF = await ethers.getContractFactory("LenderPoolVault");
    const lenderPoolVault = await upgrades.deployProxy(
      LenderPoolVaultF,
      [registry.target],
      { kind: "uups", initializer: "initialize" },
    );

    const VBLF = await ethers.getContractFactory("VaultBusinessLogic");
    const vbl = await upgrades.deployProxy(
      VBLF,
      [registry.target, token.target],
      { kind: "uups", initializer: "initialize" },
    );

    const BlocksOnlyCoordinatorF = await ethers.getContractFactory(
      "BlocksOnlyCoordinator",
    );
    const coordinator = await upgrades.deployProxy(
      BlocksOnlyCoordinatorF,
      [registry.target],
      { kind: "uups", initializer: "initialize" },
    );

    const LiquidationManagerF =
      await ethers.getContractFactory("LiquidationManager");
    const liquidationManager = await upgrades.deployProxy(
      LiquidationManagerF,
      [registry.target],
      { kind: "uups", initializer: "initialize" },
    );

    const LiquidationPayoutManagerF = await ethers.getContractFactory(
      "LiquidationPayoutManager",
    );
    const liquidationPayoutManager = await upgrades.deployProxy(
      LiquidationPayoutManagerF,
      [
        registry.target,
        acm.target,
        {
          platform: owner.address,
          reserve: owner.address,
          lenderCompensation: lenderPoolVault.target,
        },
        {
          platformBps: 0,
          reserveBps: 0,
          lenderBps: 10000,
          liquidatorBps: 0,
        },
      ],
      { kind: "uups", initializer: "initialize" },
    );

    await registry.setModule(KEY_ACCESS_CONTROL, acm.target);
    await registry.setModule(KEY_ASSET_WHITELIST, assetWhitelist.target);
    await registry.setModule(KEY_LE, le.target);
    await registry.setModule(KEY_VAULT_CORE, vaultCore.target);
    await registry.setModule(KEY_LENDER_POOL_VAULT, lenderPoolVault.target);
    await registry.setModule(KEY_VAULT_BUSINESS_LOGIC, vbl.target);
    await registry.setModule(KEY_BLOCKS_ONLY_COORDINATOR, coordinator.target);
    await registry.setModule(KEY_CM, cm.target);
    await registry.setModule(
      KEY_LIQUIDATION_MANAGER,
      liquidationManager.target,
    );
    await registry.setModule(
      KEY_LIQUIDATION_PAYOUT_MANAGER,
      liquidationPayoutManager.target,
    );

    await assetWhitelist.setAssetAllowed(token.target, true);
    await assetWhitelist.setAssetAllowed(collateralToken.target, true);

    await acm.grantRole(ACTION_LIQUIDATE, owner.address);
    await acm.grantRole(ACTION_LIQUIDATE, coordinator.target);
    await acm.grantRole(ACTION_LIQUIDATE, liquidationManager.target);

    await token.transfer(lender.address, ethers.parseUnits("10000", 18));
    await token.transfer(borrower.address, ethers.parseUnits("100", 18));
    await collateralToken.transfer(
      owner.address,
      ethers.parseUnits("1000", 18),
    );
    await token
      .connect(lender)
      .approve(vbl.target, ethers.parseUnits("100000", 18));

    return {
      owner,
      lender,
      borrower,
      registry,
      acm,
      assetWhitelist,
      token,
      collateralToken,
      le,
      vaultCore,
      lenderPoolVault,
      vbl,
      coordinator,
      cm,
      liquidationManager,
    };
  }

  it("finalizeMatchBlocks consumes reserve, writes debt, and creates a blocks-only order", async function () {
    const { lender, borrower, token, le, lenderPoolVault, vbl, coordinator } =
      await loadFixture(deployFixture);

    const principal = ethers.parseUnits("1000", 18);
    const termBlocks = 1n;
    const rateBps = 0n;

    const { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender } =
      await buildBlocksMatchData({
        vbl,
        borrower,
        lender,
        token,
        principal,
        termBlocks,
        rateBps,
      });

    await vbl
      .connect(lender)
      .reserveForLending(
        lender.address,
        token.target,
        principal,
        lendIntentHash,
      );

    const borrowerBalBefore = await token.balanceOf(borrower.address);
    const poolBalBefore = await token.balanceOf(lenderPoolVault.target);

    const tx = await vbl
      .connect(borrower)
      .finalizeMatchBlocks(borrowIntent, [lendIntent], sigBorrower, [
        sigLender,
      ]);
    const receipt = await tx.wait();

    const borrowerBalAfter = await token.balanceOf(borrower.address);
    const poolBalAfter = await token.balanceOf(lenderPoolVault.target);

    expect(borrowerBalAfter - borrowerBalBefore).to.equal(principal);
    expect(poolBalAfter).to.equal(poolBalBefore - principal);
    expect(await le.getDebt(borrower.address, token.target)).to.equal(
      principal,
    );

    const order = await coordinator.getBlocksOnlyOrder(0);
    expect(order.borrower).to.equal(borrower.address);
    expect(order.lender).to.equal(lenderPoolVault.target);
    expect(order.asset).to.equal(token.target);
    expect(order.principal).to.equal(principal);
    expect(order.repaidPrincipal).to.equal(0);
    expect(order.termBlocks).to.equal(termBlocks);
    expect(order.rateBps).to.equal(0);
    expect(order.status).to.equal(1n);

    const dataTypes = getDataPushTypes(receipt);
    expect(dataTypes).to.include(DATA_TYPE_RESERVE_CONSUMED.toLowerCase());
    expect(dataTypes).to.include(
      DATA_TYPE_BLOCKS_ONLY_MATCH_FINALIZED.toLowerCase(),
    );
  });

  it("finalizeMatchBlocks reverts when termBlocks is not the first-version fixed value", async function () {
    const { lender, borrower, token, vbl, coordinator } =
      await loadFixture(deployFixture);

    const principal = ethers.parseUnits("100", 18);
    const termBlocks = 2n;
    const rateBps = 0n;

    const { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender } =
      await buildBlocksMatchData({
        vbl,
        borrower,
        lender,
        token,
        principal,
        termBlocks,
        rateBps,
      });

    await vbl
      .connect(lender)
      .reserveForLending(
        lender.address,
        token.target,
        principal,
        lendIntentHash,
      );

    await expect(
      vbl
        .connect(borrower)
        .finalizeMatchBlocks(borrowIntent, [lendIntent], sigBorrower, [
          sigLender,
        ]),
    ).to.be.revertedWithCustomError(
      coordinator,
      "BlocksOnlyCoordinator__InvalidTermBlocks",
    );
  });

  it("repayBlocks marks repaid and matured settle releases collateral", async function () {
    const {
      owner,
      lender,
      borrower,
      token,
      collateralToken,
      le,
      lenderPoolVault,
      vbl,
      coordinator,
      cm,
    } = await loadFixture(deployFixture);

    const principal = ethers.parseUnits("250", 18);
    const collateralAmount = ethers.parseUnits("5", 18);

    await collateralToken.transfer(cm.target, collateralAmount);
    await cm.setUserCollateral(
      borrower.address,
      collateralToken.target,
      collateralAmount,
    );

    const { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender } =
      await buildBlocksMatchData({
        vbl,
        borrower,
        lender,
        token,
        principal,
        termBlocks: 1n,
        rateBps: 0n,
        collateralAsset: await collateralToken.getAddress(),
        collateralAmount,
      });

    await vbl
      .connect(lender)
      .reserveForLending(
        lender.address,
        token.target,
        principal,
        lendIntentHash,
      );
    await vbl
      .connect(borrower)
      .finalizeMatchBlocks(borrowIntent, [lendIntent], sigBorrower, [
        sigLender,
      ]);

    await token.connect(borrower).approve(coordinator.target, principal);
    const poolBalBeforeRepay = await token.balanceOf(lenderPoolVault.target);

    const repayTx = await coordinator
      .connect(borrower)
      .repayBlocks(0, principal);
    const repayReceipt = await repayTx.wait();

    expect(await le.getDebt(borrower.address, token.target)).to.equal(0);
    expect(await token.balanceOf(lenderPoolVault.target)).to.equal(
      poolBalBeforeRepay + principal,
    );
    expect((await coordinator.getBlocksOnlyOrder(0)).status).to.equal(2n);
    expect(getDataPushTypes(repayReceipt)).to.include(
      DATA_TYPE_BLOCKS_ONLY_REPAID.toLowerCase(),
    );

    await ethers.provider.send("evm_mine", []);

    const borrowerCollateralBefore = await collateralToken.balanceOf(
      borrower.address,
    );
    const settleTx = await coordinator
      .connect(owner)
      .settleOrLiquidateBlocks(0);
    const settleReceipt = await settleTx.wait();

    expect(await collateralToken.balanceOf(borrower.address)).to.equal(
      borrowerCollateralBefore + collateralAmount,
    );
    expect(
      await cm.getCollateral(borrower.address, collateralToken.target),
    ).to.equal(0);

    const settledOrder = await coordinator.getBlocksOnlyOrder(0);
    expect(settledOrder.status).to.equal(3n);
    expect(settledOrder.closeBlock).to.be.gt(0);
    expect(getDataPushTypes(settleReceipt)).to.include(
      DATA_TYPE_BLOCKS_ONLY_SETTLED.toLowerCase(),
    );
  });

  it("termBlocks=1 reaches maturity on the next transaction without legacy confirmation offset", async function () {
    const {
      owner,
      lender,
      borrower,
      token,
      collateralToken,
      vbl,
      coordinator,
      cm,
    } = await loadFixture(deployFixture);

    const principal = ethers.parseUnits("125", 18);
    const collateralAmount = ethers.parseUnits("3", 18);

    await collateralToken.transfer(cm.target, collateralAmount);
    await cm.setUserCollateral(
      borrower.address,
      collateralToken.target,
      collateralAmount,
    );

    const { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender } =
      await buildBlocksMatchData({
        vbl,
        borrower,
        lender,
        token,
        principal,
        termBlocks: 1n,
        rateBps: 0n,
        collateralAsset: await collateralToken.getAddress(),
        collateralAmount,
      });

    await vbl
      .connect(lender)
      .reserveForLending(
        lender.address,
        token.target,
        principal,
        lendIntentHash,
      );
    await vbl
      .connect(borrower)
      .finalizeMatchBlocks(borrowIntent, [lendIntent], sigBorrower, [
        sigLender,
      ]);

    await token.connect(borrower).approve(coordinator.target, principal);
    const repayTx = await coordinator
      .connect(borrower)
      .repayBlocks(0, principal);
    await repayTx.wait();

    const settleTx = await coordinator
      .connect(owner)
      .settleOrLiquidateBlocks(0);
    await settleTx.wait();

    const settledOrder = await coordinator.getBlocksOnlyOrder(0);
    expect(settledOrder.status).to.equal(3n);
    expect(settledOrder.closeBlock).to.be.gt(0);
  });

  it("settleOrLiquidateBlocks requires ACTION_LIQUIDATE on the keeper caller", async function () {
    const { owner, lender, borrower, token, vbl, coordinator, acm } =
      await loadFixture(deployFixture);

    const principal = ethers.parseUnits("180", 18);
    const { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender } =
      await buildBlocksMatchData({
        vbl,
        borrower,
        lender,
        token,
        principal,
        termBlocks: 1n,
        rateBps: 0n,
      });

    await vbl
      .connect(lender)
      .reserveForLending(
        lender.address,
        token.target,
        principal,
        lendIntentHash,
      );
    await vbl
      .connect(borrower)
      .finalizeMatchBlocks(borrowIntent, [lendIntent], sigBorrower, [
        sigLender,
      ]);

    await ethers.provider.send("evm_mine", []);
    await acm.revokeRole(ACTION_LIQUIDATE, owner.address);

    await expect(
      coordinator.connect(owner).settleOrLiquidateBlocks(0),
    ).to.be.revertedWithCustomError(acm, "MissingRole");
  });

  it("maturity with outstanding debt routes to liquidation and marks final state", async function () {
    const {
      owner,
      lender,
      borrower,
      token,
      collateralToken,
      le,
      lenderPoolVault,
      vbl,
      coordinator,
      cm,
    } = await loadFixture(deployFixture);

    const principal = ethers.parseUnits("300", 18);
    const collateralAmount = ethers.parseUnits("7", 18);

    await collateralToken.transfer(cm.target, collateralAmount);
    await cm.setUserCollateral(
      borrower.address,
      collateralToken.target,
      collateralAmount,
    );

    const { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender } =
      await buildBlocksMatchData({
        vbl,
        borrower,
        lender,
        token,
        principal,
        termBlocks: 1n,
        rateBps: 0n,
        collateralAsset: await collateralToken.getAddress(),
        collateralAmount,
      });

    await vbl
      .connect(lender)
      .reserveForLending(
        lender.address,
        token.target,
        principal,
        lendIntentHash,
      );
    await vbl
      .connect(borrower)
      .finalizeMatchBlocks(borrowIntent, [lendIntent], sigBorrower, [
        sigLender,
      ]);

    await ethers.provider.send("evm_mine", []);

    const tx = await coordinator.connect(owner).settleOrLiquidateBlocks(0);
    const receipt = await tx.wait();

    expect(await le.getDebt(borrower.address, token.target)).to.equal(0);
    expect(
      await cm.getCollateral(borrower.address, collateralToken.target),
    ).to.equal(0);
    expect(await collateralToken.balanceOf(lenderPoolVault.target)).to.equal(
      collateralAmount,
    );

    const order = await coordinator.getBlocksOnlyOrder(0);
    expect(order.status).to.equal(4n);
    expect(order.closeBlock).to.be.gt(0);
    expect(getDataPushTypes(receipt)).to.include(
      DATA_TYPE_BLOCKS_ONLY_LIQUIDATED.toLowerCase(),
    );
  });
});

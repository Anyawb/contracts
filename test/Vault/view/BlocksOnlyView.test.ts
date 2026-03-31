import { expect } from "chai";
import { mine, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { ethers, upgrades } from "hardhat";
import { FunctionFragment } from "ethers";

const KEY_ACCESS_CONTROL = ethers.id("ACCESS_CONTROL_MANAGER");
const KEY_ASSET_WHITELIST = ethers.id("ASSET_WHITELIST");
const KEY_LE = ethers.id("LENDING_ENGINE");
const KEY_VAULT_CORE = ethers.id("VAULT_CORE");
const KEY_LENDER_POOL_VAULT = ethers.id("LENDER_POOL_VAULT");
const KEY_VAULT_BUSINESS_LOGIC = ethers.id("VAULT_BUSINESS_LOGIC");
const KEY_BLOCKS_ONLY_COORDINATOR = ethers.id("BLOCKS_ONLY_COORDINATOR");
const KEY_BLOCKS_ONLY_VIEW = ethers.id("BLOCKS_ONLY_VIEW");
const KEY_CM = ethers.id("COLLATERAL_MANAGER");
const KEY_LIQUIDATION_MANAGER = ethers.id("LIQUIDATION_MANAGER");
const KEY_LIQUIDATION_PAYOUT_MANAGER = ethers.id("LIQUIDATION_PAYOUT_MANAGER");

const ACTION_ADMIN = ethers.id("ACTION_ADMIN");
const ACTION_VIEW_USER_DATA = ethers.id("VIEW_USER_DATA");
const ACTION_VIEW_SYSTEM_DATA = ethers.id("VIEW_SYSTEM_DATA");
const ACTION_LIQUIDATE = ethers.id("LIQUIDATE");

const MAX_BATCH_SIZE = 100n;

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

describe("BlocksOnlyView", function () {
  async function buildBlocksMatchData(params: {
    vbl: any;
    borrower: any;
    lender: any;
    token: any;
    principal: bigint;
    termBlocks: bigint;
    rateBps: bigint;
    saltSuffix: string;
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
      saltSuffix,
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
      salt: ethers.keccak256(ethers.toUtf8Bytes(`borrow-blocks-${saltSuffix}`)),
    };

    const lendIntent = {
      lenderSigner: lender.address,
      asset: await token.getAddress(),
      amount: principal,
      minTermBlocks: termBlocks,
      maxTermBlocks: termBlocks,
      minRateBps: 0n,
      expireAt,
      salt: ethers.keccak256(ethers.toUtf8Bytes(`lend-blocks-${saltSuffix}`)),
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
    const [admin, lender, borrower, secondBorrower, outsider, ops] =
      await ethers.getSigners();

    const registry = await (
      await ethers.getContractFactory("MockRegistry")
    ).deploy();
    const acm = await (
      await ethers.getContractFactory("MockAccessControlManager")
    ).deploy();
    const assetWhitelist = await (
      await ethers.getContractFactory("MockAssetWhitelist")
    ).deploy();
    const cm = await (
      await ethers.getContractFactory("MockCollateralManager")
    ).deploy();
    const token = await (
      await ethers.getContractFactory("MockERC20")
    ).deploy("Mock USDC", "USDC", 18, ethers.parseUnits("1000000", 18));
    const collateralToken = await (
      await ethers.getContractFactory("MockERC20")
    ).deploy("Mock WETH", "WETH", 18, ethers.parseUnits("1000000", 18));
    const le = await (
      await ethers.getContractFactory("MockLendingEngineBasic")
    ).deploy();
    const vaultRouter = await (
      await ethers.getContractFactory("MockVaultRouter")
    ).deploy();

    const vaultCore = await upgrades.deployProxy(
      await ethers.getContractFactory("VaultCore"),
      [await registry.getAddress(), await vaultRouter.getAddress()],
      { kind: "uups", initializer: "initialize" },
    );
    const lenderPoolVault = await upgrades.deployProxy(
      await ethers.getContractFactory("LenderPoolVault"),
      [await registry.getAddress()],
      { kind: "uups", initializer: "initialize" },
    );
    const vbl = await upgrades.deployProxy(
      await ethers.getContractFactory("VaultBusinessLogic"),
      [await registry.getAddress(), await token.getAddress()],
      { kind: "uups", initializer: "initialize" },
    );
    const coordinator = await upgrades.deployProxy(
      await ethers.getContractFactory("BlocksOnlyCoordinator"),
      [await registry.getAddress()],
      { kind: "uups", initializer: "initialize" },
    );
    const blocksOnlyView = await upgrades.deployProxy(
      await ethers.getContractFactory("BlocksOnlyView"),
      [await registry.getAddress()],
      { kind: "uups", initializer: "initialize" },
    );
    const liquidationManager = await upgrades.deployProxy(
      await ethers.getContractFactory("LiquidationManager"),
      [await registry.getAddress()],
      { kind: "uups", initializer: "initialize" },
    );
    const liquidationPayoutManager = await upgrades.deployProxy(
      await ethers.getContractFactory("LiquidationPayoutManager"),
      [
        await registry.getAddress(),
        await acm.getAddress(),
        {
          platform: admin.address,
          reserve: admin.address,
          lenderCompensation: await lenderPoolVault.getAddress(),
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

    await registry.setModule(KEY_ACCESS_CONTROL, await acm.getAddress());
    await registry.setModule(
      KEY_ASSET_WHITELIST,
      await assetWhitelist.getAddress(),
    );
    await registry.setModule(KEY_LE, await le.getAddress());
    await registry.setModule(KEY_VAULT_CORE, await vaultCore.getAddress());
    await registry.setModule(
      KEY_LENDER_POOL_VAULT,
      await lenderPoolVault.getAddress(),
    );
    await registry.setModule(KEY_VAULT_BUSINESS_LOGIC, await vbl.getAddress());
    await registry.setModule(
      KEY_BLOCKS_ONLY_COORDINATOR,
      await coordinator.getAddress(),
    );
    await registry.setModule(
      KEY_BLOCKS_ONLY_VIEW,
      await blocksOnlyView.getAddress(),
    );
    await registry.setModule(KEY_CM, await cm.getAddress());
    await registry.setModule(
      KEY_LIQUIDATION_MANAGER,
      await liquidationManager.getAddress(),
    );
    await registry.setModule(
      KEY_LIQUIDATION_PAYOUT_MANAGER,
      await liquidationPayoutManager.getAddress(),
    );

    await assetWhitelist.setAssetAllowed(await token.getAddress(), true);
    await assetWhitelist.setAssetAllowed(
      await collateralToken.getAddress(),
      true,
    );

    await acm.grantRole(ACTION_ADMIN, admin.address);
    await acm.grantRole(ACTION_VIEW_USER_DATA, ops.address);
    await acm.grantRole(ACTION_VIEW_SYSTEM_DATA, ops.address);
    await acm.grantRole(ACTION_LIQUIDATE, admin.address);
    await acm.grantRole(ACTION_LIQUIDATE, await coordinator.getAddress());
    await acm.grantRole(
      ACTION_LIQUIDATE,
      await liquidationManager.getAddress(),
    );

    await token.transfer(lender.address, ethers.parseUnits("100000", 18));
    await token.transfer(borrower.address, ethers.parseUnits("1000", 18));
    await token.transfer(secondBorrower.address, ethers.parseUnits("1000", 18));
    await collateralToken.transfer(
      admin.address,
      ethers.parseUnits("1000", 18),
    );
    await token
      .connect(lender)
      .approve(await vbl.getAddress(), ethers.MaxUint256);

    return {
      admin,
      lender,
      borrower,
      secondBorrower,
      outsider,
      ops,
      registry,
      acm,
      cm,
      token,
      collateralToken,
      le,
      vbl,
      coordinator,
      blocksOnlyView,
      lenderPoolVault,
    };
  }

  async function finalizeBlocksOnlyOrder(params: {
    vbl: any;
    borrower: any;
    lender: any;
    token: any;
    principal: bigint;
    saltSuffix: string;
    collateralAsset?: string;
    collateralAmount?: bigint;
  }) {
    const {
      vbl,
      borrower,
      lender,
      token,
      principal,
      saltSuffix,
      collateralAsset,
      collateralAmount,
    } = params;
    const { borrowIntent, lendIntent, lendIntentHash, sigBorrower, sigLender } =
      await buildBlocksMatchData({
        vbl,
        borrower,
        lender,
        token,
        principal,
        termBlocks: 1n,
        rateBps: 0n,
        saltSuffix,
        collateralAsset,
        collateralAmount,
      });

    await vbl
      .connect(lender)
      .reserveForLending(
        lender.address,
        await token.getAddress(),
        principal,
        lendIntentHash,
      );
    await vbl
      .connect(borrower)
      .finalizeMatchBlocks(borrowIntent, [lendIntent], sigBorrower, [
        sigLender,
      ]);
  }

  describe("BOV-01 responsibility boundary", function () {
    it("exposes only read APIs plus initialize/upgrade", async function () {
      const { blocksOnlyView } = await loadFixture(deployFixture);

      const functionFragments = blocksOnlyView.interface.fragments.filter(
        (f): f is FunctionFragment => f.type === "function",
      );
      const pushFns = functionFragments.filter((f) =>
        f.name.startsWith("push"),
      );
      expect(pushFns.map((f) => f.name)).to.deep.equal([]);

      const nonView = functionFragments.filter(
        (f) => !["view", "pure"].includes(f.stateMutability),
      );
      for (const fn of nonView) {
        const isAllowed =
          fn.name === "initialize" ||
          fn.name.startsWith("upgradeTo") ||
          fn.name === "upgradeToAndCall";
        expect(
          isAllowed,
          `unexpected non-view external function: ${fn.name}`,
        ).to.equal(true);
      }
    });
  });

  describe("BOV-02 borrower privacy and borrower-scoped pagination", function () {
    it("allows borrower self-read and rejects outsider direct order access", async function () {
      const { lender, borrower, outsider, token, vbl, blocksOnlyView } =
        await loadFixture(deployFixture);

      await finalizeBlocksOnlyOrder({
        vbl,
        borrower,
        lender,
        token,
        principal: ethers.parseUnits("100", 18),
        saltSuffix: "privacy-0",
      });

      const order = await blocksOnlyView
        .connect(borrower)
        .getBlocksOnlyOrder(0);
      expect(order.orderId).to.equal(0n);
      expect(order.borrower).to.equal(borrower.address);
      expect(order.principal).to.equal(ethers.parseUnits("100", 18));
      expect(order.remainingDebt).to.equal(ethers.parseUnits("100", 18));
      expect(order.isMatured).to.equal(false);
      expect(order.canSettleOrLiquidate).to.equal(false);

      const [hasAccess] = await blocksOnlyView
        .connect(borrower)
        .canAccessBlocksOnlyOrder(0, borrower.address);
      expect(hasAccess).to.equal(true);

      await expect(
        blocksOnlyView.connect(outsider).getBlocksOnlyOrder(0),
      ).to.be.revertedWithCustomError(blocksOnlyView, "MissingRole");
    });

    it("marks active debt as settleable only after maturity is reached", async function () {
      const { lender, borrower, token, vbl, blocksOnlyView } =
        await loadFixture(deployFixture);

      await finalizeBlocksOnlyOrder({
        vbl,
        borrower,
        lender,
        token,
        principal: ethers.parseUnits("150", 18),
        saltSuffix: "maturity-flag-0",
      });

      const beforeMaturity = await blocksOnlyView
        .connect(borrower)
        .getBlocksOnlyOrder(0);
      expect(beforeMaturity.status).to.equal(1n);
      expect(beforeMaturity.isMatured).to.equal(false);
      expect(beforeMaturity.canSettleOrLiquidate).to.equal(false);

      await mine(1);

      const afterMaturity = await blocksOnlyView
        .connect(borrower)
        .getBlocksOnlyOrder(0);
      expect(afterMaturity.status).to.equal(1n);
      expect(afterMaturity.isClosed).to.equal(false);
      expect(afterMaturity.isMatured).to.equal(true);
      expect(afterMaturity.remainingDebt).to.equal(
        ethers.parseUnits("150", 18),
      );
      expect(afterMaturity.canSettleOrLiquidate).to.equal(true);
    });

    it("supports borrower order count and paginated borrower order pages", async function () {
      const { lender, borrower, outsider, ops, token, vbl, blocksOnlyView } =
        await loadFixture(deployFixture);

      await finalizeBlocksOnlyOrder({
        vbl,
        borrower,
        lender,
        token,
        principal: ethers.parseUnits("100", 18),
        saltSuffix: "borrower-page-0",
      });
      await finalizeBlocksOnlyOrder({
        vbl,
        borrower,
        lender,
        token,
        principal: ethers.parseUnits("200", 18),
        saltSuffix: "borrower-page-1",
      });

      const [count] = await blocksOnlyView
        .connect(borrower)
        .getBorrowerOrderCount(borrower.address);
      expect(count).to.equal(2n);

      const [idsPage, totalCount] = await blocksOnlyView
        .connect(borrower)
        .getBorrowerOrderIdsPaginated(borrower.address, 0, 1);
      expect(totalCount).to.equal(2n);
      expect(idsPage).to.deep.equal([0n]);

      const [items] = await blocksOnlyView
        .connect(ops)
        .getBorrowerOrdersPaginated(borrower.address, 0, 2);
      expect(items.length).to.equal(2);
      expect(items[0].orderId).to.equal(0n);
      expect(items[1].orderId).to.equal(1n);
      expect(items[1].principal).to.equal(ethers.parseUnits("200", 18));

      await expect(
        blocksOnlyView
          .connect(outsider)
          .getBorrowerOrderCount(borrower.address),
      ).to.be.revertedWithCustomError(blocksOnlyView, "MissingRole");
    });
  });

  describe("BOV-03 registry-bound lifecycle visibility", function () {
    it("tracks finalize -> repay -> settle and finalize -> liquidate through system view pages", async function () {
      const {
        admin,
        lender,
        borrower,
        secondBorrower,
        token,
        collateralToken,
        cm,
        vbl,
        coordinator,
        blocksOnlyView,
      } = await loadFixture(deployFixture);

      const settlePrincipal = ethers.parseUnits("250", 18);
      const settleCollateral = ethers.parseUnits("5", 18);
      await collateralToken.transfer(await cm.getAddress(), settleCollateral);
      await cm.setUserCollateral(
        borrower.address,
        await collateralToken.getAddress(),
        settleCollateral,
      );

      await finalizeBlocksOnlyOrder({
        vbl,
        borrower,
        lender,
        token,
        principal: settlePrincipal,
        saltSuffix: "settle-flow",
        collateralAsset: await collateralToken.getAddress(),
        collateralAmount: settleCollateral,
      });

      await token
        .connect(borrower)
        .approve(await coordinator.getAddress(), settlePrincipal);
      await coordinator.connect(borrower).repayBlocks(0, settlePrincipal);
      await mine(1);
      await coordinator.connect(admin).settleOrLiquidateBlocks(0);

      const liquidatePrincipal = ethers.parseUnits("300", 18);
      const liquidateCollateral = ethers.parseUnits("7", 18);
      await collateralToken.transfer(
        await cm.getAddress(),
        liquidateCollateral,
      );
      await cm.setUserCollateral(
        secondBorrower.address,
        await collateralToken.getAddress(),
        liquidateCollateral,
      );

      await finalizeBlocksOnlyOrder({
        vbl,
        borrower: secondBorrower,
        lender,
        token,
        principal: liquidatePrincipal,
        saltSuffix: "liquidate-flow",
        collateralAsset: await collateralToken.getAddress(),
        collateralAmount: liquidateCollateral,
      });

      await mine(1);
      await coordinator.connect(admin).settleOrLiquidateBlocks(1);

      const [systemCount] = await blocksOnlyView
        .connect(admin)
        .getSystemOrderCount();
      expect(systemCount).to.equal(2n);

      const [items, totalCount] = await blocksOnlyView
        .connect(admin)
        .getSystemOrdersPaginated(0, 10);
      expect(totalCount).to.equal(2n);
      expect(items.length).to.equal(2);

      expect(items[0].orderId).to.equal(0n);
      expect(items[0].status).to.equal(3n);
      expect(items[0].remainingDebt).to.equal(0n);
      expect(items[0].isMatured).to.equal(true);
      expect(items[0].isClosed).to.equal(true);
      expect(items[0].canSettleOrLiquidate).to.equal(false);

      expect(items[1].orderId).to.equal(1n);
      expect(items[1].status).to.equal(4n);
      expect(items[1].isMatured).to.equal(true);
      expect(items[1].isClosed).to.equal(true);
      expect(items[1].closeBlock).to.be.gt(0n);
      expect(items[1].canSettleOrLiquidate).to.equal(false);

      const [borrowerItems] = await blocksOnlyView
        .connect(secondBorrower)
        .getBorrowerOrdersPaginated(secondBorrower.address, 0, 10);
      expect(borrowerItems.length).to.equal(1);
      expect(borrowerItems[0].orderId).to.equal(1n);
      expect(borrowerItems[0].status).to.equal(4n);
    });
  });

  describe("BOV-04 batch guards and initialization", function () {
    it("enforces pagination limit and invalid order checks", async function () {
      const { admin, blocksOnlyView } = await loadFixture(deployFixture);

      await expect(
        blocksOnlyView.connect(admin).getSystemOrdersPaginated(0, 0),
      ).to.be.revertedWithCustomError(
        blocksOnlyView,
        "BlocksOnlyView__InvalidLimit",
      );
      await expect(
        blocksOnlyView
          .connect(admin)
          .getSystemOrdersPaginated(0, MAX_BATCH_SIZE + 1n),
      ).to.be.revertedWithCustomError(blocksOnlyView, "BatchTooLarge");
      await expect(
        blocksOnlyView.connect(admin).getBlocksOnlyOrder(0),
      ).to.be.revertedWithCustomError(
        blocksOnlyView,
        "BlocksOnlyView__InvalidOrderId",
      );
    });

    it("stores registry, exposes version info, and enforces init/upgrade guards", async function () {
      const { admin, outsider, blocksOnlyView, registry, acm } =
        await loadFixture(deployFixture);
      const BlocksOnlyViewFactory =
        await ethers.getContractFactory("BlocksOnlyView");

      expect(await blocksOnlyView.getRegistry()).to.equal(
        await registry.getAddress(),
      );
      expect(await blocksOnlyView.apiVersion()).to.equal(1n);
      expect(await blocksOnlyView.schemaVersion()).to.equal(1n);

      await upgrades.upgradeProxy(
        await blocksOnlyView.getAddress(),
        BlocksOnlyViewFactory.connect(admin),
      );
      await expect(
        upgrades.upgradeProxy(
          await blocksOnlyView.getAddress(),
          BlocksOnlyViewFactory.connect(outsider),
        ),
      ).to.be.revertedWithCustomError(acm, "MissingRole");

      const impl = await BlocksOnlyViewFactory.deploy();
      await impl.waitForDeployment();

      await expect(
        upgrades.deployProxy(BlocksOnlyViewFactory, [ethers.ZeroAddress], {
          kind: "uups",
        }),
      ).to.be.revertedWithCustomError(impl, "ZeroAddress");

      await expect(
        upgrades.deployProxy(BlocksOnlyViewFactory, [outsider.address], {
          kind: "uups",
        }),
      ).to.be.revertedWithCustomError(impl, "NotAContract");

      await expect(
        blocksOnlyView.initialize(await registry.getAddress()),
      ).to.be.revertedWithCustomError(blocksOnlyView, "InvalidInitialization");

      await expect(impl.getSystemOrderCount()).to.be.revertedWithCustomError(
        impl,
        "ZeroAddress",
      );
    });
  });
});

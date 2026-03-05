import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost.ts";

const BLOCKS_PER_DAY = 7_200n;

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function calcTotalDue(principal: bigint, rateBps: bigint, termBlocks: bigint) {
  // interest = principal * rate / 1e4 * term / 365 days (block-based)
  const denom = 365n * BLOCKS_PER_DAY * 10_000n;
  const interest = (principal * rateBps * termBlocks) / denom;
  return principal + interest;
}

async function main() {
  const [deployer, borrower, lender] = await ethers.getSigners();

  const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
  const acmAddrFromRegistry = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
  const assetWhitelistAddrFromRegistry = (await registry.getModuleOrRevert(key("ASSET_WHITELIST"))) as string;
  const priceOracleAddrFromRegistry = (await registry.getModuleOrRevert(key("PRICE_ORACLE"))) as string;
  const settlementTokenAddrFromRegistry = (await registry.getModuleOrRevert(key("SETTLEMENT_TOKEN"))) as string;
  const vaultCoreFromRegistryAddr = (await registry.getModuleOrRevert(key("VAULT_CORE"))) as string;
  const vblAddrFromRegistry = (await registry.getModuleOrRevert(key("VAULT_BUSINESS_LOGIC"))) as string;
  const cmAddrFromRegistry = (await registry.getModuleOrRevert(key("COLLATERAL_MANAGER"))) as string;

  const acm = (await ethers.getContractAt("AccessControlManager", acmAddrFromRegistry)) as any;
  const aw = (await ethers.getContractAt("AssetWhitelist", assetWhitelistAddrFromRegistry)) as any;
  const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", priceOracleAddrFromRegistry)) as any;
  const usdc = (await ethers.getContractAt("MockERC20", settlementTokenAddrFromRegistry)) as any;
  const vaultCore = (await ethers.getContractAt("VaultCore", vaultCoreFromRegistryAddr)) as any;
  const vbl = (await ethers.getContractAt("VaultBusinessLogic", vblAddrFromRegistry)) as any;

  // Resolve modules from registry to avoid name confusion
  const orderEngineAddr = await registry.getModuleOrRevert(key("ORDER_ENGINE"));
  const loanNftAddr = await registry.getModuleOrRevert(key("LOAN_NFT"));
  const feeRouterAddr = await registry.getModuleOrRevert(key("FEE_ROUTER"));
  const settlementManagerAddr = await registry.getModuleOrRevert(key("SETTLEMENT_MANAGER"));
  const settlementManager = (await ethers.getContractAt(
    "src/Vault/liquidation/modules/SettlementManager.sol:SettlementManager",
    settlementManagerAddr
  )) as any;

  const orderEngine = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", orderEngineAddr)) as any;
  const loanNft = (await ethers.getContractAt("LoanNFT", loanNftAddr)) as any;

  console.log("ORDER_ENGINE", orderEngineAddr);
  console.log("LOAN_NFT", loanNftAddr);
  console.log("FEE_ROUTER", feeRouterAddr);

  // Roles
  const ACTION_ADD_WHITELIST = key("ADD_WHITELIST");
  const ACTION_UPDATE_PRICE = key("UPDATE_PRICE");
  const ACTION_ORDER_CREATE = key("ORDER_CREATE");
  const ACTION_REPAY = key("REPAY");
  const ACTION_BORROW = key("BORROW"); // LoanNFT MINTER_ROLE maps to ACTION_BORROW
  const ACTION_DEPOSIT = key("DEPOSIT"); // FeeRouter distributeNormal permission

  const ensureRole = async (role: string, who: string) => {
    if (!(await acm.hasRole(role, who))) {
      await acm.grantRole(role, who);
    }
  };

  // Ensure permissions
  await ensureRole(ACTION_ADD_WHITELIST, deployer.address);
  await ensureRole(ACTION_UPDATE_PRICE, deployer.address);

  // Order engine needs BORROW to mint/update LoanNFT
  await ensureRole(ACTION_BORROW, orderEngineAddr);
  // Optional: allow FeeRouter fee distribution from order engine
  await ensureRole(ACTION_DEPOSIT, orderEngineAddr);

  // Funds-flow SSOT: orchestrator + settlement manager roles
  await ensureRole(ACTION_ORDER_CREATE, vblAddrFromRegistry);
  await ensureRole(ACTION_DEPOSIT, vblAddrFromRegistry);
  await ensureRole(ACTION_REPAY, settlementManagerAddr);

  // Whitelist + price
  if (!(await aw.isAssetAllowed(settlementTokenAddrFromRegistry))) {
    await aw.connect(deployer).addAllowedAsset(settlementTokenAddrFromRegistry);
  }
  {
    const cfg = await po.getAssetConfig(settlementTokenAddrFromRegistry);
    if (!cfg.isActive) {
      const usdcDecimals = Number(await usdc.decimals().catch(() => 6));
      await po.connect(deployer).configureAsset(settlementTokenAddrFromRegistry, "usd-coin", usdcDecimals, 3600);
    }
  }
  const blockNumber = await ethers.provider.getBlockNumber();
  await po.connect(deployer).updatePrice(settlementTokenAddrFromRegistry, ethers.parseUnits("1", 8), blockNumber);

  // Fund users
  await usdc.connect(deployer).transfer(borrower.address, ethers.parseUnits("10000", 6));
  await usdc.connect(deployer).transfer(lender.address, ethers.parseUnits("10000", 6));

  // === SSOT borrow flow: finalizeMatch -> borrowFor -> createLoanOrder ===
  const principal = ethers.parseUnits("500", 6);
  const termDays = 5;
  const rateBps = 1000n; // 10%

  // Deposit collateral first (strict architecture: match does NOT top up collateral)
  const collateralAmt = ethers.parseUnits("1000", 6);
  await usdc.connect(borrower).approve(vaultCoreFromRegistryAddr, collateralAmt);
  await usdc.connect(borrower).approve(cmAddrFromRegistry, collateralAmt);
  await vaultCore.connect(borrower).deposit(settlementTokenAddrFromRegistry, collateralAmt);

  // Lender reserve (VaultBusinessLogic pulls lender -> pool)
  await usdc.connect(lender).approve(vblAddrFromRegistry, principal);

  const expireAt = BigInt(await ethers.provider.getBlockNumber()) + 1_800n;
  const borrowIntent = {
    borrower: borrower.address,
    collateralAsset: settlementTokenAddrFromRegistry,
    collateralAmount: collateralAmt,
    borrowAsset: settlementTokenAddrFromRegistry,
    amount: principal,
    termDays,
    rateBps,
    expireAt,
    salt: ethers.keccak256(ethers.toUtf8Bytes("borrow-salt-orderflow")),
  };
  const lendIntent = {
    lenderSigner: lender.address,
    asset: settlementTokenAddrFromRegistry,
    amount: principal,
    minTermDays: 1,
    maxTermDays: 30,
    minRateBps: 0n,
    expireAt,
    salt: ethers.keccak256(ethers.toUtf8Bytes("lend-salt-orderflow")),
  };

  // Reuse the same hash encoding as other e2e scripts
  const typeHash = ethers.keccak256(
    ethers.toUtf8Bytes(
      "LendIntent(address lenderSigner,address asset,uint256 amount,uint16 minTermDays,uint16 maxTermDays,uint256 minRateBps,uint256 expireAt,bytes32 salt)"
    )
  );
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const lendHash = ethers.keccak256(
    coder.encode(
      ["bytes32", "address", "address", "uint256", "uint16", "uint16", "uint256", "uint256", "bytes32"],
      [
        typeHash,
        lendIntent.lenderSigner,
        lendIntent.asset,
        lendIntent.amount,
        lendIntent.minTermDays,
        lendIntent.maxTermDays,
        lendIntent.minRateBps,
        lendIntent.expireAt,
        lendIntent.salt,
      ]
    )
  );
  await vbl.connect(lender).reserveForLending(lender.address, settlementTokenAddrFromRegistry, principal, lendHash);

  const domain = {
    name: "RwaLending",
    version: "1",
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    verifyingContract: vblAddrFromRegistry,
  } as const;
  const typesBorrow = {
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
  };
  const typesLend = {
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
  };
  const sigBorrower = await borrower.signTypedData(domain, typesBorrow as any, borrowIntent as any);
  const sigLender = await lender.signTypedData(domain, typesLend as any, lendIntent as any);

  const borrowerTokensBefore = await loanNft.getUserTokens(borrower.address);
  const tx = await vbl.connect(deployer).finalizeMatch(borrowIntent as any, [lendIntent] as any, sigBorrower, [sigLender]);
  const receipt = await tx.wait();

  // Infer orderId from event LoanOrderCreated(orderId,...)
  const orderId = (() => {
    for (const log of receipt!.logs) {
      try {
        const parsed = orderEngine.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === "LoanOrderCreated") return parsed.args.orderId as bigint;
      } catch {
        // ignore
      }
    }
    throw new Error("LoanOrderCreated not found; cannot infer orderId");
  })();
  console.log("orderId", orderId.toString());

  const borrowerTokensAfter = await loanNft.getUserTokens(borrower.address);
  console.log("borrower LoanNFT tokens before/after", borrowerTokensBefore.length, borrowerTokensAfter.length);
  const newTokenId = borrowerTokensAfter.find((t) => !borrowerTokensBefore.includes(t));
  console.log("minted tokenId", newTokenId?.toString());

  // Repay full
  const termBlocks = BigInt(termDays) * BLOCKS_PER_DAY;
  const totalDue = calcTotalDue(principal, rateBps, termBlocks);
  console.log("totalDue", totalDue.toString());

  // Some deployments gate collateral release behind full repay flags; best-effort disable for local demo.
  if (typeof (settlementManager as any).requireFullRepayRelease === "function") {
    const requireFull = (await settlementManager.requireFullRepayRelease()) as boolean;
    if (requireFull && typeof (settlementManager as any).setRequireFullRepayRelease === "function") {
      await (await settlementManager.connect(deployer).setRequireFullRepayRelease(false)).wait();
    }
  }

  await usdc.connect(borrower).approve(vaultCoreFromRegistryAddr, totalDue);

  const lenderBalBefore = await usdc.balanceOf(lender.address);
  const repayTx = await vaultCore.connect(borrower).repay(orderId, settlementTokenAddrFromRegistry, totalDue);
  await repayTx.wait();
  const lenderBalAfter = await usdc.balanceOf(lender.address);
  console.log("lender balance delta", (lenderBalAfter - lenderBalBefore).toString());

  if (newTokenId !== undefined) {
    const meta = await loanNft.getLoanMetadata(newTokenId);
    console.log("LoanNFT status after repay", meta.status);
  }

  console.log("Order-engine E2E flow completed");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

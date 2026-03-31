import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost.ts";

// Keep consistent with TermBlocksLib bucket mapping (5d=36000 => 7200 blocks/day baseline).
const BLOCKS_PER_DAY = 7_200n;
const ONE_HOUR_BLOCKS = 1_800n;

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function calcTotalDue(principal: bigint, rateBps: bigint, termBlocks: bigint) {
  const denom = 365n * BLOCKS_PER_DAY * 10_000n;
  const interest = (principal * rateBps * termBlocks) / denom;
  return principal + interest;
}

async function latestBlockNumber(): Promise<bigint> {
  return BigInt(await ethers.provider.getBlockNumber());
}

function buildLendIntentHash(li: any) {
  const typeHash = ethers.keccak256(
    ethers.toUtf8Bytes(
      "LendIntent(address lenderSigner,address asset,uint256 amount,uint16 minTermDays,uint16 maxTermDays,uint256 minRateBps,uint256 expireAt,bytes32 salt)"
    )
  );
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(
    coder.encode(
      ["bytes32", "address", "address", "uint256", "uint16", "uint16", "uint256", "uint256", "bytes32"],
      [
        typeHash,
        li.lenderSigner,
        li.asset,
        li.amount,
        li.minTermDays,
        li.maxTermDays,
        li.minRateBps,
        li.expireAt,
        li.salt,
      ]
    )
  );
}

async function main() {
  const [deployer, borrower, lender] = await ethers.getSigners();

  const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
  const acmAddrFromRegistry = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
  const assetWhitelistAddrFromRegistry = (await registry.getModuleOrRevert(key("ASSET_WHITELIST"))) as string;
  const priceOracleAddrFromRegistry = (await registry.getModuleOrRevert(key("PRICE_ORACLE"))) as string;
  const feeRouterAddrFromRegistry = (await registry.getModuleOrRevert(key("FEE_ROUTER"))) as string;
  const settlementTokenAddrFromRegistry = (await registry.getModuleOrRevert(key("SETTLEMENT_TOKEN"))) as string;
  const vaultCoreFromRegistryAddr = (await registry.getModuleOrRevert(key("VAULT_CORE"))) as string;
  const vblAddrFromRegistry = (await registry.getModuleOrRevert(key("VAULT_BUSINESS_LOGIC"))) as string;

  const acm = (await ethers.getContractAt("AccessControlManager", acmAddrFromRegistry)) as any;
  const awRead = (await ethers.getContractAt("IAssetWhitelistRead", assetWhitelistAddrFromRegistry)) as any;
  const awAdmin = (await ethers.getContractAt("IAssetWhitelistAdmin", assetWhitelistAddrFromRegistry)) as any;
  const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", priceOracleAddrFromRegistry)) as any;
  const feeRouter = (await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", feeRouterAddrFromRegistry)) as any;
  const usdc = (await ethers.getContractAt("MockERC20", settlementTokenAddrFromRegistry)) as any;
  const vaultCore = (await ethers.getContractAt("VaultCore", vaultCoreFromRegistryAddr)) as any;
  const vbl = (await ethers.getContractAt("VaultBusinessLogic", vblAddrFromRegistry)) as any;

  const orderEngineAddr = await registry.getModuleOrRevert(key("ORDER_ENGINE"));
  const settlementManagerAddr = await registry.getModuleOrRevert(key("SETTLEMENT_MANAGER"));
  const settlementManager = (await ethers.getContractAt(
    "src/Vault/liquidation/modules/SettlementManager.sol:SettlementManager",
    settlementManagerAddr
  )) as any;
  const orderEngine = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", orderEngineAddr)) as any;
  const loanNftAddr = await registry.getModuleOrRevert(key("LOAN_NFT"));
  const loanNft = await ethers.getContractAt("LoanNFT", loanNftAddr);

  console.log("VaultBusinessLogic", await vbl.getAddress());
  console.log("ORDER_ENGINE", orderEngineAddr);
  console.log("LOAN_NFT", loanNftAddr);

  const ACTION_ADD_WHITELIST = key("ADD_WHITELIST");
  const ACTION_UPDATE_PRICE = key("UPDATE_PRICE");
  const ACTION_SET_PARAMETER = key("SET_PARAMETER");
  const ACTION_DEPOSIT = key("DEPOSIT");
  const ACTION_ORDER_CREATE = key("ORDER_CREATE");
  const ACTION_BORROW = key("BORROW");
  const ACTION_REPAY = key("REPAY");

  const ensureRole = async (role: string, who: string) => {
    if (!(await acm.hasRole(role, who))) await acm.grantRole(role, who);
  };

  // permissions for config
  await ensureRole(ACTION_ADD_WHITELIST, deployer.address);
  await ensureRole(ACTION_UPDATE_PRICE, deployer.address);
  await ensureRole(ACTION_SET_PARAMETER, deployer.address);

  // permissions for match/orchestration contract
  await ensureRole(ACTION_ORDER_CREATE, vblAddrFromRegistry);
  await ensureRole(ACTION_DEPOSIT, vblAddrFromRegistry);

  // Order engine needs BORROW to mint/update LoanNFT
  await ensureRole(ACTION_BORROW, orderEngineAddr);

  // borrower needs repay on order engine
  await ensureRole(ACTION_REPAY, borrower.address);

  // whitelist + price
  if (!(await awRead.isAssetAllowed(settlementTokenAddrFromRegistry))) {
    await awAdmin.connect(deployer).addAllowedAsset(settlementTokenAddrFromRegistry);
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

  // FeeRouter needs supported token
  if (!(await feeRouter.isTokenSupported(settlementTokenAddrFromRegistry))) {
    await feeRouter.connect(deployer).addSupportedToken(settlementTokenAddrFromRegistry);
  }

  // Best-effort: disable early repayment guarantee to avoid allowance coupling in matchflow.
  try {
    if (CONTRACT_ADDRESSES.EarlyRepaymentGuaranteeManager) {
      const ergm = await ethers.getContractAt(
        "src/Vault/modules/EarlyRepaymentGuaranteeManager.sol:EarlyRepaymentGuaranteeManager",
        CONTRACT_ADDRESSES.EarlyRepaymentGuaranteeManager
      );
      await ensureRole(ACTION_SET_PARAMETER, deployer.address);
      await ergm.connect(deployer).setGuaranteeEnabled(usdc.target, false);
    }
  } catch {}

  // fund users
  await usdc.connect(deployer).transfer(borrower.address, ethers.parseUnits("20000", 6));
  await usdc.connect(deployer).transfer(lender.address, ethers.parseUnits("20000", 6));

  // borrower deposits collateral first (realistic path)
  const collateralAmt = ethers.parseUnits("1000", 6);
  await usdc.connect(borrower).approve(CONTRACT_ADDRESSES.CollateralManager, collateralAmt);
  await vaultCore.connect(borrower).deposit(usdc.target, collateralAmt);

  // prepare intents
  const borrowAmt = ethers.parseUnits("500", 6);
  const termDays = 5;
  const rateBps = 1000n;
  const expireAt = (await latestBlockNumber()) + ONE_HOUR_BLOCKS;

  const borrowIntent = {
    borrower: borrower.address,
    collateralAsset: usdc.target,
    collateralAmount: collateralAmt,
    borrowAsset: usdc.target,
    amount: borrowAmt,
    termDays,
    rateBps,
    expireAt,
    salt: ethers.keccak256(ethers.toUtf8Bytes("borrow-salt-1")),
  };

  const lendIntent = {
    lenderSigner: lender.address,
    asset: usdc.target,
    amount: borrowAmt,
    minTermDays: 1,
    maxTermDays: 30,
    minRateBps: 0n,
    expireAt,
    salt: ethers.keccak256(ethers.toUtf8Bytes("lend-salt-1")),
  };

  // lender reserves funds into VBL
  await usdc.connect(lender).approve(CONTRACT_ADDRESSES.VaultBusinessLogic, borrowAmt);
  const lendHash = buildLendIntentHash(lendIntent);
  await vbl.connect(lender).reserveForLending(lender.address, usdc.target, borrowAmt, lendHash);

  // Sign EIP-712 intents
  const domain = {
    name: "RwaLending",
    version: "1",
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    verifyingContract: CONTRACT_ADDRESSES.VaultBusinessLogic,
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

  // finalize match
  const tx = await vbl.connect(deployer).finalizeMatch(
    borrowIntent,
    [lendIntent],
    sigBorrower,
    [sigLender]
  );
  const receipt = await tx.wait();

  // infer orderId from order engine event
  let orderId: bigint | null = null;
  for (const log of receipt!.logs) {
    try {
      const parsed = orderEngine.interface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "LoanOrderCreated") {
        orderId = parsed.args.orderId as bigint;
        break;
      }
    } catch {
      // ignore
    }
  }
  console.log("orderId", orderId?.toString());

  const borrowerTokensAfter = await loanNft.getUserTokens(borrower.address);
  const newTokenId = borrowerTokensAfter.find((t) => !borrowerTokensBefore.includes(t));
  console.log("LoanNFT tokenId", newTokenId?.toString());

  // repay on order engine
  if (orderId === null) throw new Error("LoanOrderCreated not found");
  const termBlocks = BigInt(termDays) * BLOCKS_PER_DAY;
  const totalDue = calcTotalDue(borrowAmt, rateBps, termBlocks);
  const requireFullRepayRelease = (await settlementManager.requireFullRepayRelease()) as boolean;
  if (requireFullRepayRelease) {
    console.log("  ⚠️  SettlementManager.requireFullRepayRelease=true; disabling for this run");
    await (await settlementManager.connect(deployer).setRequireFullRepayRelease(false)).wait();
  }
  // 统一入口：走 VaultCore.repay → SettlementManager（覆盖 SSOT 资金链）
  await usdc.connect(borrower).approve(CONTRACT_ADDRESSES.VaultCore, totalDue);
  await vaultCore.connect(borrower).repay(orderId, usdc.target, totalDue);

  if (newTokenId !== undefined) {
    const meta = await loanNft.getLoanMetadata(newTokenId);
    console.log("LoanNFT status after repay", meta.status);
  }

  console.log("Matchflow E2E completed");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost.ts";

const BLOCKS_PER_DAY = 7_200n;
const ONE_HOUR_BLOCKS = 1_800n;

function calcTotalDue(principal: bigint, rateBps: bigint, termBlocks: bigint) {
  // interest = principal * rate / 1e4 * term / 365 days (block-based)
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

function inferOrderIdFromReceipt(orderEngine: any, receipt: any): bigint {
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = orderEngine.interface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "LoanOrderCreated") {
        return parsed.args.orderId as bigint;
      }
    } catch {
      // ignore
    }
  }
  throw new Error("LoanOrderCreated not found; cannot infer orderId");
}

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];

  const usdc = (await ethers.getContractAt("MockERC20", CONTRACT_ADDRESSES.MockUSDC)) as any;
  const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
  const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;
  const whitelist = (await ethers.getContractAt("AssetWhitelist", CONTRACT_ADDRESSES.AssetWhitelist)) as any;
  const priceOracle = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", CONTRACT_ADDRESSES.PriceOracle)) as any;
  const vaultCore = (await ethers.getContractAt("VaultCore", CONTRACT_ADDRESSES.VaultCore)) as any;
  const vaultRouter = (await ethers.getContractAt("VaultRouter", CONTRACT_ADDRESSES.VaultRouter)) as any;
  const cm = (await ethers.getContractAt("CollateralManager", CONTRACT_ADDRESSES.CollateralManager)) as any;
  const vbl = (await ethers.getContractAt("VaultBusinessLogic", CONTRACT_ADDRESSES.VaultBusinessLogic)) as any;
  // HH701: 使用 fully qualified name 避免重名；ORDER_ENGINE 在 src/core/LendingEngine.sol
  // NOTE: CONTRACT_ADDRESSES.LendingEngine is a legacy alias; prefer OrderEngine when present.
  const orderEngineAddr = (CONTRACT_ADDRESSES as any).OrderEngine ?? CONTRACT_ADDRESSES.LendingEngine;
  const orderEngine = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", orderEngineAddr)) as any;
  const settlementManagerAddr = await registry.getModuleOrRevert(ethers.keccak256(ethers.toUtf8Bytes("SETTLEMENT_MANAGER")));
  const settlementManager = (await ethers.getContractAt(
    "src/Vault/liquidation/modules/SettlementManager.sol:SettlementManager",
    settlementManagerAddr
  )) as any;

  // Pick fresh borrower/lender to avoid GuaranteeAlreadyProcessed on dirty localhost chains.
  let ergm: any | null = null;
  try {
    const ergmAddr = await registry.getModule(ethers.keccak256(ethers.toUtf8Bytes("EARLY_REPAYMENT_GUARANTEE_MANAGER")));
    if (ergmAddr && ergmAddr !== ethers.ZeroAddress) {
      ergm = (await ethers.getContractAt(
        "src/Vault/modules/EarlyRepaymentGuaranteeManager.sol:EarlyRepaymentGuaranteeManager",
        ergmAddr
      )) as any;
    }
  } catch {
    // best-effort: optional module
  }

  const pickFreshSigner = async (exclude: Set<string>) => {
    for (const s of signers) {
      if (exclude.has(s.address.toLowerCase())) continue;
      if (ergm && (await ergm.hasActiveGuarantee(s.address, usdc.target))) continue;
      return s;
    }
    throw new Error("No fresh signer available (active guarantee). Restart localhost for a clean state.");
  };

  const exclude = new Set<string>([deployer.address.toLowerCase()]);
  const borrower = await pickFreshSigner(exclude);
  exclude.add(borrower.address.toLowerCase());
  const lender = await pickFreshSigner(exclude);

  const ACTION_DEPOSIT = ethers.keccak256(ethers.toUtf8Bytes("DEPOSIT"));
  const ACTION_BORROW = ethers.keccak256(ethers.toUtf8Bytes("BORROW"));
  const ACTION_REPAY = ethers.keccak256(ethers.toUtf8Bytes("REPAY"));
  const ACTION_WITHDRAW = ethers.keccak256(ethers.toUtf8Bytes("WITHDRAW"));
  const ACTION_VIEW_PUSH = ethers.keccak256(ethers.toUtf8Bytes("ACTION_VIEW_PUSH"));
  const ACTION_ADD_WHITELIST = ethers.keccak256(ethers.toUtf8Bytes("ADD_WHITELIST"));
  const ACTION_SET_PARAMETER = ethers.keccak256(ethers.toUtf8Bytes("SET_PARAMETER"));
  const ACTION_UPDATE_PRICE = ethers.keccak256(ethers.toUtf8Bytes("UPDATE_PRICE"));
  const KEY_VAULT_BUSINESS_LOGIC = ethers.keccak256(ethers.toUtf8Bytes("VAULT_BUSINESS_LOGIC"));
  const ACTION_ORDER_CREATE = ethers.keccak256(ethers.toUtf8Bytes("ORDER_CREATE"));

  const ensureRole = async (role: string, account: string) => {
    const has = await acm.hasRole(role, account);
    if (!has) {
      await acm.grantRole(role, account);
    }
  };

  // ====== 基础配置 ======
  // 白名单资产
  const allowed = await whitelist.isAssetAllowed(usdc.target);
  if (!allowed) {
    await ensureRole(ACTION_ADD_WHITELIST, deployer.address);
    await whitelist.connect(deployer).addAllowedAsset(usdc.target);
  }

  // 设置价格 (1 USD = 1e8, PriceOracle uses 8 decimals)
  const blockNumber = await ethers.provider.getBlockNumber();
  {
    const cfg = await priceOracle.getAssetConfig(usdc.target);
    if (!cfg.isActive) {
      await ensureRole(ACTION_SET_PARAMETER, deployer.address);
      const usdcDecimals = Number(await usdc.decimals().catch(() => 6));
      await priceOracle.connect(deployer).configureAsset(usdc.target, "usd-coin", usdcDecimals, 3600);
    }
  }
  await ensureRole(ACTION_UPDATE_PRICE, deployer.address);
  await priceOracle.connect(deployer).updatePrice(usdc.target, ethers.parseUnits("1", 8), blockNumber);

  // 授权角色给 VaultRouter / VaultCore
  const roles = [ACTION_DEPOSIT, ACTION_BORROW, ACTION_REPAY, ACTION_WITHDRAW];
  for (const r of roles) {
    await ensureRole(r, vaultRouter.target);
    await ensureRole(r, vaultCore.target);
  }
  // Funds-flow SSOT: match settlement requires VaultBusinessLogic + SettlementManager privileges
  await ensureRole(ACTION_ORDER_CREATE, vbl.target);
  await ensureRole(ACTION_DEPOSIT, vbl.target); // FeeRouter.distributeNormal permission
  await ensureRole(ACTION_REPAY, settlementManagerAddr); // SettlementManager calls ORDER_ENGINE.repay
  // OrderEngine needs BORROW to mint/update LoanNFT (deployment may already grant it)
  await ensureRole(ACTION_BORROW, orderEngineAddr);
  await ensureRole(ACTION_VIEW_PUSH, vaultRouter.target);
  await ensureRole(ACTION_VIEW_PUSH, vaultCore.target);

  // 资金准备
  await usdc.connect(deployer).transfer(borrower.address, ethers.parseUnits("10000", 6));
  await usdc.connect(deployer).transfer(lender.address, ethers.parseUnits("10000", 6));
  // VaultCore.deposit pulls collateral via CollateralManager.transferFrom, so spender must be CollateralManager.
  await usdc.connect(borrower).approve(cm.target, ethers.MaxUint256);
  // reserveForLending pulls funds from lender -> LenderPoolVault via VaultBusinessLogic
  await usdc.connect(lender).approve(vbl.target, ethers.MaxUint256);

  console.log("has VIEW_PUSH (router/core):", await acm.hasRole(ACTION_VIEW_PUSH, vaultRouter.target), await acm.hasRole(ACTION_VIEW_PUSH, vaultCore.target));

  // ====== 1) 存抵押 ======
  const depositAmount = ethers.parseUnits("1000", 6);
  await vaultCore.connect(borrower).deposit(usdc.target, depositAmount);
  const col = await cm.getCollateral(borrower.address, usdc.target);
  console.log("Collateral after deposit:", col.toString());

  // ====== 2) 撮合放款（SSOT：finalizeMatch -> borrowFor -> createLoanOrder） ======
  const principal = ethers.parseUnits("500", 6);
  const termDays = 5;
  const rateBps = 1000n; // 10%
  const termBlocks = BigInt(termDays) * BLOCKS_PER_DAY;
  const promisedInterest = calcTotalDue(principal, rateBps, termBlocks) - principal;
  const expireAt = (await latestBlockNumber()) + ONE_HOUR_BLOCKS;

  const borrowIntent = {
    borrower: borrower.address,
    collateralAsset: usdc.target,
    collateralAmount: depositAmount,
    borrowAsset: usdc.target,
    amount: principal,
    termDays,
    rateBps,
    expireAt,
    salt: ethers.keccak256(ethers.toUtf8Bytes("borrow-salt-e2e-localhost")),
  };

  const lendIntent = {
    lenderSigner: lender.address,
    asset: usdc.target,
    amount: principal,
    minTermDays: 1,
    maxTermDays: 30,
    minRateBps: 0n,
    expireAt,
    salt: ethers.keccak256(ethers.toUtf8Bytes("lend-salt-e2e-localhost")),
  };

  // Early-repayment guarantee (if enabled) pulls promisedInterest via GFM during finalizeMatch.
  try {
    const ergmAddr = await registry.getModule(ethers.keccak256(ethers.toUtf8Bytes("EARLY_REPAYMENT_GUARANTEE_MANAGER")));
    if (ergmAddr && ergmAddr !== ethers.ZeroAddress && promisedInterest > 0n) {
      const ergm = (await ethers.getContractAt(
        "src/Vault/modules/EarlyRepaymentGuaranteeManager.sol:EarlyRepaymentGuaranteeManager",
        ergmAddr
      )) as any;
      const enabled = await ergm.isGuaranteeEnabled(usdc.target);
      if (enabled) {
        const gfmAddr = await registry.getModuleOrRevert(ethers.keccak256(ethers.toUtf8Bytes("GUARANTEE_FUND_MANAGER")));
        await (await usdc.connect(borrower).approve(gfmAddr, promisedInterest)).wait();
      }
    }
  } catch {
    // best-effort: guarantee module may be missing on some deployments
  }

  const lendHash = buildLendIntentHash(lendIntent);
  await vbl.connect(lender).reserveForLending(lender.address, usdc.target, principal, lendHash);

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

  const matchTx = await vbl.connect(deployer).finalizeMatch(borrowIntent, [lendIntent], sigBorrower, [sigLender]);
  const matchReceipt = await matchTx.wait();
  const orderId = inferOrderIdFromReceipt(orderEngine, matchReceipt);
  console.log("Borrow finalized, orderId:", orderId.toString());

  // ====== 3) 还款（SSOT：VaultCore.repay -> SettlementManager -> ORDER_ENGINE.repay） ======
  const totalDue = calcTotalDue(principal, rateBps, termBlocks);
  // Some deployments may gate collateral release behind full repay flags; best-effort disable for local demo.
  if (typeof (settlementManager as any).requireFullRepayRelease === "function") {
    const requireFull = (await settlementManager.requireFullRepayRelease()) as boolean;
    if (requireFull && typeof (settlementManager as any).setRequireFullRepayRelease === "function") {
      await settlementManager.connect(deployer).setRequireFullRepayRelease(false);
    }
  }
  await usdc.connect(borrower).approve(vaultCore.target, totalDue);
  await vaultCore.connect(borrower).repay(orderId, usdc.target, totalDue);
  console.log("Repay done");

  // 验证抵押仍在（未退出）
  const colAfter = await cm.getCollateral(borrower.address, usdc.target);
  console.log("Collateral after repay:", colAfter.toString());

  console.log("E2E flow completed on localhost");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

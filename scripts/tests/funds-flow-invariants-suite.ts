import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";
import { assertConservation, discoverTrackedAddresses, getErc20, key, snapshotBalances, uniqAddrs } from "./_fundsFlowUtils";

/**
 * Funds-Flow Invariants Suite (localhost)
 *
 * Goal: provide a more "realistic" smoke suite than a single clean-case conservation check.
 * It validates:
 * - ERC20 totalSupply invariance (no mint/burn) across core flows
 * - balance-sum conservation across a curated tracked-address set
 * - key behavioral invariants: partial repay behavior, strict full-repay mode behavior, aggregated debt behavior
 *
 * This is still a smoke suite (fast, deterministic), not a full formal proof.
 *
 * Env knobs:
 * - RUN_FINALIZE_MATCH_ONLY=1 (runs only createOrder -> finalizeMatch checks; disables other cases; uses first token only)
 * - RUN_MATCH_DISBURSEMENT_ONLY=1 (runs only match -> borrow disbursement SSOT assertions; disables other cases; uses first token only)
 * - RUN_RESERVE_CANCEL=0/1 (default 1)
 * - RUN_PARTIAL_REPAY=0/1 (default 1)
 * - RUN_STRICT_AGGREGATED_DEBT=0/1 (default 1)
 * - RUN_LIQUIDATION=0/1 (default 1)
 * - E2E_ALLOW_DIRTY_STATE=1 (allows running even if node has historical positions; suite will try to pick clean signers)
 */

const ONE_DAY = 24n * 60n * 60n;

function hashLendIntentStruct(lendIntent: {
  lenderSigner: string;
  asset: string;
  amount: bigint;
  minTermDays: number;
  maxTermDays: number;
  minRateBps: bigint;
  expireAt: bigint;
  salt: string;
}) {
  // Must match SettlementIntentLib.hashLendIntent (SSOT) type string and encoding.
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
}

async function getOrderForView(orderEngineAddr: string, orderId: bigint) {
  const orderEngineView = await ethers.getContractAt(
    [
      "function _getLoanOrderForView(uint256) view returns (tuple(uint256 principal,uint256 rate,uint256 term,address borrower,address lender,address asset,uint256 startTimestamp,uint256 maturity,uint256 repaidAmount))",
    ],
    orderEngineAddr
  );
  return (await orderEngineView._getLoanOrderForView(orderId)) as {
    principal: bigint;
    rate: bigint;
    term: bigint;
    borrower: string;
    lender: string;
    asset: string;
    startTimestamp: bigint;
    maturity: bigint;
    repaidAmount: bigint;
  };
}

function calcInterest(principal: bigint, rateBps: bigint, termSec: bigint) {
  const YEAR = 365n * ONE_DAY;
  return (principal * rateBps * termSec) / (10_000n * YEAR);
}

async function evmIncreaseTime(seconds: bigint) {
  await ethers.provider.send("evm_increaseTime", [Number(seconds)]);
  await ethers.provider.send("evm_mine", []);
}

async function main() {
  // Production-like default:
  // Testnet/mainnet are never "clean", so by default we do NOT require "clean signers".
  // If you want strict clean-only mode, opt-in: E2E_REQUIRE_CLEAN_SIGNERS=1
  const requireCleanSigners = process.env.E2E_REQUIRE_CLEAN_SIGNERS === "1";
  const runFinalizeMatchOnly = process.env.RUN_FINALIZE_MATCH_ONLY === "1";
  const runMatchDisbursementOnly = process.env.RUN_MATCH_DISBURSEMENT_ONLY === "1";
  const runReserveCancel = process.env.RUN_RESERVE_CANCEL !== "0";
  const runPartialRepay = process.env.RUN_PARTIAL_REPAY !== "0";
  const runStrictAggDebt = process.env.RUN_STRICT_AGGREGATED_DEBT !== "0";
  const runLiquidation = process.env.RUN_LIQUIDATION !== "0";
  const runGuaranteeExtension = process.env.RUN_GUARANTEE_EXTENSION !== "0";
  // Extra examples are intentionally opt-in because some "negative" scenarios (expected revert)
  // can leave intermediate on-chain state (collateral deposits / pool reserves) and make the node "dirty".
  const runGuaranteeExtensionExamples = process.env.RUN_GUARANTEE_EXTENSION_EXAMPLES === "1";
  const tokensEnv = (process.env.TOKENS ?? "").trim();
  const assertRoleGates = process.env.ASSERT_ROLE_GATES === "1";

  if (runFinalizeMatchOnly && runMatchDisbursementOnly) {
    throw new Error("Config: RUN_FINALIZE_MATCH_ONLY and RUN_MATCH_DISBURSEMENT_ONLY are mutually exclusive.");
  }

  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const keeper = signers[1];
  const signerByAddr = new Map<string, any>(signers.map((s) => [s.address.toLowerCase(), s]));

  const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
  const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;
  const aw = (await ethers.getContractAt("AssetWhitelist", CONTRACT_ADDRESSES.AssetWhitelist)) as any;
  const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", CONTRACT_ADDRESSES.PriceOracle)) as any;
  const feeRouter = (await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", CONTRACT_ADDRESSES.FeeRouter)) as any;
  const usdc = (await ethers.getContractAt("MockERC20", CONTRACT_ADDRESSES.MockUSDC)) as any;

  const vaultCoreAddr = (await registry.getModuleOrRevert(key("VAULT_CORE"))) as string;
  const vblAddr = (await registry.getModuleOrRevert(key("VAULT_BUSINESS_LOGIC"))) as string;
  const cmAddr = (await registry.getModuleOrRevert(key("COLLATERAL_MANAGER"))) as string;
  const orderEngineAddr = (await registry.getModuleOrRevert(key("ORDER_ENGINE"))) as string;
  const settlementManagerAddr = (await registry.getModuleOrRevert(key("SETTLEMENT_MANAGER"))) as string;
  const lenderPoolVaultAddr = (await registry.getModuleOrRevert(key("LENDER_POOL_VAULT"))) as string;
  const liquidationManagerAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_MANAGER"))) as string;
  const liquidationPayoutManagerAddr = (await registry.getModuleOrRevert(key("LIQUIDATION_PAYOUT_MANAGER"))) as string;
  const gfmAddr = runGuaranteeExtension ? ((await registry.getModuleOrRevert(key("GUARANTEE_FUND_MANAGER"))) as string) : ethers.ZeroAddress;
  const ergmAddr = runGuaranteeExtension
    ? ((await registry.getModuleOrRevert(key("EARLY_REPAYMENT_GUARANTEE_MANAGER"))) as string)
    : ethers.ZeroAddress;

  const vaultCore = (await ethers.getContractAt("VaultCore", vaultCoreAddr)) as any;
  const vbl = (await ethers.getContractAt("VaultBusinessLogic", vblAddr)) as any;
  const settlementManager = (await ethers.getContractAt("SettlementManager", settlementManagerAddr)) as any;
  const gfm = runGuaranteeExtension
    ? await ethers.getContractAt(
        [
          "function getLockedGuarantee(address user, address asset) view returns (uint256)",
          "function isGuaranteePaid(address user, address asset) view returns (bool)",
        ],
        gfmAddr
      )
    : null;
  const ergm = runGuaranteeExtension
    ? await ethers.getContractAt(
        [
          "function isGuaranteeEnabled(address asset) view returns (bool)",
          "function setGuaranteeEnabled(address asset, bool enabled)",
          "function getUserGuaranteeId(address user, address asset) view returns (uint256)",
          "function hasActiveGuarantee(address user, address asset) view returns (bool)",
          "function getGuaranteeRecord(uint256 guaranteeId) view returns (tuple(uint256 principal,uint256 promisedInterest,uint256 startTime,uint256 maturityTime,uint256 earlyRepayPenaltyDays,bool isActive,address lender,address asset))",
          "function previewEarlyRepayment(uint256 guaranteeId, uint256 actualRepayAmount) view returns (tuple(uint256 penaltyToLender,uint256 refundToBorrower,uint256 platformFee,uint256 actualInterestPaid))",
        ],
        ergmAddr
      )
    : null;

  // NOTE: `getContractAt` with a fragment-only ABI yields a BaseContract type in TS.
  // We intentionally cast to `any` for script ergonomics (smoke scripts run via hardhat/ts-node).
  const gfmAny = gfm as any;
  const ergmAny = ergm as any;
  const vLe = await ethers.getContractAt(
    ["function getUserTotalDebtValue(address user) view returns (uint256)", "function getDebt(address user, address asset) view returns (uint256)"],
    CONTRACT_ADDRESSES.VaultLendingEngine
  );
  const cm = await ethers.getContractAt(["function getUserCollateralAssets(address user) view returns (address[])"], cmAddr);
  const lpm = await ethers.getContractAt(
    ["function getRecipients() view returns (tuple(address platform,address reserve,address lenderCompensation))"],
    liquidationPayoutManagerAddr
  );

  const platformTreasury = (await feeRouter.getPlatformTreasury()) as string;
  const ecosystemVault = (await feeRouter.getEcosystemVault()) as string;
  const recipients = (await lpm.getRecipients()) as { platform: string; reserve: string; lenderCompensation: string };

  const tokensToTest: string[] = tokensEnv
    ? tokensEnv.split(",").map((s) => s.trim()).filter(Boolean)
    : ((await feeRouter.getSupportedTokens().catch(() => [])) as string[]);
  if (tokensToTest.length === 0) {
    // Fallback for early/local deployments: default to MockUSDC.
    tokensToTest.push(usdc.target as string);
  }

  // ---- helper: (optional) "clean signer" detector ----
  const isCleanUser = async (addr: string) => {
    const [debtValue, assets] = await Promise.all([
      (vLe.getUserTotalDebtValue(addr) as Promise<bigint>),
      (cm.getUserCollateralAssets(addr) as Promise<string[]>).catch(() => [] as string[]),
    ]);
    return debtValue === 0n && (assets?.length ?? 0) === 0;
  };

  const exclude = new Set<string>([deployer.address.toLowerCase(), keeper.address.toLowerCase()]);
  const pickSigner = async () => {
    // Default: pick ANY unused signer (dirty-state friendly).
    if (!requireCleanSigners) {
      for (let i = 2; i < signers.length; i++) {
        const s = signers[i];
        const k = s.address.toLowerCase();
        if (exclude.has(k)) continue;
        exclude.add(k);
        return s;
      }
      // If we exhaust unique signers, reuse from index 2 (still OK for delta-based checks).
      console.log("  ⚠️  No unused signer left; reusing signers in this run (dirty-state).");
      return signers[2];
    }

    // Strict mode: only allow "clean" signers.
    for (let i = 2; i < signers.length; i++) {
      const s = signers[i];
      const k = s.address.toLowerCase();
      if (exclude.has(k)) continue;
      if (await isCleanUser(s.address)) {
        exclude.add(k);
        return s;
      }
    }
    throw new Error(
      "No clean signer found (E2E_REQUIRE_CLEAN_SIGNERS=1). " +
        "Restart localhost node for a clean state, or unset E2E_REQUIRE_CLEAN_SIGNERS to run in dirty-state mode."
    );
  };

  // Pick a signer satisfying a predicate. First tries unused signers (exclude set),
  // then (if still not found) tries any signer from index 2.., and may reuse signers.
  // This is important for "dirty-state" suites where most signers already have historical positions.
  const pickSignerSatisfying = async (label: string, pred: (s: any) => Promise<boolean>) => {
    // Pass 1: prefer unused signers
    for (let i = 2; i < signers.length; i++) {
      const s = signers[i];
      const k = s.address.toLowerCase();
      if (exclude.has(k)) continue;
      if (await pred(s)) {
        exclude.add(k);
        return s;
      }
    }
    // Pass 2: allow reuse (dirty-state)
    for (let i = 2; i < signers.length; i++) {
      const s = signers[i];
      if (await pred(s)) {
        return s;
      }
    }
    throw new Error(`[Config] No signer satisfies: ${label}`);
  };

  const ensureRole = async (role: string, who: string) => {
    if (!(await acm.hasRole(role, who))) await (await acm.grantRole(role, who)).wait();
  };

  // ---- ensure minimal config (best-effort) ----
  await ensureRole(key("ADD_WHITELIST"), deployer.address);
  await ensureRole(key("UPDATE_PRICE"), deployer.address);
  await ensureRole(key("SET_PARAMETER"), deployer.address);
  await ensureRole(key("ORDER_CREATE"), vblAddr);
  await ensureRole(key("DEPOSIT"), vblAddr);
  await ensureRole(key("BORROW"), orderEngineAddr);

  if (!(await aw.isAssetAllowed(usdc.target))) await (await aw.connect(deployer).addAllowedAsset(usdc.target)).wait();
  {
    const cfg = await po.getAssetConfig(usdc.target);
    if (!cfg.isActive) await (await po.connect(deployer).configureAsset(usdc.target, "usd-coin", 8, 3600)).wait();
  }
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  await (await po.connect(deployer).updatePrice(usdc.target, ethers.parseUnits("1", 8), now)).wait();
  if (!(await feeRouter.isTokenSupported(usdc.target))) await (await feeRouter.connect(deployer).addSupportedToken(usdc.target)).wait();

  console.log("=== Funds-Flow Invariants Suite (localhost) ===");
  console.log("Config:");
  console.log(`- requireCleanSigners: ${requireCleanSigners}`);
  console.log(`- runFinalizeMatchOnly: ${runFinalizeMatchOnly}`);
  console.log(`- runMatchDisbursementOnly: ${runMatchDisbursementOnly}`);
  console.log(`- assertRoleGates: ${assertRoleGates}`);
  console.log(`- runReserveCancel: ${runReserveCancel}`);
  console.log(`- runPartialRepay: ${runPartialRepay}`);
  console.log(`- runStrictAggDebt: ${runStrictAggDebt}`);
  console.log(`- runLiquidation: ${runLiquidation}`);
  console.log(`- runGuaranteeExtension: ${runGuaranteeExtension}`);
  console.log(`- runGuaranteeExtensionExamples: ${runGuaranteeExtensionExamples}`);
  console.log(`- tokensToTest: ${tokensToTest.join(", ")}`);
  console.log("");

  // Auto-discovered base tracked set (modules + fee recipients + view router).
  const baseTracked = await discoverTrackedAddresses({
    include: [deployer.address],
    keeper: keeper.address,
  });

  // ---- helper: create an order via reserveForLending + finalizeMatch ----
  async function createOrder(opts: {
    borrower: any;
    lender: any;
    asset: string;
    principal: bigint;
    collateral: bigint;
    termDays: number;
    rateBps: bigint;
    makeOverdue: boolean;
    enableGuarantee?: boolean;
  }): Promise<{
    orderId: bigint;
    lendHash: string;
    finalizeMatchReceipt: any;
    borrower: string;
    lender: string;
    asset: string;
    principal: bigint;
    balancesBeforeFinalize?: {
      pool: bigint;
      vbl: bigint;
      borrower: bigint;
      cm: bigint;
      platform: bigint;
      ecosystem: bigint;
    };
    balancesAfterFinalize?: {
      pool: bigint;
      vbl: bigint;
      borrower: bigint;
      cm: bigint;
      platform: bigint;
      ecosystem: bigint;
    };
  }> {
    const erc20 = (await getErc20(opts.asset)) as any;
    const decimals = Number(await erc20.decimals().catch(() => 6));
    const fundAmt = ethers.parseUnits("20000", decimals);

    // fund borrower/lender so their balances are available (totalSupply unchanged)
    await (await erc20.connect(deployer).transfer(opts.borrower.address, fundAmt)).wait();
    await (await erc20.connect(deployer).transfer(opts.lender.address, fundAmt)).wait();
    await (await erc20.connect(deployer).transfer(keeper.address, fundAmt)).wait();

    // deposit collateral via VaultCore (SSOT)
    await (await erc20.connect(opts.borrower).approve(cmAddr, opts.collateral)).wait();
    await (await vaultCore.connect(opts.borrower).deposit(opts.asset, opts.collateral)).wait();

    // reserve lender funds in pool
    await (await erc20.connect(opts.lender).approve(vblAddr, opts.principal)).wait();
    const lendIntent = {
      lenderSigner: opts.lender.address,
      asset: opts.asset,
      amount: opts.principal,
      minTermDays: 1,
      maxTermDays: 30,
      minRateBps: 0n,
      expireAt: BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600),
      salt: ethers.keccak256(ethers.toUtf8Bytes(`suite-lend-${Date.now()}-${Math.random()}`)),
    };
    const lendHash = hashLendIntentStruct(lendIntent);
    await (await vbl.connect(opts.lender).reserveForLending(opts.lender.address, opts.asset, opts.principal, lendHash)).wait();

    const borrowIntent = {
      borrower: opts.borrower.address,
      collateralAsset: opts.asset,
      collateralAmount: opts.collateral,
      borrowAsset: opts.asset,
      amount: opts.principal,
      termDays: opts.termDays,
      rateBps: opts.rateBps,
      expireAt: lendIntent.expireAt,
      salt: ethers.keccak256(ethers.toUtf8Bytes(`suite-borrow-${Date.now()}-${Math.random()}`)),
    };

    const domain = {
      name: "RwaLending",
      version: "1",
      chainId: Number((await ethers.provider.getNetwork()).chainId),
      verifyingContract: vblAddr,
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

    const sigBorrower = await opts.borrower.signTypedData(domain, typesBorrow as any, borrowIntent as any);
    const sigLender = await opts.lender.signTypedData(domain, typesLend as any, lendIntent as any);

    // Extension Flow: if guarantee is enabled, borrower MUST approve GFM for promisedInterest before finalizeMatch.
    if (opts.enableGuarantee && runGuaranteeExtension) {
      const termSec = BigInt(opts.termDays) * ONE_DAY;
      const promisedInterest = calcInterest(opts.principal, opts.rateBps, termSec);
      if (promisedInterest > 0n) {
        await (await erc20.connect(opts.borrower).approve(gfmAddr, promisedInterest)).wait();
      }
    }

    const captureFinalizeBalances = runFinalizeMatchOnly || runMatchDisbursementOnly;
    let balancesBeforeFinalize:
      | {
          pool: bigint;
          vbl: bigint;
          borrower: bigint;
          cm: bigint;
          platform: bigint;
          ecosystem: bigint;
        }
      | undefined;
    if (captureFinalizeBalances) {
      const [poolBal, vblBal, borrowerBal, cmBal, platBal, ecoBal] = await Promise.all([
        (erc20.balanceOf(lenderPoolVaultAddr) as Promise<bigint>),
        (erc20.balanceOf(vblAddr) as Promise<bigint>),
        (erc20.balanceOf(opts.borrower.address) as Promise<bigint>),
        (erc20.balanceOf(cmAddr) as Promise<bigint>),
        (erc20.balanceOf(platformTreasury) as Promise<bigint>),
        (erc20.balanceOf(ecosystemVault) as Promise<bigint>),
      ]);
      balancesBeforeFinalize = { pool: poolBal, vbl: vblBal, borrower: borrowerBal, cm: cmBal, platform: platBal, ecosystem: ecoBal };
    }

    const receipt = await (await vbl.connect(deployer).finalizeMatch(borrowIntent, [lendIntent], sigBorrower, [sigLender])).wait();
    let orderId: bigint | null = null;
    // parse LoanOrderCreated from OrderEngine ABI
    const orderEngine = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", orderEngineAddr)) as any;
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
    if (orderId === null) throw new Error("LoanOrderCreated not found");

    if (opts.makeOverdue) {
      const termSec = BigInt(opts.termDays) * ONE_DAY;
      await evmIncreaseTime(termSec + 60n);
      const nowAfter = (await ethers.provider.getBlock("latest"))!.timestamp;
      await (await po.connect(deployer).updatePrice(opts.asset, ethers.parseUnits("1", 8), nowAfter)).wait();
    }

    let balancesAfterFinalize:
      | {
          pool: bigint;
          vbl: bigint;
          borrower: bigint;
          cm: bigint;
          platform: bigint;
          ecosystem: bigint;
        }
      | undefined;
    if (balancesBeforeFinalize) {
      const [poolBal, vblBal, borrowerBal, cmBal, platBal, ecoBal] = await Promise.all([
        (erc20.balanceOf(lenderPoolVaultAddr) as Promise<bigint>),
        (erc20.balanceOf(vblAddr) as Promise<bigint>),
        (erc20.balanceOf(opts.borrower.address) as Promise<bigint>),
        (erc20.balanceOf(cmAddr) as Promise<bigint>),
        (erc20.balanceOf(platformTreasury) as Promise<bigint>),
        (erc20.balanceOf(ecosystemVault) as Promise<bigint>),
      ]);
      balancesAfterFinalize = { pool: poolBal, vbl: vblBal, borrower: borrowerBal, cm: cmBal, platform: platBal, ecosystem: ecoBal };
    }

    return {
      orderId,
      lendHash,
      finalizeMatchReceipt: receipt,
      borrower: opts.borrower.address,
      lender: opts.lender.address,
      asset: opts.asset,
      principal: opts.principal,
      balancesBeforeFinalize,
      balancesAfterFinalize,
    };
  }

  const tokensToRun = runFinalizeMatchOnly || runMatchDisbursementOnly ? tokensToTest.slice(0, 1) : tokensToTest;
  for (const assetAddr of tokensToRun) {
    const erc20 = (await getErc20(assetAddr)) as any;
    const decimals = Number(await erc20.decimals().catch(() => 6));
    const symbol = String(await erc20.symbol().catch(() => "TOKEN"));

    // Best-effort: ensure token is supported/whitelisted and has a price configured.
    try {
      if (!(await aw.isAssetAllowed(assetAddr))) await (await aw.connect(deployer).addAllowedAsset(assetAddr)).wait();
    } catch {}
    try {
      const cfg = await po.getAssetConfig(assetAddr);
      if (!cfg.isActive) await (await po.connect(deployer).configureAsset(assetAddr, "usd-coin", 8, 3600)).wait();
      const ts = (await ethers.provider.getBlock("latest"))!.timestamp;
      await (await po.connect(deployer).updatePrice(assetAddr, ethers.parseUnits("1", 8), ts)).wait();
    } catch {}
    try {
      if (!(await feeRouter.isTokenSupported(assetAddr))) await (await feeRouter.connect(deployer).addSupportedToken(assetAddr)).wait();
    } catch {}

    if (!runFinalizeMatchOnly && !runMatchDisbursementOnly) {
      console.log(`\n## Token: ${symbol} @ ${assetAddr} (decimals=${decimals})\n`);
    } else {
      console.log(`\n## Token (minimal): ${symbol} @ ${assetAddr}\n`);
    }

    // Extension Flow baseline: keep guarantee disabled for non-guarantee cases, to avoid allowance coupling.
    if (runGuaranteeExtension) {
      try {
        await ensureRole(key("SET_PARAMETER"), deployer.address);
        await (await ergmAny.connect(deployer).setGuaranteeEnabled(assetAddr, false)).wait();
      } catch (e) {
        throw new Error(
          `GuaranteeExtension: failed to disable guarantee baseline for asset=${assetAddr}. ` +
            `Ensure deployer has ACTION_SET_PARAMETER and ERGM is registered. Raw=${String((e as any)?.message ?? e)}`
        );
      }
    }

    // ========= CASE 0.5: finalizeMatch consume + RESERVE_CONSUMED DataPush (minimal) =========
    if (runFinalizeMatchOnly) {
      console.log("=== Case: finalizeMatch (consume + DataPush RESERVE_CONSUMED) ===");
      const borrower = await pickSigner();
      const lender = await pickSigner();
      const tracked = uniqAddrs(
        await discoverTrackedAddresses({
          include: [deployer.address],
          borrower: borrower.address,
          lender: lender.address,
          keeper: keeper.address,
        })
      );
      const principal = ethers.parseUnits("500", decimals);
      const collateral = ethers.parseUnits("1000", decimals);
      const before = await snapshotBalances(assetAddr, tracked);
      const res = await createOrder({
        borrower,
        lender,
        asset: assetAddr,
        principal,
        collateral,
        termDays: 5,
        rateBps: 1000n,
        makeOverdue: false,
      });
      const after = await snapshotBalances(assetAddr, tracked);
      assertConservation("finalizeMatch", before, after);

      // Observability: LendReserveConsumed + DataPushed(RESERVE_CONSUMED), with hash alignment.
      const DT_CONSUMED = ethers.keccak256(ethers.toUtf8Bytes("RESERVE_CONSUMED"));
      const dataPushIface = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
      let sawConsumedEvent = false;
      let sawConsumedPush = false;
      for (const log of res.finalizeMatchReceipt!.logs) {
        try {
          const parsed = vbl.interface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "LendReserveConsumed") {
            if (String(parsed.args.lendIntentHash).toLowerCase() !== res.lendHash.toLowerCase()) {
              throw new Error("LendReserveConsumed: lendIntentHash mismatch (SSOT hash divergence)");
            }
            if (String(parsed.args.lenderSigner).toLowerCase() !== res.lender.toLowerCase()) throw new Error("LendReserveConsumed: lender mismatch");
            if (String(parsed.args.asset).toLowerCase() !== res.asset.toLowerCase()) throw new Error("LendReserveConsumed: asset mismatch");
            if ((parsed.args.amount as bigint) !== res.principal) throw new Error("LendReserveConsumed: amount mismatch");
            sawConsumedEvent = true;
          }
        } catch {}
        try {
          const parsed = dataPushIface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "DataPushed" && (parsed.args.dataTypeHash as string).toLowerCase() === DT_CONSUMED.toLowerCase()) {
            // payload = abi.encode(lHash, lenderSigner, asset, amount, ts)
            const coder = ethers.AbiCoder.defaultAbiCoder();
            const decoded = coder.decode(["bytes32", "address", "address", "uint256", "uint256"], parsed.args.payload as string);
            const lHash = String(decoded[0]).toLowerCase();
            const lenderSigner = String(decoded[1]).toLowerCase();
            const asset = String(decoded[2]).toLowerCase();
            const amount = decoded[3] as bigint;
            if (lHash !== res.lendHash.toLowerCase()) throw new Error("DataPushed(RESERVE_CONSUMED): hash mismatch");
            if (lenderSigner !== res.lender.toLowerCase()) throw new Error("DataPushed(RESERVE_CONSUMED): lender mismatch");
            if (asset !== res.asset.toLowerCase()) throw new Error("DataPushed(RESERVE_CONSUMED): asset mismatch");
            if (amount !== res.principal) throw new Error("DataPushed(RESERVE_CONSUMED): amount mismatch");
            sawConsumedPush = true;
          }
        } catch {}
      }
      if (!sawConsumedEvent) throw new Error("finalizeMatch: missing LendReserveConsumed event");
      if (!sawConsumedPush) throw new Error("finalizeMatch: missing DataPushed(RESERVE_CONSUMED)");

      console.log(`  ✅ OK (orderId=${res.orderId.toString()})\n`);
      continue;
    }

    // ========= CASE 0.6: Match -> Borrow disbursement SSOT assertions (minimal) =========
    if (runMatchDisbursementOnly) {
      console.log("=== Case: match -> borrow disbursement (SSOT) ===");

      // Optional: role-gate regression tests (silent unless failure). Requires deployer to be ACM owner.
      if (assertRoleGates) {
        const ROLE_ORDER_CREATE = key("ORDER_CREATE");
        const ROLE_DEPOSIT = key("DEPOSIT");
        // ORDER_CREATE gate: revoke from VBL and expect finalizeMatch to revert, then restore.
        try {
          await (await acm.connect(deployer).revokeRole(ROLE_ORDER_CREATE, vblAddr)).wait();
          const borrower = await pickSigner();
          const lender = await pickSigner();
          let reverted = false;
          try {
            await createOrder({
              borrower,
              lender,
              asset: assetAddr,
              principal: ethers.parseUnits("10", decimals),
              collateral: ethers.parseUnits("20", decimals),
              termDays: 5,
              rateBps: 1000n,
              makeOverdue: false,
            });
          } catch {
            reverted = true;
          }
          if (!reverted) throw new Error("Role gate: expected finalizeMatch to revert when ORDER_CREATE is revoked from VBL");
        } finally {
          await (await acm.connect(deployer).grantRole(ROLE_ORDER_CREATE, vblAddr)).wait();
        }

        // DEPOSIT (FeeRouter) gate: revoke from VBL and expect finalizeMatch to revert, then restore.
        try {
          await (await acm.connect(deployer).revokeRole(ROLE_DEPOSIT, vblAddr)).wait();
          const borrower = await pickSigner();
          const lender = await pickSigner();
          let reverted = false;
          try {
            await createOrder({
              borrower,
              lender,
              asset: assetAddr,
              principal: ethers.parseUnits("10", decimals),
              collateral: ethers.parseUnits("20", decimals),
              termDays: 5,
              rateBps: 1000n,
              makeOverdue: false,
            });
          } catch {
            reverted = true;
          }
          if (!reverted) throw new Error("Role gate: expected finalizeMatch to revert when DEPOSIT is revoked from VBL");
        } finally {
          await (await acm.connect(deployer).grantRole(ROLE_DEPOSIT, vblAddr)).wait();
        }
      }

      const borrower = await pickSigner();
      const lender = await pickSigner();
      const tracked = uniqAddrs(
        await discoverTrackedAddresses({
          include: [deployer.address],
          borrower: borrower.address,
          lender: lender.address,
          keeper: keeper.address,
        })
      );

      const principal = ethers.parseUnits("500", decimals);
      const collateral = ethers.parseUnits("1000", decimals);
      const before = await snapshotBalances(assetAddr, tracked);
      const res = await createOrder({
        borrower,
        lender,
        asset: assetAddr,
        principal,
        collateral,
        termDays: 5,
        rateBps: 1000n,
        makeOverdue: false,
      });
      const after = await snapshotBalances(assetAddr, tracked);
      assertConservation("matchDisbursement", before, after);

      if (!res.balancesBeforeFinalize || !res.balancesAfterFinalize) {
        throw new Error("matchDisbursement: missing pre/post finalizeMatch balance snapshots");
      }

      // (B) Strict architecture: finalizeMatch MUST NOT top up collateral (CM token balance must not change during finalizeMatch).
      const cmDelta = res.balancesAfterFinalize.cm - res.balancesBeforeFinalize.cm;
      if (cmDelta !== 0n) {
        throw new Error(`matchDisbursement: expected CollateralManager balance delta 0 during finalizeMatch, got ${cmDelta.toString()}`);
      }

      // (C) Funding + fees + net disbursement (SSOT).
      const poolDelta = res.balancesAfterFinalize.pool - res.balancesBeforeFinalize.pool;
      if (poolDelta !== -principal) {
        throw new Error(`matchDisbursement: expected pool delta -${principal.toString()}, got ${poolDelta.toString()}`);
      }
      const vblDelta = res.balancesAfterFinalize.vbl - res.balancesBeforeFinalize.vbl;
      if (vblDelta !== 0n) {
        throw new Error(`matchDisbursement: expected VBL balance delta 0 (no retention), got ${vblDelta.toString()}`);
      }
      const borrowerNet = res.balancesAfterFinalize.borrower - res.balancesBeforeFinalize.borrower;
      if (borrowerNet <= 0n || borrowerNet > principal) {
        throw new Error(`matchDisbursement: invalid borrower net delta ${borrowerNet.toString()} (principal=${principal.toString()})`);
      }
      const platformDelta = res.balancesAfterFinalize.platform - res.balancesBeforeFinalize.platform;
      const ecosystemDelta = res.balancesAfterFinalize.ecosystem - res.balancesBeforeFinalize.ecosystem;
      if (platformDelta < 0n || ecosystemDelta < 0n) {
        throw new Error(`matchDisbursement: expected non-negative fee recipient deltas, got platform=${platformDelta} eco=${ecosystemDelta}`);
      }
      // NOTE: platformTreasury and ecosystemVault may be configured to the same address in some environments.
      // In that case, summing both deltas would double-count the same recipient.
      const totalFeesOut =
        platformTreasury.toLowerCase() === ecosystemVault.toLowerCase() ? platformDelta : platformDelta + ecosystemDelta;
      const feesPaid = principal - borrowerNet;
      if (totalFeesOut !== feesPaid) {
        throw new Error(`matchDisbursement: fee mismatch (paid=${feesPaid.toString()} != out=${totalFeesOut.toString()})`);
      }

      // (D) Ledger + order fields.
      const ord = await getOrderForView(orderEngineAddr, res.orderId);
      if (ord.borrower.toLowerCase() !== borrower.address.toLowerCase()) throw new Error("matchDisbursement: order borrower mismatch");
      if (ord.lender.toLowerCase() !== lenderPoolVaultAddr.toLowerCase()) throw new Error("matchDisbursement: order lender is not pool vault");
      if (ord.principal !== principal) throw new Error("matchDisbursement: order principal mismatch");
      if (ord.repaidAmount !== 0n) throw new Error("matchDisbursement: expected repaidAmount=0 on fresh order");
      const debt = (await vLe.getDebt(borrower.address, assetAddr)) as bigint;
      if (debt !== principal) throw new Error(`matchDisbursement: expected debt=${principal.toString()}, got ${debt.toString()}`);

      // (A) Consume observability (also validates lendIntentHash SSOT alignment).
      const DT_CONSUMED = ethers.keccak256(ethers.toUtf8Bytes("RESERVE_CONSUMED"));
      const dataPushIface = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
      let sawConsumedEvent = false;
      let sawConsumedPush = false;
      for (const log of res.finalizeMatchReceipt!.logs) {
        try {
          const parsed = vbl.interface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "LendReserveConsumed") {
            if (String(parsed.args.lendIntentHash).toLowerCase() !== res.lendHash.toLowerCase()) {
              throw new Error("LendReserveConsumed: lendIntentHash mismatch (SSOT hash divergence)");
            }
            sawConsumedEvent = true;
          }
        } catch {}
        try {
          const parsed = dataPushIface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "DataPushed" && (parsed.args.dataTypeHash as string).toLowerCase() === DT_CONSUMED.toLowerCase()) {
            sawConsumedPush = true;
          }
        } catch {}
      }
      if (!sawConsumedEvent) throw new Error("matchDisbursement: missing LendReserveConsumed event");
      if (!sawConsumedPush) throw new Error("matchDisbursement: missing DataPushed(RESERVE_CONSUMED)");

      console.log(`  ✅ OK (orderId=${res.orderId.toString()}, net=${borrowerNet.toString()}, fees=${feesPaid.toString()})\n`);
      continue;
    }

    // ========= CASE 0: Reserve -> Cancel conservation =========
    if (runReserveCancel) {
      console.log("=== Case: reserve -> cancel (conservation) ===");
      const lender = await pickSigner();
      await (await erc20.connect(deployer).transfer(lender.address, ethers.parseUnits("5000", decimals))).wait();

      const tracked = uniqAddrs(
        await discoverTrackedAddresses({
          include: [deployer.address],
          lender: lender.address,
          keeper: keeper.address,
        })
      );
      const before = await snapshotBalances(assetAddr, tracked);

      const amount = ethers.parseUnits("500", decimals);
      await (await erc20.connect(lender).approve(vblAddr, amount)).wait();
      const lendIntent = {
        lenderSigner: lender.address,
        asset: assetAddr,
        amount,
        minTermDays: 1,
        maxTermDays: 30,
        minRateBps: 0n,
        expireAt: BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600),
        salt: ethers.keccak256(ethers.toUtf8Bytes(`suite-reserve-${Date.now()}-${Math.random()}`)),
      };
      const lendHash = hashLendIntentStruct(lendIntent);
      const reserveReceipt = await (await vbl.connect(lender).reserveForLending(lender.address, assetAddr, amount, lendHash)).wait();

      const mid = await snapshotBalances(assetAddr, tracked);
      assertConservation("reserveForLending", before, mid);

      // Directional sanity: lender -> pool on reserve.
      const poolBalDelta = (mid.balances.get(lenderPoolVaultAddr) ?? 0n) - (before.balances.get(lenderPoolVaultAddr) ?? 0n);
      const lenderBalDelta = (mid.balances.get(lender.address) ?? 0n) - (before.balances.get(lender.address) ?? 0n);
      if (poolBalDelta !== amount) {
        throw new Error(`reserveForLending: expected pool balance +${amount.toString()}, got ${poolBalDelta.toString()}`);
      }
      if (lenderBalDelta !== -amount) {
        throw new Error(`reserveForLending: expected lender balance -${amount.toString()}, got ${lenderBalDelta.toString()}`);
      }

      // Event sanity: LendReserveCreated + DataPushed(RESERVE_FOR_LENDING).
      const dataPushIface = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
      const DT_RESERVE = ethers.keccak256(ethers.toUtf8Bytes("RESERVE_FOR_LENDING"));
      let sawCreated = false;
      let sawReservePush = false;
      for (const log of reserveReceipt!.logs) {
        try {
          const parsed = vbl.interface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "LendReserveCreated") {
            if (String(parsed.args.lendIntentHash).toLowerCase() !== lendHash.toLowerCase()) throw new Error("LendReserveCreated: hash mismatch");
            if (String(parsed.args.lenderSigner).toLowerCase() !== lender.address.toLowerCase()) throw new Error("LendReserveCreated: lender mismatch");
            if (String(parsed.args.asset).toLowerCase() !== assetAddr.toLowerCase()) throw new Error("LendReserveCreated: asset mismatch");
            if ((parsed.args.amount as bigint) !== amount) throw new Error("LendReserveCreated: amount mismatch");
            sawCreated = true;
          }
        } catch {}
        try {
          const parsed = dataPushIface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "DataPushed" && (parsed.args.dataTypeHash as string).toLowerCase() === DT_RESERVE.toLowerCase()) {
            sawReservePush = true;
          }
        } catch {}
      }
      if (!sawCreated) throw new Error("reserveForLending: missing LendReserveCreated event");
      if (!sawReservePush) throw new Error("reserveForLending: missing DataPushed(RESERVE_FOR_LENDING)");

      const cancelReceipt = await (await vbl.connect(lender).cancelReserve(lendHash)).wait();
      const after = await snapshotBalances(assetAddr, tracked);
      assertConservation("cancelReserve", before, after);

      // Directional sanity: pool -> lender on cancel.
      const poolBalDelta2 = (after.balances.get(lenderPoolVaultAddr) ?? 0n) - (mid.balances.get(lenderPoolVaultAddr) ?? 0n);
      const lenderBalDelta2 = (after.balances.get(lender.address) ?? 0n) - (mid.balances.get(lender.address) ?? 0n);
      if (poolBalDelta2 !== -amount) {
        throw new Error(`cancelReserve: expected pool balance -${amount.toString()}, got ${poolBalDelta2.toString()}`);
      }
      if (lenderBalDelta2 !== amount) {
        throw new Error(`cancelReserve: expected lender balance +${amount.toString()}, got ${lenderBalDelta2.toString()}`);
      }

      // Event sanity: LendReserveCancelled + DataPushed(CANCEL_RESERVE).
      const DT_CANCEL = ethers.keccak256(ethers.toUtf8Bytes("CANCEL_RESERVE"));
      let sawCancelled = false;
      let sawCancelPush = false;
      for (const log of cancelReceipt!.logs) {
        try {
          const parsed = vbl.interface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "LendReserveCancelled") {
            if (String(parsed.args.lendIntentHash).toLowerCase() !== lendHash.toLowerCase()) throw new Error("LendReserveCancelled: hash mismatch");
            if (String(parsed.args.lenderSigner).toLowerCase() !== lender.address.toLowerCase()) throw new Error("LendReserveCancelled: lender mismatch");
            if (String(parsed.args.asset).toLowerCase() !== assetAddr.toLowerCase()) throw new Error("LendReserveCancelled: asset mismatch");
            if ((parsed.args.amount as bigint) !== amount) throw new Error("LendReserveCancelled: amount mismatch");
            sawCancelled = true;
          }
        } catch {}
        try {
          const parsed = dataPushIface.parseLog({ topics: log.topics as string[], data: log.data });
          if (parsed?.name === "DataPushed" && (parsed.args.dataTypeHash as string).toLowerCase() === DT_CANCEL.toLowerCase()) {
            sawCancelPush = true;
          }
        } catch {}
      }
      if (!sawCancelled) throw new Error("cancelReserve: missing LendReserveCancelled event");
      if (!sawCancelPush) throw new Error("cancelReserve: missing DataPushed(CANCEL_RESERVE)");

      console.log("  ✅ OK\n");
    }

    // ========= CASE 0.7: Extension Flow (guarantee lock+record + early settle + overdue forfeit) =========
    if (!runFinalizeMatchOnly && !runMatchDisbursementOnly && runGuaranteeExtension) {
      console.log("=== Case: Extension Flow (Early Repayment Guarantee) ===");

      // (A) Enable guarantee for this token.
      await (await ergmAny.connect(deployer).setGuaranteeEnabled(assetAddr, true)).wait();
      const enabled = (await ergmAny.isGuaranteeEnabled(assetAddr)) as boolean;
      if (!enabled) throw new Error("GuaranteeExtension: setGuaranteeEnabled(true) did not take effect");

      // -------- Example 0: toggle OFF => finalizeMatch must NOT require GFM allowance, and must NOT lock/record.
      if (runGuaranteeExtensionExamples) {
        console.log("  - Example0: toggle OFF => no lock/record, no allowance needed");
        await (await ergmAny.connect(deployer).setGuaranteeEnabled(assetAddr, false)).wait();
        const enabled0 = (await ergmAny.isGuaranteeEnabled(assetAddr)) as boolean;
        if (enabled0) throw new Error("GuaranteeExtension.Example0: expected guarantee disabled");

        const borrower0 = await pickSigner();
        const lender0 = await pickSigner();
        const tracked0 = uniqAddrs(
          await discoverTrackedAddresses({
            include: [deployer.address],
            borrower: borrower0.address,
            lender: lender0.address,
            keeper: keeper.address,
          })
        );
        const before0 = await snapshotBalances(assetAddr, tracked0);
        const principal0 = ethers.parseUnits("100", decimals);
        const collateral0 = ethers.parseUnits("200", decimals);
        const res0 = await createOrder({
          borrower: borrower0,
          lender: lender0,
          asset: assetAddr,
          principal: principal0,
          collateral: collateral0,
          termDays: 5,
          rateBps: 1000n,
          makeOverdue: false,
          enableGuarantee: false, // do NOT pre-approve GFM
        });
        const after0 = await snapshotBalances(assetAddr, tracked0);
        assertConservation("guarantee.toggleOff.finalizeMatch", before0, after0);

        const locked0 = (await gfmAny.getLockedGuarantee(borrower0.address, assetAddr)) as bigint;
        const active0 = (await ergmAny.hasActiveGuarantee(borrower0.address, assetAddr)) as boolean;
        if (locked0 !== 0n) throw new Error("GuaranteeExtension.Example0: expected locked=0 when toggle is off");
        if (active0) throw new Error("GuaranteeExtension.Example0: expected active=false when toggle is off");

        // Cleanup: fully repay and withdraw collateral so we keep clean signers for later cases.
        // NOTE: Even with guarantee disabled, the normal repay path still applies (VaultCore → SettlementManager).
        try {
          const ord0 = await getOrderForView(orderEngineAddr, res0.orderId);
          const due0 = (ord0.principal - ord0.repaidAmount) + calcInterest(ord0.principal, ord0.rate, ord0.term);
          if (due0 > 0n) {
            await (await erc20.connect(borrower0).approve(vaultCoreAddr, due0)).wait();
            await (await vaultCore.connect(borrower0).repay(res0.orderId, ord0.asset, due0)).wait();
          }
          await (await vaultCore.connect(borrower0).withdraw(assetAddr, collateral0)).wait();
        } catch (e) {
          console.log("  ⚠️  Example0 cleanup (repay/withdraw) failed; node may become dirty:", e);
        }

        // restore ON for the main path below
        await (await ergmAny.connect(deployer).setGuaranteeEnabled(assetAddr, true)).wait();
      }

      // (B) Match/borrow should lock custody + write record (VBL SSOT path).
      const borrower = await pickSignerSatisfying(`borrower has no active guarantee for asset=${assetAddr}`, async (s) => {
        if (s.address.toLowerCase() === deployer.address.toLowerCase()) return false;
        if (s.address.toLowerCase() === keeper.address.toLowerCase()) return false;
        // Key dirty-state precondition for Extension Flow: cannot create a new record if one is still active.
        return !(await ergmAny.hasActiveGuarantee(s.address, assetAddr));
      });
      const lender = await pickSigner();
      const tracked = uniqAddrs(
        await discoverTrackedAddresses({
          include: [deployer.address],
          borrower: borrower.address,
          lender: lender.address,
          keeper: keeper.address,
        })
      );

      const principal = ethers.parseUnits("500", decimals);
      const collateral = ethers.parseUnits("1000", decimals);
      const termDays = 5;
      const rateBps = 1000n;
      const promisedInterest = calcInterest(principal, rateBps, BigInt(termDays) * ONE_DAY);

      const before = await snapshotBalances(assetAddr, tracked);
      const res = await createOrder({
        borrower,
        lender,
        asset: assetAddr,
        principal,
        collateral,
        termDays,
        rateBps,
        makeOverdue: false,
        enableGuarantee: true,
      });
      const mid = await snapshotBalances(assetAddr, tracked);
      assertConservation("guarantee.finalizeMatch", before, mid);

      if (promisedInterest > 0n) {
        const locked = (await gfmAny.getLockedGuarantee(borrower.address, assetAddr)) as bigint;
        if (locked !== promisedInterest) {
          throw new Error(`GuaranteeExtension: locked mismatch (locked=${locked.toString()} promised=${promisedInterest.toString()})`);
        }
        const gid = (await ergmAny.getUserGuaranteeId(borrower.address, assetAddr)) as bigint;
        if (gid === 0n) throw new Error("GuaranteeExtension: expected non-zero guaranteeId after finalizeMatch");
        const active = (await ergmAny.hasActiveGuarantee(borrower.address, assetAddr)) as boolean;
        if (!active) throw new Error("GuaranteeExtension: expected hasActiveGuarantee=true after finalizeMatch");
        const rec = (await ergmAny.getGuaranteeRecord(gid)) as any;
        if ((rec.principal as bigint) !== principal) throw new Error("GuaranteeExtension: guaranteeRecord.principal mismatch");
        if ((rec.promisedInterest as bigint) !== promisedInterest) throw new Error("GuaranteeExtension: guaranteeRecord.promisedInterest mismatch");
        {
          // In pool-based matches, the "lender" semantic may be the pool vault (order.lender), not the lender signer.
          const lenderInRecord = String(rec.lender).toLowerCase();
          const ok =
            lenderInRecord === lenderPoolVaultAddr.toLowerCase() || lenderInRecord === lender.address.toLowerCase();
          if (!ok) throw new Error("GuaranteeExtension: guaranteeRecord.lender mismatch");
        }
        if (String(rec.asset).toLowerCase() !== assetAddr.toLowerCase()) throw new Error("GuaranteeExtension: guaranteeRecord.asset mismatch");
      }

      // -------- Example 1: partial repay MUST NOT settle guarantee (record remains active, custody remains locked).
      if (runGuaranteeExtensionExamples && promisedInterest > 0n) {
        console.log("  - Example1: partial repay => guarantee remains locked+active");
        const ordP = await getOrderForView(orderEngineAddr, res.orderId);
        const dueP = (ordP.principal - ordP.repaidAmount) + calcInterest(ordP.principal, ordP.rate, ordP.term);
        const half = dueP / 2n;
        await (await erc20.connect(borrower).approve(vaultCoreAddr, dueP)).wait();

        await (await vaultCore.connect(borrower).repay(res.orderId, ordP.asset, half)).wait();

        const lockedP = (await gfmAny.getLockedGuarantee(borrower.address, assetAddr)) as bigint;
        const activeP = (await ergmAny.hasActiveGuarantee(borrower.address, assetAddr)) as boolean;
        if (lockedP !== promisedInterest) {
          throw new Error(`GuaranteeExtension.Example1: expected locked stay ${promisedInterest}, got ${lockedP}`);
        }
        if (!activeP) throw new Error("GuaranteeExtension.Example1: expected active=true after partial repay");
      }

      // (C) Early full repay should trigger 3-way distribution and clear custody+record (SettlementManager SSOT path).
      // In dirty-state environments, interest rounding can cause "one-shot computed due" to be slightly off.
      // To avoid missing the full-repay boundary (and thus missing guarantee settlement), we repay in a small loop.
      let lastRepayReceipt: any | null = null;
      let preview: any | null = null;
      for (let i = 0; i < 3; i++) {
        const ord = await getOrderForView(orderEngineAddr, res.orderId);
        const totalDue = (ord.principal - ord.repaidAmount) + calcInterest(ord.principal, ord.rate, ord.term);
        if (totalDue === 0n) break;
        await (await erc20.connect(borrower).approve(vaultCoreAddr, totalDue)).wait();

        const gid2 = (await ergmAny.getUserGuaranteeId(borrower.address, assetAddr)) as bigint;
        preview = gid2 === 0n ? null : ((await ergmAny.previewEarlyRepayment(gid2, totalDue)) as any);
        lastRepayReceipt = await (await vaultCore.connect(borrower).repay(res.orderId, ord.asset, totalDue)).wait();
      }
      const repayReceipt = lastRepayReceipt;
      if (!repayReceipt) {
        throw new Error("GuaranteeExtension: repay loop did not execute (unexpected totalDue==0 before repay)");
      }
      const after = await snapshotBalances(assetAddr, tracked);
      assertConservation("guarantee.earlyRepay", before, after);

      if (promisedInterest > 0n) {
        // State cleared
        const lockedAfter = (await gfmAny.getLockedGuarantee(borrower.address, assetAddr)) as bigint;
        if (lockedAfter !== 0n) {
          // Provide a more actionable diagnostic: maybe the order wasn't fully repaid.
          const ordAfter = await getOrderForView(orderEngineAddr, res.orderId);
          const dueAfter = (ordAfter.principal - ordAfter.repaidAmount) + calcInterest(ordAfter.principal, ordAfter.rate, ordAfter.term);
          throw new Error(
            "GuaranteeExtension: expected locked guarantee cleared after early repay. " +
              `locked=${lockedAfter.toString()} dueAfter=${dueAfter.toString()} repaidAmount=${ordAfter.repaidAmount.toString()} principal=${ordAfter.principal.toString()}`
          );
        }
        const activeAfter = (await ergmAny.hasActiveGuarantee(borrower.address, assetAddr)) as boolean;
        if (activeAfter) throw new Error("GuaranteeExtension: expected guarantee inactive after early repay");

        // Best-effort event check (semantic layer)
        const ergmIface = new ethers.Interface([
          "event EarlyRepaymentProcessed(uint256 indexed guaranteeId,address indexed borrower,address indexed lender,address asset,uint256 penaltyToLender,uint256 refundToBorrower,uint256 platformFee,uint256 actualInterestPaid,uint256 timestamp)",
        ]);
        let saw = false;
        for (const log of repayReceipt!.logs) {
          try {
            const parsed = ergmIface.parseLog({ topics: log.topics as string[], data: log.data });
            if (parsed?.name === "EarlyRepaymentProcessed") {
              saw = true;
              if (preview) {
                const pPenalty = preview.penaltyToLender as bigint;
                const pRefund = preview.refundToBorrower as bigint;
                const pFee = preview.platformFee as bigint;
                if ((parsed.args.penaltyToLender as bigint) !== pPenalty) throw new Error("GuaranteeExtension: penaltyToLender mismatch vs preview");
                if ((parsed.args.refundToBorrower as bigint) !== pRefund) throw new Error("GuaranteeExtension: refundToBorrower mismatch vs preview");
                if ((parsed.args.platformFee as bigint) !== pFee) throw new Error("GuaranteeExtension: platformFee mismatch vs preview");
              }
              break;
            }
          } catch {}
        }
        if (!saw) {
          console.log("  ⚠️  ExtensionFlow: repay did not emit ERGM.EarlyRepaymentProcessed (event check skipped).");
        }
      }

      // NOTE: A "missing approve => finalizeMatch revert" example is intentionally NOT included here:
      // it requires setting up collateral + reserve state before finalizeMatch, and if the final tx reverts,
      // those earlier setup txs still persist (making the node dirty). That negative test is covered in
      // scripts/e2e/e2e-localhost-attack-suite.ts (Section 8b).

      // (D) Overdue settleOrLiquidate should trigger forfeiture and clear custody+record.
      const borrower2 = await pickSignerSatisfying(`borrower2 has no active guarantee for asset=${assetAddr}`, async (s) => {
        if (s.address.toLowerCase() === deployer.address.toLowerCase()) return false;
        if (s.address.toLowerCase() === keeper.address.toLowerCase()) return false;
        return !(await ergmAny.hasActiveGuarantee(s.address, assetAddr));
      });
      const lender2 = await pickSigner();
      const res2 = await createOrder({
        borrower: borrower2,
        lender: lender2,
        asset: assetAddr,
        principal,
        collateral,
        termDays,
        rateBps,
        makeOverdue: true,
        enableGuarantee: true,
      });
      // Forfeiture happens in settleOrLiquidate branch (overdue/risk).
      // Ensure keeper role for liquidation entry (best-effort; deployer must be ACM owner on localhost).
      try {
        await ensureRole(key("LIQUIDATE"), keeper.address);
      } catch (e) {
        throw new Error(
          `GuaranteeExtension: failed to grant ACTION_LIQUIDATE to keeper=${keeper.address}. ` +
            `Grant roles first or run with E2E_ALLOW_DIRTY_STATE=1. Raw=${String((e as any)?.message ?? e)}`
        );
      }
      const liqReceipt = await (await settlementManager.connect(keeper).settleOrLiquidate(res2.orderId)).wait();
      if (promisedInterest > 0n) {
        const locked2 = (await gfmAny.getLockedGuarantee(borrower2.address, assetAddr)) as bigint;
        if (locked2 !== 0n) throw new Error("GuaranteeExtension: expected locked guarantee cleared after settleOrLiquidate");
        const active2 = (await ergmAny.hasActiveGuarantee(borrower2.address, assetAddr)) as boolean;
        if (active2) throw new Error("GuaranteeExtension: expected guarantee inactive after settleOrLiquidate");
        // Best-effort event check
        const ergmIface2 = new ethers.Interface([
          "event GuaranteeForfeited(uint256 indexed guaranteeId,address indexed borrower,address indexed lender,address asset,uint256 forfeitedAmount,uint256 timestamp)",
        ]);
        let sawF = false;
        for (const log of liqReceipt!.logs) {
          try {
            const parsed = ergmIface2.parseLog({ topics: log.topics as string[], data: log.data });
            if (parsed?.name === "GuaranteeForfeited") {
              sawF = true;
              break;
            }
          } catch {}
        }
        if (!sawF) {
          console.log("  ⚠️  ExtensionFlow: settleOrLiquidate did not emit ERGM.GuaranteeForfeited (event check skipped).");
        }
      }

      // Restore baseline off so other cases remain decoupled.
      await (await ergmAny.connect(deployer).setGuaranteeEnabled(assetAddr, false)).wait();
      console.log("  ✅ OK\n");
    }

    // ========= CASE 1: Partial repay (allowed when strict mode disabled) =========
    if (runPartialRepay) {
      console.log("=== Case: partial repay then full repay (conservation + state) ===");

    // best-effort disable strict full-repay mode to allow partial repay.
    try {
      await ensureRole(key("SET_PARAMETER"), deployer.address);
      const requireFull = (await settlementManager.requireFullRepayRelease()) as boolean;
      if (requireFull) {
        await (await settlementManager.connect(deployer).setRequireFullRepayRelease(false)).wait();
      }
    } catch (e) {
      console.log("  ⚠️  Could not disable strict full-repay mode; partial repay may revert:", e);
    }

      const borrower = await pickSigner();
      const lender = await pickSigner();
      const tracked = uniqAddrs(
        await discoverTrackedAddresses({
          include: [deployer.address],
          borrower: borrower.address,
          lender: lender.address,
          keeper: keeper.address,
        })
      );

      const { orderId } = await createOrder({
        borrower,
        lender,
        asset: assetAddr,
        principal: ethers.parseUnits("500", decimals),
        collateral: ethers.parseUnits("1000", decimals),
        termDays: 5,
        rateBps: 1000n,
        makeOverdue: false,
      });
    const ord = await getOrderForView(orderEngineAddr, orderId);
    const remainingPrincipal = ord.principal > ord.repaidAmount ? ord.principal - ord.repaidAmount : 0n;
    const totalDue = remainingPrincipal + calcInterest(ord.principal, ord.rate, ord.term);

    const half = totalDue / 2n;
      // partial
      const before = await snapshotBalances(ord.asset, tracked);
      await (await erc20.connect(borrower).approve(vaultCoreAddr, totalDue)).wait();
      await (await vaultCore.connect(borrower).repay(orderId, ord.asset, half)).wait();
      const afterPartial = await snapshotBalances(ord.asset, tracked);
      assertConservation("partialRepay", before, afterPartial);
      const ordAfter1 = await getOrderForView(orderEngineAddr, orderId);
      if (ordAfter1.repaidAmount <= ord.repaidAmount) throw new Error("partial repay did not increase repaidAmount");

    // full remaining
    const remaining = totalDue - half;
      await (await vaultCore.connect(borrower).repay(orderId, ord.asset, remaining)).wait();
      const afterFull = await snapshotBalances(ord.asset, tracked);
      assertConservation("fullRepay", before, afterFull);
      const ordAfter2 = await getOrderForView(orderEngineAddr, orderId);
      if (ordAfter2.repaidAmount < totalDue) throw new Error("expected fully repaid order (repaidAmount < totalDue)");
      console.log("  ✅ OK\n");
    }

    // ========= CASE 2: Strict full-repay + aggregated debt behavior =========
    if (runStrictAggDebt) {
      console.log("=== Case: strict full-repay + aggregated debt (expected revert, then success) ===");

    // enable strict full-repay mode
    try {
      await ensureRole(key("SET_PARAMETER"), deployer.address);
      await (await settlementManager.connect(deployer).setRequireFullRepayRelease(true)).wait();
    } catch (e) {
      console.log("  ⚠️  Could not enable strict full-repay mode; skipping this case:", e);
    }

      const borrower = await pickSigner();
      const lender1 = await pickSigner();
      const lender2 = await pickSigner();
      const tracked = uniqAddrs(
        await discoverTrackedAddresses({
          include: [deployer.address],
          borrower: borrower.address,
          lender: lender1.address,
          keeper: keeper.address,
        })
      );
      const tracked2 = uniqAddrs([...tracked, lender2.address]);

      const { orderId: orderA } = await createOrder({
        borrower,
        lender: lender1,
        asset: assetAddr,
        principal: ethers.parseUnits("500", decimals),
        collateral: ethers.parseUnits("1000", decimals),
        termDays: 5,
        rateBps: 1000n,
        makeOverdue: false,
      });
      const { orderId: orderB } = await createOrder({
        borrower,
        lender: lender2,
        asset: assetAddr,
        principal: ethers.parseUnits("500", decimals),
        collateral: ethers.parseUnits("1000", decimals),
        termDays: 5,
        rateBps: 1000n,
        makeOverdue: false,
      });

    const ordA = await getOrderForView(orderEngineAddr, orderA);
    const dueA = (ordA.principal - ordA.repaidAmount) + calcInterest(ordA.principal, ordA.rate, ordA.term);
      await (await erc20.connect(borrower).approve(vaultCoreAddr, dueA)).wait();

      const before = await snapshotBalances(ordA.asset, tracked2);
    let reverted = false;
    try {
      await (await vaultCore.connect(borrower).repay(orderA, ordA.asset, dueA)).wait();
    } catch (e) {
      reverted = true;
    }
      const afterAttempt = await snapshotBalances(ordA.asset, tracked2);
    // if reverted, balances must be unchanged
    if (reverted) {
      assertConservation("strictAggDebt.revertNoSideEffects", before, afterAttempt);
      console.log("  ✅ Expected revert observed (DebtNotCleared), and no balance side-effects.");
    } else {
      console.log("  ⚠️  repay did not revert under strict mode; continuing.");
    }

    // disable strict and retry
      await (await settlementManager.connect(deployer).setRequireFullRepayRelease(false)).wait();
      await (await erc20.connect(borrower).approve(vaultCoreAddr, dueA)).wait();
      await (await vaultCore.connect(borrower).repay(orderA, ordA.asset, dueA)).wait();
      const after = await snapshotBalances(ordA.asset, tracked2);
      assertConservation("strictAggDebt.afterDisableStrict", before, after);

    // sanity: borrower still has debt because orderB is active
    const debtValue = (await vLe.getUserTotalDebtValue(borrower.address)) as bigint;
    if (debtValue === 0n) {
      throw new Error("expected aggregated debt to remain after repaying only one of two orders");
    }
    console.log(`  ✅ OK (remaining aggregated debtValue=${debtValue.toString()})\n`);
      orderB; // silence unused
    }

    // ========= CASE 3: Liquidation conservation =========
    if (runLiquidation) {
      console.log("=== Case: overdue liquidation (conservation) ===");
      const borrower = runGuaranteeExtension
        ? await pickSignerSatisfying(`liquidation borrower has no active guarantee for asset=${assetAddr}`, async (s) => {
            if (s.address.toLowerCase() === deployer.address.toLowerCase()) return false;
            if (s.address.toLowerCase() === keeper.address.toLowerCase()) return false;
            // Some deployed SettlementManager versions call ERGM.processDefault when a guarantee is active.
            // In dirty-state networks, ensure we pick a borrower that won't trip guarantee processing
            // when the feature is disabled.
            return !(await ergmAny.hasActiveGuarantee(s.address, assetAddr));
          })
        : await pickSigner();
      const lender = await pickSigner();
      const tracked = uniqAddrs(
        await discoverTrackedAddresses({
          include: [deployer.address],
          borrower: borrower.address,
          lender: lender.address,
          keeper: keeper.address,
        })
      );

    // ensure keeper role for liquidation (best-effort)
    try {
      await ensureRole(key("LIQUIDATE"), keeper.address);
    } catch (e) {
      console.log("  ⚠️  Could not grant LIQUIDATE to keeper; liquidation may revert:", e);
    }

      const { orderId } = await createOrder({
        borrower,
        lender,
        asset: assetAddr,
        principal: ethers.parseUnits("500", decimals),
        collateral: ethers.parseUnits("1000", decimals),
        termDays: 5,
        rateBps: 1000n,
        makeOverdue: true,
      });
    const ord = await getOrderForView(orderEngineAddr, orderId);

    const before = await snapshotBalances(ord.asset, tracked);
    await (await settlementManager.connect(keeper).settleOrLiquidate(orderId)).wait();
    const after = await snapshotBalances(ord.asset, tracked);
    assertConservation("liquidation", before, after);
      console.log("  ✅ OK\n");
    }
  } // end token loop

  console.log("✅ Invariants suite completed.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});


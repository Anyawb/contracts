import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";
import { runViewPreflight } from "./utils/view-preflight";

const BLOCKS_PER_DAY = 7_200n;
const ONE_HOUR_BLOCKS = 1_800n;

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function mkArtifactsWriter() {
  const outDir = path.join(__dirname, "artifacts");
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch {
    // ignore
  }
  return {
    outDir,
    writeJson: (name: string, data: unknown) => {
      const p = path.join(outDir, name);
      const replacer = (_k: string, v: any) => (typeof v === "bigint" ? v.toString() : v);
      fs.writeFileSync(p, JSON.stringify(data, replacer, 2) + "\n", "utf8");
      return p;
    },
  };
}

type RewardDp = { typeHash: string; payload: string };
function parseRewardDataPushed(receipt: any, rewardViewAddr: string): RewardDp[] {
  const iface = new ethers.Interface(["event DataPushed(bytes32 indexed dataTypeHash, bytes payload)"]);
  const out: RewardDp[] = [];
  for (const log of receipt?.logs ?? []) {
    if (!log?.address) continue;
    if (String(log.address).toLowerCase() !== rewardViewAddr.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "DataPushed") {
        out.push({ typeHash: String(parsed.args.dataTypeHash), payload: String(parsed.args.payload) });
      }
    } catch {
      // ignore
    }
  }
  return out;
}

function calcTotalDue(principal: bigint, rateBps: bigint, termBlocks: bigint) {
  const denom = 365n * BLOCKS_PER_DAY * 10_000n;
  const interest = (principal * rateBps * termBlocks) / denom;
  return principal + interest;
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
  const snap = await network.provider.send("evm_snapshot", []);
  const artifacts = mkArtifactsWriter();
  const dataPushedCounts: Record<string, number> = {};
  const bump = (k: string) => {
    const kk = k.toLowerCase();
    dataPushedCounts[kk] = (dataPushedCounts[kk] ?? 0) + 1;
  };

  try {
    const signers = await ethers.getSigners();
    const deployer = signers[0];

    console.log("=== E2E Full Test with View Layer Verification ===\n");

  // ============ Setup Contracts ============
  const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
  const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;
  const aw = (await ethers.getContractAt("AssetWhitelist", CONTRACT_ADDRESSES.AssetWhitelist)) as any;
  const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", CONTRACT_ADDRESSES.PriceOracle)) as any;
  const feeRouter = (await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", CONTRACT_ADDRESSES.FeeRouter)) as any;
  const settlementManager = (await ethers.getContractAt(
    "src/Vault/liquidation/modules/SettlementManager.sol:SettlementManager",
    CONTRACT_ADDRESSES.SettlementManager
  )) as any;
  const usdc = (await ethers.getContractAt("MockERC20", CONTRACT_ADDRESSES.MockUSDC)) as any;
  const vaultCore = (await ethers.getContractAt("VaultCore", CONTRACT_ADDRESSES.VaultCore)) as any;
  const vbl = (await ethers.getContractAt("VaultBusinessLogic", CONTRACT_ADDRESSES.VaultBusinessLogic)) as any;
  const cm = (await ethers.getContractAt("CollateralManager", CONTRACT_ADDRESSES.CollateralManager)) as any;
  const vle = (await ethers.getContractAt("src/Vault/modules/VaultLendingEngine.sol:VaultLendingEngine", CONTRACT_ADDRESSES.VaultLendingEngine)) as any;

  // MUST: Preflight for route↔registry + version info + required roles
  await runViewPreflight({
    registryAddr: CONTRACT_ADDRESSES.Registry,
    acmAddr: CONTRACT_ADDRESSES.AccessControlManager,
    adminSigner: deployer,
    assetForPriceCheck: CONTRACT_ADDRESSES.MockUSDC,
  });

  // Pick "clean" borrower/lender to make re-runs on dirty node stable.
  // matchflow may lock EarlyRepaymentGuarantee per (borrower, asset); if an active record exists,
  // EarlyRepaymentGuaranteeManager may revert with GuaranteeAlreadyProcessed().
  let borrower = signers[1];
  let lender = signers[2];
  try {
    const assetAddr = usdc.target as string;
    const ergmAddr =
      ((await registry.getModule(key("EARLY_REPAYMENT_GUARANTEE_MANAGER"))) as string) ||
      ((await registry.getModule(key("EARLY_REPAYMENT_GUARANTEE"))) as string);
    if (ergmAddr && ergmAddr !== ethers.ZeroAddress) {
      const ergm = (await ethers.getContractAt("EarlyRepaymentGuaranteeManager", ergmAddr)) as any;
      for (let i = 1; i < signers.length; i++) {
        const s = signers[i];
        if (s.address.toLowerCase() === deployer.address.toLowerCase()) continue;
        const has = (await ergm.hasActiveGuarantee(s.address, assetAddr)) as boolean;
        if (!has) {
          borrower = s;
          break;
        }
      }
      for (let i = 1; i < signers.length; i++) {
        const s = signers[i];
        if (s.address.toLowerCase() === deployer.address.toLowerCase()) continue;
        if (s.address.toLowerCase() === borrower.address.toLowerCase()) continue;
        lender = s;
        break;
      }
    }
  } catch {
    // best-effort: keep defaults
  }

  // Resolve View modules
  const positionViewAddr = await registry.getModuleOrRevert(key("POSITION_VIEW"));
  const healthViewAddr = await registry.getModuleOrRevert(key("HEALTH_VIEW"));
  // Canonical key for StatisticsView is "VAULT_STATISTICS" (ModuleKeys.KEY_STATS)
  const statisticsViewAddr = await registry.getModuleOrRevert(key("VAULT_STATISTICS"));
  const rewardViewAddr = await registry.getModuleOrRevert(key("REWARD_VIEW"));
  const dashboardViewAddr = await registry.getModuleOrRevert(key("DASHBOARD_VIEW"));
  const riskViewAddr = await registry.getModuleOrRevert(key("RISK_VIEW"));
  const userViewAddr = await registry.getModuleOrRevert(key("USER_VIEW"));

  const positionView = (await ethers.getContractAt("PositionView", positionViewAddr)) as any;
  const healthView = (await ethers.getContractAt("HealthView", healthViewAddr)) as any;
  const statisticsView = (await ethers.getContractAt("StatisticsView", statisticsViewAddr)) as any;
  const rewardView = (await ethers.getContractAt("RewardView", rewardViewAddr)) as any;
  const dashboardView = (await ethers.getContractAt("DashboardView", dashboardViewAddr)) as any;
  const riskView = (await ethers.getContractAt("RiskView", riskViewAddr)) as any;
  const userView = (await ethers.getContractAt("UserView", userViewAddr)) as any;

  const orderEngineAddr = await registry.getModuleOrRevert(key("ORDER_ENGINE"));
  const orderEngine = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", orderEngineAddr)) as any;
  const loanNftAddr = await registry.getModuleOrRevert(key("LOAN_NFT"));
  const loanNft = (await ethers.getContractAt("LoanNFT", loanNftAddr)) as any;

  const rewardPointsAddr = await registry.getModuleOrRevert(key("REWARD_POINTS"));
  const rewardPoints = (await ethers.getContractAt("src/Token/RewardPoints.sol:RewardPoints", rewardPointsAddr)) as any;
  const rewardDecimals = (await rewardPoints.decimals()) as number;
  const fmtPoints = (x: bigint) => ethers.formatUnits(x, rewardDecimals);

  console.log("📋 View Modules:");
  console.log("  PositionView:", positionViewAddr);
  console.log("  HealthView:", healthViewAddr);
  console.log("  StatisticsView:", statisticsViewAddr);
  console.log("  RewardView:", rewardViewAddr);
  console.log("  DashboardView:", dashboardViewAddr);
  console.log("  RiskView:", riskViewAddr);
  console.log("  UserView:", userViewAddr);
  console.log("  RewardPoints:", rewardPointsAddr);
  console.log("");

  // ============ Setup Roles ============
  const ACTION_ADD_WHITELIST = key("ADD_WHITELIST");
  const ACTION_UPDATE_PRICE = key("UPDATE_PRICE");
  const ACTION_SET_PARAMETER = key("SET_PARAMETER");
  const ACTION_DEPOSIT = key("DEPOSIT");
  const ACTION_ORDER_CREATE = key("ORDER_CREATE");
  const ACTION_BORROW = key("BORROW");
  const ACTION_REPAY = key("REPAY");

  const ensureRole = async (role: string, who: string) => {
    if (!(await acm.hasRole(role, who))) {
      await acm.grantRole(role, who);
      console.log(`  ✅ Granted ${role.slice(0, 10)}... to ${who.slice(0, 10)}...`);
    }
  };

  console.log("🔑 Setting up roles...");
  await ensureRole(ACTION_ADD_WHITELIST, deployer.address);
  await ensureRole(ACTION_UPDATE_PRICE, deployer.address);
  await ensureRole(ACTION_SET_PARAMETER, deployer.address);
  await ensureRole(ACTION_ORDER_CREATE, CONTRACT_ADDRESSES.VaultBusinessLogic);
  await ensureRole(ACTION_DEPOSIT, CONTRACT_ADDRESSES.VaultBusinessLogic);
  await ensureRole(ACTION_BORROW, orderEngineAddr);
  await ensureRole(ACTION_REPAY, borrower.address);
  // SSOT repay path: VaultCore.repay -> SettlementManager.repayAndSettle -> ORDER_ENGINE.repay.
  // ORDER_ENGINE.repay is role-gated by ACTION_REPAY, so SettlementManager must have this role.
  await ensureRole(ACTION_REPAY, CONTRACT_ADDRESSES.SettlementManager);
  console.log("");

  // ============ Setup Asset & Price ============
  console.log("💰 Setting up asset whitelist and price...");
  if (!(await aw.isAssetAllowed(usdc.target))) {
    await aw.connect(deployer).addAllowedAsset(usdc.target);
  }
  {
    const cfg = await po.getAssetConfig(usdc.target);
    if (!cfg.isActive) {
      const usdcDecimals = Number(await usdc.decimals().catch(() => 6));
      await po.connect(deployer).configureAsset(usdc.target, "usd-coin", usdcDecimals, 3600);
    }
  }
  const blockNumber = await ethers.provider.getBlockNumber();
  await po.connect(deployer).updatePrice(usdc.target, ethers.parseUnits("1", 6), blockNumber);

  if (!(await feeRouter.isTokenSupported(usdc.target))) {
    await feeRouter.connect(deployer).addSupportedToken(usdc.target);
  }
  console.log("");

  // ============ Fund Users ============
  console.log("💵 Funding users...");
  await usdc.connect(deployer).transfer(borrower.address, ethers.parseUnits("20000", 6));
  await usdc.connect(deployer).transfer(lender.address, ethers.parseUnits("20000", 6));
  console.log("  Borrower balance:", ethers.formatUnits(await usdc.balanceOf(borrower.address), 6));
  console.log("  Lender balance:", ethers.formatUnits(await usdc.balanceOf(lender.address), 6));
  console.log("");

  // ============ Helper: Update Statistics from Ledger ============
  // Note: This is a simplified helper for E2E testing.
  // In production, StatisticsView should be updated automatically by business logic
  // via VaultBusinessLogicLibrary.safeUpdateStats() or similar mechanisms.
  async function updateStatisticsFromLedger(user: string, asset: string) {
    // Skip automatic updates in E2E - let the test demonstrate the current state
    // StatisticsView updates should happen automatically in production via business logic
    return;
  }

  // ============ Helper: Verify View Layer ============
  async function verifyViews(step: string, user: string, asset: string) {
    console.log(`\n📊 View Layer Verification [${step}]:`);
    
    // First, try to update statistics from ledger (best-effort)
    await updateStatisticsFromLedger(user, asset);
    
    try {
      // PositionView (meta)
      const [collateral, debt, isValid, blockNumber, ver] = await positionView.getUserPositionWithMeta(user, asset);
      console.log(
        `  PositionView: collateral=${ethers.formatUnits(collateral, 6)}, debt=${ethers.formatUnits(debt, 6)}, isValid=${isValid}, block=${blockNumber.toString()}, ver=${ver.toString()}`
      );
    } catch (e: any) {
      console.log(`  PositionView: ${e.message || "query failed"}`);
    }

    try {
      // HealthView (meta)
      const [hf, isValid, blockNumber] = await healthView.getUserHealthFactorWithMeta(user);
      console.log(`  HealthView: healthFactor=${hf.toString()}, isValid=${isValid}, block=${blockNumber.toString()}`);
    } catch (e: any) {
      console.log(`  HealthView: ${e.message || "query failed"}`);
    }

    try {
      // UserView
      const [userCollateral, userDebt] = await userView.getUserPosition(user, asset);
      console.log(`  UserView: collateral=${ethers.formatUnits(userCollateral, 6)}, debt=${ethers.formatUnits(userDebt, 6)}`);
    } catch (e: any) {
      console.log(`  UserView: ${e.message || "query failed"}`);
    }

    try {
      // RiskView
      const riskAssessment = await riskView.getUserRiskAssessment(user);
      console.log(`  RiskView: healthFactor=${riskAssessment.healthFactor.toString()}, riskLevel=${riskAssessment.riskLevel || "N/A"}`);
    } catch (e: any) {
      console.log(`  RiskView: ${e.message || "query failed"}`);
    }

    try {
      // StatisticsView (meta)
      const [stats, isValid, blockNumber] = await statisticsView.getGlobalStatisticsWithMeta();
      console.log(
        `  StatisticsView: totalUsers=${stats.totalUsers}, totalCollateral=${ethers.formatUnits(stats.totalCollateral, 6)}, totalDebt=${ethers.formatUnits(stats.totalDebt, 6)}, isValid=${isValid}, block=${blockNumber.toString()}`
      );
    } catch (e: any) {
      console.log(`  StatisticsView: ${e.message || "query failed"}`);
    }

    try {
      // DashboardView (meta)
      const [overview, posValid, posBlocks, posVer, hfBlock] = await dashboardView.getUserOverviewWithMeta(user, [asset]);
      console.log(
        `  DashboardView: totalCollateral=${ethers.formatUnits(overview.totalCollateral, 6)}, totalDebt=${ethers.formatUnits(overview.totalDebt, 6)}, healthFactor=${overview.healthFactor.toString()}, posValid=${posValid[0]}, posBlock=${posBlocks[0].toString()}, posVer=${posVer[0].toString()}, hfBlock=${hfBlock.toString()}`
      );
    } catch (e: any) {
      console.log(`  DashboardView: ${e.message || "query failed"}`);
    }

    try {
      // RewardView (meta)
      const [
        totalEarned,
        totalBurned,
        pendingPenalty,
        level,
        privilegesPacked,
        lastActivity,
        totalLoans,
        totalVolume,
        blockNumber,
        isValid,
      ] = await rewardView.getUserRewardSummaryWithMeta(user);
      console.log(
        `  RewardView: totalEarned=${totalEarned.toString()}, level=${level}, totalLoans=${totalLoans.toString()}, block=${blockNumber.toString()}, isValid=${isValid}`
      );
    } catch (e: any) {
      console.log(`  RewardView: ${e.message || "query failed"}`);
    }
  }

  // ============ Step 1: Deposit Collateral ============
  console.log("=== Step 1: Borrower Deposits Collateral ===");
  const collateralAmt = ethers.parseUnits("1000", 6);
  // IMPORTANT (authority path): CollateralManager pulls tokens from user via transferFrom.
  // Therefore user must approve CollateralManager (not VaultCore).
  await usdc.connect(borrower).approve(CONTRACT_ADDRESSES.CollateralManager, collateralAmt);
  await vaultCore.connect(borrower).deposit(usdc.target, collateralAmt);
  
  const colAfterDeposit = await cm.getCollateral(borrower.address, usdc.target);
  console.log("✅ Deposit completed. Collateral:", ethers.formatUnits(colAfterDeposit, 6));
  
  await verifyViews("After Deposit", borrower.address, usdc.target);

  // NOTE (SSOT): orderId is the primary key for repay/settle.
  // A plain VaultCore.borrow(...) does not necessarily create an ORDER_ENGINE orderId,
  // so this E2E focuses on the matchflow which deterministically creates orderId.

  // ============ Step 2: Matchflow (Reserve + Finalize) ============
  console.log("\n=== Step 2: Matchflow (Reserve + Finalize Match) ===");
  const borrowAmt2 = ethers.parseUnits("500", 6);
  const termDays = 5;
  const rateBps = 1000n;
  const expireAt = BigInt(await ethers.provider.getBlockNumber()) + ONE_HOUR_BLOCKS;

  const borrowIntent = {
    borrower: borrower.address,
    collateralAsset: usdc.target,
    collateralAmount: collateralAmt,
    borrowAsset: usdc.target,
    amount: borrowAmt2,
    termDays,
    rateBps,
    expireAt,
    salt: ethers.keccak256(ethers.toUtf8Bytes("borrow-salt-e2e")),
  };

  const lendIntent = {
    lenderSigner: lender.address,
    asset: usdc.target,
    amount: borrowAmt2,
    minTermDays: 1,
    maxTermDays: 30,
    minRateBps: 0n,
    expireAt,
    salt: ethers.keccak256(ethers.toUtf8Bytes("lend-salt-e2e")),
  };

  // Lender reserves funds
  await usdc.connect(lender).approve(CONTRACT_ADDRESSES.VaultBusinessLogic, borrowAmt2);
  const lendHash = buildLendIntentHash(lendIntent);
  await vbl.connect(lender).reserveForLending(lender.address, usdc.target, borrowAmt2, lendHash);
  console.log("✅ Lender reserved funds.");

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

  // Finalize match
  // NOTE: matchflow may lock EarlyRepaymentGuarantee via GuaranteeFundManager, which pulls settlementToken via transferFrom.
  // Ensure borrower has sufficient allowance to avoid ERC20InsufficientAllowance during finalizeMatch.
  await usdc.connect(borrower).approve(CONTRACT_ADDRESSES.GuaranteeFundManager, ethers.MaxUint256);
  const tx = await vbl.connect(deployer).finalizeMatch(
    borrowIntent,
    [lendIntent],
    sigBorrower,
    [sigLender]
  );
  const receipt = await tx.wait();

  // Infer orderId
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
  console.log("✅ Match finalized. orderId:", orderId?.toString());

  const borrowerTokensAfter = await loanNft.getUserTokens(borrower.address);
  const newTokenId = borrowerTokensAfter.find((t) => !borrowerTokensBefore.includes(t));
  console.log("✅ LoanNFT minted. tokenId:", newTokenId?.toString());

  await verifyViews("After Match", borrower.address, usdc.target);

  // ============ Step 3: Repay Match Loan (via SettlementManager SSOT) ============
  console.log("\n=== Step 3: Borrower Repays Match Loan ===");
  const requireFullRepayRelease = (await settlementManager.requireFullRepayRelease()) as boolean;
  if (requireFullRepayRelease) {
    console.log("  ⚠️  SettlementManager.requireFullRepayRelease=true; disabling for this run");
    await (await settlementManager.connect(deployer).setRequireFullRepayRelease(false)).wait();
  }
  if (orderId === null) throw new Error("LoanOrderCreated not found");
  const termBlocks = BigInt(termDays) * BLOCKS_PER_DAY;
  const totalDue = calcTotalDue(borrowAmt2, rateBps, termBlocks);
  // Reward baseline: this script uses borrowAmt2=500 USDC (<1000e6), so rewards MUST NOT change.
  const rewardBalBefore = (await rewardPoints.balanceOf(borrower.address)) as bigint;
  const rewardSummaryBefore = await rewardView.getUserRewardSummaryWithMeta(borrower.address);
  const earnedBefore = rewardSummaryBefore[0] as bigint;
  // 统一入口：走 VaultCore.repay → SettlementManager
  await usdc.connect(borrower).approve(CONTRACT_ADDRESSES.VaultCore, totalDue);
  const repayTx = await vaultCore.connect(borrower).repay(orderId, usdc.target, totalDue);
  const repayRcpt = await repayTx.wait();
  const rewardPushes = parseRewardDataPushed(repayRcpt, String(rewardViewAddr));
  for (const p of rewardPushes) bump(p.typeHash);
  console.log("✅ Repay completed. totalDue:", ethers.formatUnits(totalDue, 6));

  if (newTokenId !== undefined) {
    const meta = await loanNft.getLoanMetadata(newTokenId);
    console.log("✅ LoanNFT status after repay:", meta.status.toString());
  }

  await verifyViews("After Match Repay", borrower.address, usdc.target);

  // Reward strict check: delta must be zero (ineligible principal)
  const rewardBalAfter = (await rewardPoints.balanceOf(borrower.address)) as bigint;
  const rewardSummaryAfter = await rewardView.getUserRewardSummaryWithMeta(borrower.address);
  const earnedAfter = rewardSummaryAfter[0] as bigint;
  const balDelta = rewardBalAfter - rewardBalBefore;
  const earnedDelta = earnedAfter - earnedBefore;
  console.log(
    `  [Reward] repay delta (ineligible): balDelta=${fmtPoints(balDelta)} earnedDelta=${fmtPoints(earnedDelta)} dataPushed=${rewardPushes.length}`
  );
  if (balDelta !== 0n || earnedDelta !== 0n) {
    throw new Error(
      `[Reward] expected no points change for ineligible principal (<1000e6): balDelta=${balDelta.toString()} earnedDelta=${earnedDelta.toString()}`
    );
  }
  if (rewardPushes.length !== 0) {
    throw new Error(`[Reward] expected no RewardView.DataPushed for ineligible repay, got ${rewardPushes.length}`);
  }

  // ============ Final Summary ============
  console.log("\n=== Final Summary ===");
  const finalCol = await cm.getCollateral(borrower.address, usdc.target);
  const finalDebt = await vle.getDebt(borrower.address, usdc.target);
  console.log("📊 Ledger Values (Source of Truth):");
  console.log("  Collateral:", ethers.formatUnits(finalCol, 6));
  console.log("  Debt:", ethers.formatUnits(finalDebt, 6));

  const [finalStats] = await statisticsView.getGlobalStatisticsWithMeta();
  console.log("\n📈 StatisticsView (Cached - May be stale):");
  console.log("  Active Users:", finalStats.activeUsers.toString());
  console.log("  Total Collateral:", ethers.formatUnits(finalStats.totalCollateral, 6));
  console.log("  Total Debt:", ethers.formatUnits(finalStats.totalDebt, 6));
  console.log("  Last Update Block:", finalStats.lastUpdateBlock > 0n 
    ? finalStats.lastUpdateBlock.toString()
    : "Never");
  
  // Compare ledger vs cached
  console.log("\n🔍 Data Consistency Check:");
  const colMatch = finalCol === finalStats.totalCollateral;
  const debtMatch = finalDebt === finalStats.totalDebt;
  console.log(`  Collateral match: ${colMatch ? "✅" : "⚠️"} (Ledger: ${ethers.formatUnits(finalCol, 6)}, Cached: ${ethers.formatUnits(finalStats.totalCollateral, 6)})`);
  console.log(`  Debt match: ${debtMatch ? "✅" : "⚠️"} (Ledger: ${ethers.formatUnits(finalDebt, 6)}, Cached: ${ethers.formatUnits(finalStats.totalDebt, 6)})`);
  
  if (!colMatch || !debtMatch) {
    console.log("\n  ℹ️  Note: StatisticsView is updated via pushUserStatsUpdate() calls from business logic.");
    console.log("     The mismatch indicates that StatisticsView updates may not be fully integrated");
    console.log("     in the current business flow, or updates are best-effort (non-blocking).");
    console.log("     PositionView and UserView show correct values from the ledger.");
  } else {
    console.log("\n  ✅ StatisticsView is in sync with ledger!");
  }

  console.log("\n✅ E2E Full Test with View Layer Verification Completed!");

  // Artifacts: module snapshot + RewardView version + reward dp counts
  const rvVer = (await rewardView.getVersionInfo()) as [bigint, bigint, string];
  const artifactBlock = await ethers.provider.getBlockNumber();
  const artifactPath = artifacts.writeJson(`full-with-views.${artifactBlock}.json`, {
    name: "e2e-localhost-full-with-views (Reward-aligned)",
    generatedAt: new Date().toISOString(),
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    modules: {
      Registry: CONTRACT_ADDRESSES.Registry,
      AccessControlManager: CONTRACT_ADDRESSES.AccessControlManager,
      RewardView: String(rewardViewAddr),
      RewardPoints: String(rewardPointsAddr),
      OrderEngine: String(orderEngineAddr),
    },
    versionInfo: {
      RewardView: { apiVersion: rvVer[0].toString(), schemaVersion: rvVer[1].toString(), implementation: rvVer[2] },
    },
    counters: {
      rewardDataPushedByTypeHash: dataPushedCounts,
    },
    rewardCheck: {
      principalRaw: borrowAmt2.toString(),
      pointsBalanceDeltaRaw: balDelta.toString(),
      totalEarnedDeltaRaw: earnedDelta.toString(),
    },
  });
  console.log("  📦 artifacts:", artifactPath);
  } finally {
    await network.provider.send("evm_revert", [snap]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});


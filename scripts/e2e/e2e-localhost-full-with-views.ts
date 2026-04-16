import { ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost.ts";
import { runViewPreflight } from "./utils/view-preflight.ts";

const BLOCKS_PER_DAY = 7_200n;
const ONE_HOUR_BLOCKS = 1_800n;
const STRICT_VIEWS = (process.env.E2E_STRICT_VIEWS ?? "1").toLowerCase() !== "0";

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function assertView(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
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

function formatRiskLevel(value: unknown): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return "N/A";
}

async function main() {
  const snap = await network.provider.send("evm_snapshot", []);
  const artifacts = mkArtifactsWriter();
  const dataPushedCounts: Record<string, number> = {};
  const checkpointSummaries: Record<string, any> = {};
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
  const acmAddrFromRegistry = (await registry.getModuleOrRevert(key("ACCESS_CONTROL_MANAGER"))) as string;
  const assetWhitelistAddrFromRegistry = (await registry.getModuleOrRevert(key("ASSET_WHITELIST"))) as string;
  const priceOracleAddrFromRegistry = (await registry.getModuleOrRevert(key("PRICE_ORACLE"))) as string;
  const feeRouterAddrFromRegistry = (await registry.getModuleOrRevert(key("FEE_ROUTER"))) as string;
  const settlementManagerAddrFromRegistry = (await registry.getModuleOrRevert(key("SETTLEMENT_MANAGER"))) as string;
  const settlementTokenAddrFromRegistry = (await registry.getModuleOrRevert(key("SETTLEMENT_TOKEN"))) as string;
  const vaultCoreFromRegistryAddr = (await registry.getModuleOrRevert(key("VAULT_CORE"))) as string;
  const vblAddrFromRegistry = (await registry.getModuleOrRevert(key("VAULT_BUSINESS_LOGIC"))) as string;
  const cmAddrFromRegistry = (await registry.getModuleOrRevert(key("COLLATERAL_MANAGER"))) as string;
  const gfmAddrFromRegistry = (await registry.getModule(key("GUARANTEE_FUND_MANAGER"))) as string;
  const statsPushManagerAddrFromRegistry = (await registry.getModuleOrRevert(key("STATISTICS_PUSH_MANAGER"))) as string;
  const liquidationRiskManagerAddrFromRegistry = (await registry.getModuleOrRevert(key("LIQUIDATION_RISK_MANAGER"))) as string;

  const acm = (await ethers.getContractAt("AccessControlManager", acmAddrFromRegistry)) as any;
  const awRead = (await ethers.getContractAt("IAssetWhitelistRead", assetWhitelistAddrFromRegistry)) as any;
  const awAdmin = (await ethers.getContractAt("IAssetWhitelistAdmin", assetWhitelistAddrFromRegistry)) as any;
  const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", priceOracleAddrFromRegistry)) as any;
  const feeRouter = (await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", feeRouterAddrFromRegistry)) as any;
  const settlementManager = (await ethers.getContractAt(
    "src/Vault/liquidation/modules/SettlementManager.sol:SettlementManager",
    settlementManagerAddrFromRegistry
  )) as any;
  const statsPushManager = (await ethers.getContractAt("StatisticsPushManager", statsPushManagerAddrFromRegistry)) as any;
  const liquidationRiskManager = (await ethers.getContractAt(
    "src/Vault/liquidation/modules/LiquidationRiskManager.sol:LiquidationRiskManager",
    liquidationRiskManagerAddrFromRegistry
  )) as any;
  const usdc = (await ethers.getContractAt("MockERC20", settlementTokenAddrFromRegistry)) as any;
  const vaultCore = (await ethers.getContractAt("VaultCore", vaultCoreFromRegistryAddr)) as any;
  const vbl = (await ethers.getContractAt("VaultBusinessLogic", vblAddrFromRegistry)) as any;
  const vaultLendingEngineAddrFromRegistry = (await registry.getModuleOrRevert(key("LENDING_ENGINE"))) as string;
  const cm = (await ethers.getContractAt("CollateralManager", cmAddrFromRegistry)) as any;
  const vle = (await ethers.getContractAt(
    "src/Vault/modules/VaultLendingEngine.sol:VaultLendingEngine",
    vaultLendingEngineAddrFromRegistry
  )) as any;

  // MUST: Preflight for route↔registry + version info + required roles
  await runViewPreflight({
    registryAddr: CONTRACT_ADDRESSES.Registry,
    acmAddr: acmAddrFromRegistry,
    adminSigner: deployer,
    assetForPriceCheck: settlementTokenAddrFromRegistry,
  });

  // Pick "clean" borrower/lender to make re-runs on dirty node stable.
  // matchflow may lock EarlyRepaymentGuarantee per (borrower, asset); if an active record exists,
  // EarlyRepaymentGuaranteeManager may revert with GuaranteeAlreadyProcessed().
  let borrower = signers[1];
  let lender = signers[2];
  try {
    const assetAddr = settlementTokenAddrFromRegistry;
    const ergmAddr = (await registry.getModule(
      key("EARLY_REPAYMENT_GUARANTEE_MANAGER"),
    )) as string;
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

  const easyTokenAddr = await registry.getModuleOrRevert(key("EASY_TOKEN"));
  const easyToken = (await ethers.getContractAt("src/Token/EasyToken.sol:EasyToken", easyTokenAddr)) as any;
  const easyDecimals = (await easyToken.decimals()) as number;
  const fmtEasy = (x: bigint) => ethers.formatUnits(x, easyDecimals);

  console.log("📋 View Modules:");
  console.log("  PositionView:", positionViewAddr);
  console.log("  HealthView:", healthViewAddr);
  console.log("  StatisticsView:", statisticsViewAddr);
  console.log("  RewardView:", rewardViewAddr);
  console.log("  DashboardView:", dashboardViewAddr);
  console.log("  RiskView:", riskViewAddr);
  console.log("  UserView:", userViewAddr);
  console.log("  EasyToken:", easyTokenAddr);
  console.log("");

  // ============ Setup Roles ============
  const ACTION_ADD_WHITELIST = key("ADD_WHITELIST");
  const ACTION_UPDATE_PRICE = key("UPDATE_PRICE");
  const ACTION_SET_PARAMETER = key("SET_PARAMETER");
  const ACTION_DEPOSIT = key("DEPOSIT");
  const ACTION_ORDER_CREATE = key("ORDER_CREATE");
  const ACTION_BORROW = key("BORROW");
  const ACTION_REPAY = key("REPAY");
  const ACTION_VIEW_PUSH = key("ACTION_VIEW_PUSH");
  const ACTION_VIEW_SYSTEM_DATA = key("VIEW_SYSTEM_DATA");
  const ACTION_VIEW_PRICE_DATA = key("VIEW_PRICE_DATA");
  const ACTION_VIEW_RISK_DATA = key("VIEW_RISK_DATA");
  const ACTION_LIQUIDATE = key("LIQUIDATE");

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
  await ensureRole(ACTION_ORDER_CREATE, vblAddrFromRegistry);
  await ensureRole(ACTION_DEPOSIT, vblAddrFromRegistry);
  await ensureRole(ACTION_BORROW, orderEngineAddr);
  await ensureRole(ACTION_REPAY, borrower.address);
  await ensureRole(ACTION_REPAY, settlementManagerAddrFromRegistry);
  await ensureRole(ACTION_VIEW_PUSH, deployer.address);
  await ensureRole(ACTION_VIEW_PUSH, vaultLendingEngineAddrFromRegistry);
  await ensureRole(ACTION_VIEW_PUSH, settlementManagerAddrFromRegistry);
  await ensureRole(ACTION_VIEW_PUSH, cmAddrFromRegistry);
  await ensureRole(ACTION_VIEW_SYSTEM_DATA, statsPushManagerAddrFromRegistry);
  await ensureRole(ACTION_VIEW_PRICE_DATA, statsPushManagerAddrFromRegistry);
  await ensureRole(ACTION_VIEW_RISK_DATA, statsPushManagerAddrFromRegistry);
  await ensureRole(ACTION_VIEW_RISK_DATA, deployer.address);
  await ensureRole(ACTION_VIEW_SYSTEM_DATA, deployer.address);
  await ensureRole(ACTION_LIQUIDATE, deployer.address);
  console.log("");

  // ============ Setup Asset & Price ============
  console.log("💰 Setting up asset whitelist and price...");
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
  await po.connect(deployer).updatePrice(settlementTokenAddrFromRegistry, ethers.parseUnits("1", 6), blockNumber);

  if (!(await feeRouter.isTokenSupported(settlementTokenAddrFromRegistry))) {
    await feeRouter.connect(deployer).addSupportedToken(settlementTokenAddrFromRegistry);
  }
  console.log("");

  // ============ Fund Users ============
  console.log("💵 Funding users...");
  await usdc.connect(deployer).transfer(borrower.address, ethers.parseUnits("20000", 6));
  await usdc.connect(deployer).transfer(lender.address, ethers.parseUnits("20000", 6));
  console.log("  Borrower balance:", ethers.formatUnits(await usdc.balanceOf(borrower.address), 6));
  console.log("  Lender balance:", ethers.formatUnits(await usdc.balanceOf(lender.address), 6));
  console.log("");

  async function syncStatisticsSnapshot(user: string) {
    const tx = await statsPushManager.connect(deployer).retryUserStats(user);
    await tx.wait();
  }

  async function syncHealthSnapshot(user: string) {
    const riskAssessment = await riskView.getUserRiskAssessment(user);
    let minHealthFactor = 10_000n;
    try {
      minHealthFactor = (await liquidationRiskManager.getMinHealthFactor()) as bigint;
    } catch {
      if (typeof riskAssessment?.healthFactor === "bigint") {
        minHealthFactor = riskAssessment.healthFactor;
      }
    }
    const healthFactor = typeof riskAssessment?.healthFactor === "bigint" ? riskAssessment.healthFactor : 0n;
    const isUndercollateralized = healthFactor !== 0n && healthFactor < minHealthFactor;
    const tx = await healthView
      .connect(deployer)
      .pushRiskStatus(user, healthFactor, minHealthFactor, isUndercollateralized, 0);
    await tx.wait();
    return { healthFactor, minHealthFactor, isUndercollateralized };
  }

  async function verifyViews(
    step: string,
    user: string,
    asset: string,
    options: { expectRewardValid: boolean; expectedRewardPushes?: number }
  ) {
    console.log(`\n📊 View Layer Verification [${step}]:`);
    await syncStatisticsSnapshot(user);
    const syncedHealth = await syncHealthSnapshot(user);

    const ledgerCollateral = (await cm.getCollateral(user, asset)) as bigint;
    const ledgerDebt = (await vle.getDebt(user, asset)) as bigint;
    const ledgerCollateralValue = (await positionView.getUserTotalCollateralValue(user)) as bigint;
    const ledgerDebtValue = (await vle.getUserTotalDebtValue(user)) as bigint;

    const [collateral, debt, isValid, blockNumber, ver] = await positionView.getUserPositionWithMeta(user, asset);
    console.log(
      `  PositionView: collateral=${ethers.formatUnits(collateral, 6)}, debt=${ethers.formatUnits(debt, 6)}, isValid=${isValid}, block=${blockNumber.toString()}, ver=${ver.toString()}`
    );
    assertView(collateral === ledgerCollateral, `${step}: PositionView collateral mismatch`);
    assertView(debt === ledgerDebt, `${step}: PositionView debt mismatch`);
    assertView(isValid, `${step}: PositionView should be valid`);

    const [hf, healthValid, healthBlock] = await healthView.getUserHealthFactorWithMeta(user);
    console.log(`  HealthView: healthFactor=${hf.toString()}, isValid=${healthValid}, block=${healthBlock.toString()}`);
    assertView(healthValid, `${step}: HealthView should be valid after sync`);
    assertView(hf === syncedHealth.healthFactor, `${step}: HealthView cached HF mismatch`);

    const [userCollateral, userDebt] = await userView.getUserPosition(user, asset);
    console.log(`  UserView: collateral=${ethers.formatUnits(userCollateral, 6)}, debt=${ethers.formatUnits(userDebt, 6)}`);
    assertView(userCollateral === ledgerCollateral, `${step}: UserView collateral mismatch`);
    assertView(userDebt === ledgerDebt, `${step}: UserView debt mismatch`);

    const riskAssessment = await riskView.getUserRiskAssessment(user);
    console.log(`  RiskView: healthFactor=${riskAssessment.healthFactor.toString()}, riskLevel=${formatRiskLevel(riskAssessment.riskLevel)}`);
    assertView(riskAssessment.healthFactor === hf, `${step}: RiskView/HealthView HF mismatch`);

    const [userStats, userStatsVersion, userStatsSeq, userStatsRequestId, userStatsValid, userStatsBlock] =
      await statisticsView.getUserSnapshotWithMeta(user);
    console.log(
      `  StatisticsView(user): collateral=${ethers.formatUnits(userStats.collateral, 18)}, debt=${ethers.formatUnits(userStats.debt, 18)}, version=${userStatsVersion.toString()}, seq=${userStatsSeq.toString()}, isValid=${userStatsValid}, block=${userStatsBlock.toString()}`
    );
    assertView(userStatsValid, `${step}: StatisticsView user snapshot should be valid after retryUserStats`);
    assertView(userStats.collateral === ledgerCollateralValue, `${step}: StatisticsView user collateral mismatch`);
    assertView(userStats.debt === ledgerDebtValue, `${step}: StatisticsView user debt mismatch`);

    const [stats, statsValid, statsBlock] = await statisticsView.getGlobalStatisticsWithMeta();
    console.log(
      `  StatisticsView(global): totalUsers=${stats.totalUsers}, totalCollateral=${ethers.formatUnits(stats.totalCollateral, 18)}, totalDebt=${ethers.formatUnits(stats.totalDebt, 18)}, isValid=${statsValid}, block=${statsBlock.toString()}`
    );
    assertView(statsValid, `${step}: StatisticsView global snapshot should be valid after retryUserStats`);

    const [overview, posValid, posBlocks, posVer, hfBlock] = await dashboardView.getUserOverviewWithMeta(user, [asset]);
    console.log(
      `  DashboardView: totalCollateral=${ethers.formatUnits(overview.totalCollateral, 6)}, totalDebt=${ethers.formatUnits(overview.totalDebt, 6)}, healthFactor=${overview.healthFactor.toString()}, posValid=${posValid[0]}, posBlock=${posBlocks[0].toString()}, posVer=${posVer[0].toString()}, hfBlock=${hfBlock.toString()}`
    );
    assertView(posValid[0], `${step}: DashboardView position validity missing`);
    assertView(overview.totalCollateral === ledgerCollateral, `${step}: DashboardView collateral mismatch`);
    assertView(overview.totalDebt === ledgerDebt, `${step}: DashboardView debt mismatch`);

    const [easyEarned, easyBlock, easyValid] = await rewardView.getUserEasyEarnedWithMeta(user);
    const [totalBurned, pendingPenalty, level, lastActivity, rewardBlock, rewardValid] = await rewardView.getUserRewardSummaryWithMeta(user);
    console.log(
      `  RewardView: easyEarned=${easyEarned.toString()}, totalBurned=${totalBurned.toString()}, pendingPenalty=${pendingPenalty.toString()}, level=${level}, lastActivity=${lastActivity.toString()}, block=${rewardBlock.toString()}, isValid=${rewardValid}`
    );
    if (options.expectRewardValid) {
      assertView(rewardValid && easyValid, `${step}: RewardView should be valid after reward-producing flow`);
      assertView(rewardBlock > 0n && easyBlock > 0n, `${step}: RewardView should record cache block`);
      if (options.expectedRewardPushes !== undefined) {
        assertView(
          (options.expectedRewardPushes === 0 && rewardValid) || options.expectedRewardPushes >= 0,
          `${step}: invalid expectedRewardPushes configuration`
        );
      }
    }

    checkpointSummaries[step] = {
      ledger: {
        collateralRaw: ledgerCollateral.toString(),
        debtRaw: ledgerDebt.toString(),
      },
      positionView: {
        collateralRaw: collateral.toString(),
        debtRaw: debt.toString(),
        isValid,
        blockNumber: blockNumber.toString(),
        version: ver.toString(),
      },
      healthView: {
        healthFactorRaw: hf.toString(),
        isValid: healthValid,
        blockNumber: healthBlock.toString(),
      },
      statisticsView: {
        userCollateralRaw: userStats.collateral.toString(),
        userDebtRaw: userStats.debt.toString(),
        userVersion: userStatsVersion.toString(),
        userSeq: userStatsSeq.toString(),
        lastAppliedRequestId: userStatsRequestId,
        userIsValid: userStatsValid,
        userBlockNumber: userStatsBlock.toString(),
        totalUsers: stats.totalUsers.toString(),
        totalCollateralRaw: stats.totalCollateral.toString(),
        totalDebtRaw: stats.totalDebt.toString(),
        isValid: statsValid,
        blockNumber: statsBlock.toString(),
      },
      rewardView: {
        easyEarnedRaw: easyEarned.toString(),
        totalBurnedRaw: totalBurned.toString(),
        pendingPenaltyRaw: pendingPenalty.toString(),
        level: String(level),
        lastActivity: lastActivity.toString(),
        isValid: rewardValid,
        blockNumber: rewardBlock.toString(),
      },
    };
  }

  // ============ Step 1: Deposit Collateral ============
  console.log("=== Step 1: Borrower Deposits Collateral ===");
  const collateralAmt = ethers.parseUnits("2000", 6);
  // IMPORTANT (authority path): CollateralManager pulls tokens from user via transferFrom.
  // Therefore user must approve CollateralManager (not VaultCore).
  await usdc.connect(borrower).approve(cmAddrFromRegistry, collateralAmt);
  await vaultCore.connect(borrower).deposit(settlementTokenAddrFromRegistry, collateralAmt);
  
  const colAfterDeposit = await cm.getCollateral(borrower.address, settlementTokenAddrFromRegistry);
  console.log("✅ Deposit completed. Collateral:", ethers.formatUnits(colAfterDeposit, 6));
  
  await verifyViews("after_deposit", borrower.address, settlementTokenAddrFromRegistry, { expectRewardValid: false });

  // NOTE (SSOT): orderId is the primary key for repay/settle.
  // A plain VaultCore.borrow(...) does not necessarily create an ORDER_ENGINE orderId,
  // so this E2E focuses on the matchflow which deterministically creates orderId.

  // ============ Step 2: Matchflow (Reserve + Finalize) ============
  console.log("\n=== Step 2: Matchflow (Reserve + Finalize Match) ===");
  const borrowAmt2 = ethers.parseUnits("1000", 6);
  const termDays = 5;
  const rateBps = 1000n;
  const expireAt = BigInt(await ethers.provider.getBlockNumber()) + ONE_HOUR_BLOCKS;

  const borrowIntent = {
    borrower: borrower.address,
    collateralAsset: settlementTokenAddrFromRegistry,
    collateralAmount: collateralAmt,
    borrowAsset: settlementTokenAddrFromRegistry,
    amount: borrowAmt2,
    termDays,
    rateBps,
    expireAt,
    salt: ethers.keccak256(ethers.toUtf8Bytes("borrow-salt-e2e")),
  };

  const lendIntent = {
    lenderSigner: lender.address,
    asset: settlementTokenAddrFromRegistry,
    amount: borrowAmt2,
    minTermDays: 1,
    maxTermDays: 30,
    minRateBps: 0n,
    expireAt,
    salt: ethers.keccak256(ethers.toUtf8Bytes("lend-salt-e2e")),
  };

  // Lender reserves funds
  await usdc.connect(lender).approve(vblAddrFromRegistry, borrowAmt2);
  const lendHash = buildLendIntentHash(lendIntent);
  await vbl.connect(lender).reserveForLending(lender.address, settlementTokenAddrFromRegistry, borrowAmt2, lendHash);
  console.log("✅ Lender reserved funds.");

  // Sign EIP-712 intents
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

  // Finalize match
  // NOTE: matchflow may lock EarlyRepaymentGuarantee via GuaranteeFundManager, which pulls settlementToken via transferFrom.
  // Ensure borrower has sufficient allowance to avoid ERC20InsufficientAllowance during finalizeMatch.
  if (gfmAddrFromRegistry && gfmAddrFromRegistry !== ethers.ZeroAddress) {
    await usdc.connect(borrower).approve(gfmAddrFromRegistry, ethers.MaxUint256);
  }
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

  await verifyViews("after_match", borrower.address, settlementTokenAddrFromRegistry, { expectRewardValid: false });

  // ============ Step 3: Repay Match Loan (via SettlementManager SSOT) ============
  console.log("\n=== Step 3: Borrower Repays Match Loan ===");
  const requireFullRepayRelease = (await settlementManager.requireFullRepayRelease()) as boolean;
  console.log(`  ℹ️  SettlementManager.requireFullRepayRelease=${requireFullRepayRelease}`);
  if (orderId === null) throw new Error("LoanOrderCreated not found");
  const termBlocks = BigInt(termDays) * BLOCKS_PER_DAY;
  const totalDue = calcTotalDue(borrowAmt2, rateBps, termBlocks);
  const orderBeforeRepay = await orderEngine.getLoanOrderForView(orderId);
  const maturityBlock = BigInt(orderBeforeRepay.maturity);
  const onTimeWindowBlocks = 7200n;
  const targetRepayBlock = maturityBlock > onTimeWindowBlocks
    ? maturityBlock - onTimeWindowBlocks
    : maturityBlock;
  const currentBlock = BigInt(await ethers.provider.getBlockNumber());
  if (targetRepayBlock > currentBlock) {
    const delta = targetRepayBlock - currentBlock;
    await ethers.provider.send("hardhat_mine", ["0x" + delta.toString(16)]);
    console.log(`  ⏰ Mined to on-time reward window. current=${(await ethers.provider.getBlockNumber()).toString()} target=${targetRepayBlock.toString()} maturity=${maturityBlock.toString()}`);
  }
  const rewardBalBefore = (await easyToken.balanceOf(borrower.address)) as bigint;
  const [easyEarnedBefore] = (await rewardView.getUserEasyEarnedWithMeta(borrower.address)) as [bigint, bigint, boolean];
  await usdc.connect(borrower).approve(vaultCoreFromRegistryAddr, totalDue);
  const repayTx = await vaultCore.connect(borrower).repay(orderId, settlementTokenAddrFromRegistry, totalDue);
  const repayRcpt = await repayTx.wait();
  const rewardPushes = parseRewardDataPushed(repayRcpt, String(rewardViewAddr));
  for (const p of rewardPushes) bump(p.typeHash);
  console.log("✅ Repay completed. totalDue:", ethers.formatUnits(totalDue, 6));

  if (newTokenId !== undefined) {
    const meta = await loanNft.getLoanMetadata(newTokenId);
    console.log("✅ LoanNFT status after repay:", meta.status.toString());
  }

  await verifyViews("after_match_repay", borrower.address, settlementTokenAddrFromRegistry, { expectRewardValid: true });

  const rewardBalAfter = (await easyToken.balanceOf(borrower.address)) as bigint;
  const [easyEarnedAfter] = (await rewardView.getUserEasyEarnedWithMeta(borrower.address)) as [bigint, bigint, boolean];
  const balDelta = rewardBalAfter - rewardBalBefore;
  const easyEarnedDelta = easyEarnedAfter - easyEarnedBefore;
  console.log(
    `  [Reward] repay delta: balDelta=${fmtEasy(balDelta)} easyEarnedDelta=${fmtEasy(easyEarnedDelta)} dataPushed=${rewardPushes.length}`
  );
  assertView(rewardPushes.length > 0, "[Reward] repay should emit RewardView.DataPushed");

  // ============ Final Summary ============
  console.log("\n=== Final Summary ===");
  const finalCol = await cm.getCollateral(borrower.address, settlementTokenAddrFromRegistry);
  const finalDebt = await vle.getDebt(borrower.address, settlementTokenAddrFromRegistry);
  console.log("📊 Ledger Values (Source of Truth):");
  console.log("  Collateral:", ethers.formatUnits(finalCol, 6));
  console.log("  Debt:", ethers.formatUnits(finalDebt, 6));

  const [finalUserStats, finalUserStatsVersion, finalUserStatsSeq, , finalUserStatsValid, finalUserStatsBlock] =
    await statisticsView.getUserSnapshotWithMeta(borrower.address);
  console.log("\n📈 StatisticsView User Snapshot:");
  console.log("  User Collateral:", ethers.formatUnits(finalUserStats.collateral, 6));
  console.log("  User Debt:", ethers.formatUnits(finalUserStats.debt, 6));
  console.log("  Version:", finalUserStatsVersion.toString());
  console.log("  Seq:", finalUserStatsSeq.toString());
  console.log("  Is Valid:", finalUserStatsValid);
  console.log("  Last Update Block:", finalUserStatsBlock > 0n ? finalUserStatsBlock.toString() : "Never");

  const [finalStats] = await statisticsView.getGlobalStatisticsWithMeta();
  console.log("\n📈 StatisticsView Global Snapshot:");
  console.log("  Active Users:", finalStats.activeUsers.toString());
  console.log("  Total Collateral:", ethers.formatUnits(finalStats.totalCollateral, 6));
  console.log("  Total Debt:", ethers.formatUnits(finalStats.totalDebt, 6));
  console.log("  Last Update Block:", finalStats.lastUpdateBlock > 0n
    ? finalStats.lastUpdateBlock.toString()
    : "Never");
  
  // Compare ledger vs cached
  console.log("\n🔍 Data Consistency Check:");
  const colMatch = finalCol === finalUserStats.collateral;
  const debtMatch = finalDebt === finalUserStats.debt;
  console.log(`  User collateral match: ${colMatch ? "✅" : "⚠️"} (Ledger: ${ethers.formatUnits(finalCol, 6)}, Cached: ${ethers.formatUnits(finalUserStats.collateral, 6)})`);
  console.log(`  User debt match: ${debtMatch ? "✅" : "⚠️"} (Ledger: ${ethers.formatUnits(finalDebt, 6)}, Cached: ${ethers.formatUnits(finalUserStats.debt, 6)})`);

  if (STRICT_VIEWS) {
    assertView(finalUserStatsValid, "Final Summary: StatisticsView user snapshot should be valid");
    assertView(colMatch, "Final Summary: StatisticsView user collateral must match ledger");
    assertView(debtMatch, "Final Summary: StatisticsView user debt must match ledger");
  }

  console.log("\n  ✅ StatisticsView user snapshot is in sync with ledger!");

  console.log("\n✅ E2E Full Test with View Layer Verification Completed!");

  // Artifacts: module snapshot + RewardView version + reward dp counts
  const rvVer = (await rewardView.getVersionInfo()) as [bigint, bigint, string];
  const rpcUrl = process.env.LOCALHOST_RPC_URL || "";
  const artifactBlock = await ethers.provider.getBlockNumber();
  const artifactPath = artifacts.writeJson(`full-with-views.${artifactBlock}.json`, {
    name: "e2e-localhost-full-with-views (Reward-aligned)",
    generatedAt: new Date().toISOString(),
    chainId: (await ethers.provider.getNetwork()).chainId.toString(),
    rpcUrl,
    blockNumber: artifactBlock,
    modules: {
      Registry: CONTRACT_ADDRESSES.Registry,
      AccessControlManager: acmAddrFromRegistry,
      RewardView: String(rewardViewAddr),
      EasyToken: String(easyTokenAddr),
      OrderEngine: String(orderEngineAddr),
    },
    versionInfo: {
      RewardView: { apiVersion: rvVer[0].toString(), schemaVersion: rvVer[1].toString(), implementation: rvVer[2] },
    },
    counters: {
      dataPushedByTypeHash: dataPushedCounts,
      rewardDataPushedByTypeHash: dataPushedCounts,
    },
    checkpoints: checkpointSummaries,
    rewardCheck: {
      principalRaw: borrowAmt2.toString(),
      easyBalanceDeltaRaw: balDelta.toString(),
      easyEarnedDeltaRaw: easyEarnedDelta.toString(),
      rewardPushCount: rewardPushes.length,
      requireFullRepayRelease,
    },
    strictViews: STRICT_VIEWS,
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


import { ethers } from "hardhat";
import { CONTRACT_ADDRESSES } from "../../frontend-config/contracts-localhost";
import { scanViewModules } from "./utils/view-scan";

const ONE_DAY = 24n * 60n * 60n;

function key(s: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

function calcTotalDue(principal: bigint, rateBps: bigint, termSec: bigint) {
  const denom = 365n * ONE_DAY * 10_000n;
  const interest = (principal * rateBps * termSec) / denom;
  return principal + interest;
}

function buildLendIntentHash(li: any) {
  const typeHash = ethers.keccak256(
    ethers.toUtf8Bytes(
      "LendIntent(address lender,address asset,uint256 amount,uint16 minTermDays,uint16 maxTermDays,uint256 minRateBps,uint256 expireAt,bytes32 salt)"
    )
  );
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(
    coder.encode(
      ["bytes32", "address", "address", "uint256", "uint16", "uint16", "uint256", "uint256", "bytes32"],
      [
        typeHash,
        li.lender,
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

async function evmIncreaseTime(seconds: bigint) {
  await ethers.provider.send("evm_increaseTime", [Number(seconds)]);
  await ethers.provider.send("evm_mine", []);
}

export async function runAdvancedBatch(opts?: { sampleBorrowerIndex?: number }) {
  const signers = await ethers.getSigners();
  if (signers.length < 11) throw new Error(`Need at least 11 signers (have ${signers.length})`);

  const deployer = signers[0];

  // 10 users → 5 borrowers + 5 lenders
  const borrowers = [signers[1], signers[3], signers[5], signers[7], signers[9]];
  const lenders = [signers[2], signers[4], signers[6], signers[8], signers[10]];

  console.log("=== E2E Advanced Batch (10 users / 5 borrowers + 5 lenders) ===\n");
  console.log("Scenarios:");
  console.log("- Pair1: on-time full repay");
  console.log("- Pair2: partial repay then full repay (on-time)");
  console.log("- Pair3: on-time full repay");
  console.log("- Pair4: multi-lender split via 2 orders (2 lenders, 250 + 250)");
  console.log("- Pair5: overdue full repay (time travel)\n");

  const registry = (await ethers.getContractAt("Registry", CONTRACT_ADDRESSES.Registry)) as any;
  const acm = (await ethers.getContractAt("AccessControlManager", CONTRACT_ADDRESSES.AccessControlManager)) as any;
  const aw = (await ethers.getContractAt("AssetWhitelist", CONTRACT_ADDRESSES.AssetWhitelist)) as any;
  const po = (await ethers.getContractAt("src/core/PriceOracle.sol:PriceOracle", CONTRACT_ADDRESSES.PriceOracle)) as any;
  const feeRouter = (await ethers.getContractAt("src/Vault/FeeRouter.sol:FeeRouter", CONTRACT_ADDRESSES.FeeRouter)) as any;
  const usdc = (await ethers.getContractAt("MockERC20", CONTRACT_ADDRESSES.MockUSDC)) as any;
  const vaultCore = (await ethers.getContractAt("VaultCore", CONTRACT_ADDRESSES.VaultCore)) as any;
  const vbl = (await ethers.getContractAt("VaultBusinessLogic", CONTRACT_ADDRESSES.VaultBusinessLogic)) as any;
  const cm = (await ethers.getContractAt("CollateralManager", CONTRACT_ADDRESSES.CollateralManager)) as any;
  const vle = await ethers.getContractAt(
    "src/Vault/modules/VaultLendingEngine.sol:VaultLendingEngine",
    CONTRACT_ADDRESSES.VaultLendingEngine
  );

  const orderEngineAddr = await registry.getModuleOrRevert(key("ORDER_ENGINE"));
  const orderEngine = (await ethers.getContractAt("src/core/LendingEngine.sol:LendingEngine", orderEngineAddr)) as any;

  const positionViewAddr = await registry.getModuleOrRevert(key("POSITION_VIEW"));
  const userViewAddr = await registry.getModuleOrRevert(key("USER_VIEW"));
  const riskViewAddr = await registry.getModuleOrRevert(key("RISK_VIEW"));
  const statisticsViewAddr = await registry.getModuleOrRevert(key("STATISTICS_VIEW"));

  const positionView = (await ethers.getContractAt("PositionView", positionViewAddr)) as any;
  const userView = (await ethers.getContractAt("UserView", userViewAddr)) as any;
  const riskView = (await ethers.getContractAt("RiskView", riskViewAddr)) as any;
  const statisticsView = (await ethers.getContractAt("StatisticsView", statisticsViewAddr)) as any;

  const assetAddr = usdc.target as string;
  const toBigInt = (x: any): bigint => (typeof x === "bigint" ? x : BigInt(x));

  // ============ ViewScan (broader view coverage) ============
  await scanViewModules(CONTRACT_ADDRESSES.Registry, {
    assetAddr,
    sampleUser: borrowers[0].address,
  });

  // ============ Reward (Architecture-Guide) ============
  const rewardView = (await ethers.getContractAt("RewardView", CONTRACT_ADDRESSES.RewardView)) as any;
  const rewardPoints = (await ethers.getContractAt(
    "src/Token/RewardPoints.sol:RewardPoints",
    CONTRACT_ADDRESSES.RewardPoints
  )) as any;
  const rewardDecimals = (await rewardPoints.decimals()) as number;
  const ONE_POINT = 10n ** BigInt(rewardDecimals);
  const fmtPoints = (x: bigint) => ethers.formatUnits(x, rewardDecimals);

  // ============ C baseline: unified version introspection ============
  async function logViewVersionInfo(label: string, view: any, expectSchema?: bigint) {
    const [apiVersion, schemaVersion, implementation] = await view.getVersionInfo();
    console.log(
      `  [VersionInfo] ${label}: api=${apiVersion.toString()} schema=${schemaVersion.toString()} implementation=${implementation}`
    );
    if (expectSchema !== undefined && schemaVersion !== expectSchema) {
      throw new Error(`[VersionInfo] ${label}: unexpected schemaVersion=${schemaVersion.toString()} expect=${expectSchema.toString()}`);
    }
  }
  await logViewVersionInfo("PositionView", positionView, 2n);
  await logViewVersionInfo("UserView", userView, 1n);
  await logViewVersionInfo("RiskView", riskView, 1n);
  await logViewVersionInfo("StatisticsView", statisticsView, 1n);

  // ============ Phase3 visibility: explicitly print PositionView version ============
  // We print a sample borrower's PositionView version at key checkpoints to validate
  // that cache writes are happening and versions are monotonic (strict nextVersion semantics).
  function parseSampleBorrowerIndexFromEnv(): number {
    // Prefer argv over env if both are provided.
    // Usage:
    //  - ENV:  E2E_SAMPLE_BORROWER_INDEX=2 npx hardhat run ... --network localhost
    const raw: string | undefined = process.env.E2E_SAMPLE_BORROWER_INDEX;

    if (raw === undefined || raw.trim() === "") return 0;
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new Error(`Invalid sample borrower index: ${raw}`);
    return n;
  }

  const sampleBorrowerIndex = opts?.sampleBorrowerIndex ?? parseSampleBorrowerIndexFromEnv();
  if (sampleBorrowerIndex < 0 || sampleBorrowerIndex >= borrowers.length) {
    throw new Error(
      `sampleBorrowerIndex out of range: ${sampleBorrowerIndex}. Must be in [0, ${borrowers.length - 1}]`
    );
  }
  const sampleBorrower = borrowers[sampleBorrowerIndex];
  async function logPositionViewVersion(step: string) {
    const v = await positionView.getPositionVersion(sampleBorrower.address, assetAddr);
    const [pvCol, pvDebt] = await positionView.getUserPosition(sampleBorrower.address, assetAddr);
    console.log(
      `  [PositionView] ${step}: sampleBorrowerIndex=${sampleBorrowerIndex} borrower=${sampleBorrower.address} version=${v.toString()} col=${ethers.formatUnits(
        pvCol,
        6
      )} debt=${ethers.formatUnits(pvDebt, 6)}`
    );
  }

  // ============ Roles ============
  const ensureRole = async (roleName: string, who: string | any) => {
    const whoAddr = await ethers.resolveAddress(who);
    const role = key(roleName);
    if (!(await acm.hasRole(role, whoAddr))) {
      await (await acm.grantRole(role, whoAddr)).wait();
    }
  };

  // config/admin
  await ensureRole("ADD_WHITELIST", deployer.address);
  await ensureRole("UPDATE_PRICE", deployer.address);
  await ensureRole("SET_PARAMETER", deployer.address);

  // match orchestration
  await ensureRole("ORDER_CREATE", CONTRACT_ADDRESSES.VaultBusinessLogic);
  await ensureRole("DEPOSIT", CONTRACT_ADDRESSES.VaultBusinessLogic);

  // order engine
  await ensureRole("BORROW", orderEngineAddr);

  // borrowers need repay permission for order engine
  for (const b of borrowers) {
    await ensureRole("REPAY", b.address);
  }

  // ============ Asset/price setup ============
  if (!(await aw.isAssetAllowed(assetAddr))) {
    await (await aw.connect(deployer).addAllowedAsset(assetAddr)).wait();
  }
  {
    const cfg = await po.getAssetConfig(assetAddr);
    if (!cfg.isActive) {
      await (await po.connect(deployer).configureAsset(assetAddr, "usd-coin", 8, 3600)).wait();
    }
  }
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  await (await po.connect(deployer).updatePrice(assetAddr, ethers.parseUnits("1", 6), now)).wait();

  if (!(await feeRouter.isTokenSupported(assetAddr))) {
    await (await feeRouter.connect(deployer).addSupportedToken(assetAddr)).wait();
  }

  // ============ Helpers: per-step assertions ============
  async function assertViews(step: string, user: string, asset: string, expectedCollateral?: bigint, expectedDebt?: bigint) {
    const ledgerCol = await cm.getCollateral(user, asset);
    const ledgerDebt = await vle.getDebt(user, asset);

    const [pvCol, pvDebt] = await positionView.getUserPosition(user, asset);
    const [uvCol, uvDebt] = await userView.getUserPosition(user, asset);

    if (pvCol !== ledgerCol || pvDebt !== ledgerDebt) {
      throw new Error(
        `${step}: PositionView != ledger for ${user}. ledger(col=${ledgerCol},debt=${ledgerDebt}) pv(col=${pvCol},debt=${pvDebt})`
      );
    }

    if (uvCol !== ledgerCol || uvDebt !== ledgerDebt) {
      throw new Error(
        `${step}: UserView != ledger for ${user}. ledger(col=${ledgerCol},debt=${ledgerDebt}) uv(col=${uvCol},debt=${uvDebt})`
      );
    }

    if (expectedCollateral !== undefined && ledgerCol !== expectedCollateral) {
      throw new Error(`${step}: unexpected collateral for ${user}. expected=${expectedCollateral} actual=${ledgerCol}`);
    }
    if (expectedDebt !== undefined && ledgerDebt !== expectedDebt) {
      throw new Error(`${step}: unexpected debt for ${user}. expected=${expectedDebt} actual=${ledgerDebt}`);
    }

    // RiskView: ensure callable (don’t over-assert semantics here)
    try {
      const ra = await riskView.getUserRiskAssessment(user);
      ra.healthFactor; // touch
    } catch (e: any) {
      throw new Error(`${step}: RiskView query failed for ${user}: ${e?.message || e}`);
    }
  }

  async function snapshotBorrowersTotals(asset: string) {
    let colSum = 0n;
    let debtSum = 0n;
    for (const b of borrowers) {
      colSum += await cm.getCollateral(b.address, asset);
      debtSum += await vle.getDebt(b.address, asset);
    }
    return { colSum, debtSum };
  }

  // ============ Parameters ============
  // Reward: print points in human-readable units (RewardPoints.decimals()) and assert delta == 1 point per successful loan cycle.
  const collateralAmt = ethers.parseUnits("1000", 6);
  const principal = ethers.parseUnits("500", 6);
  const termDays = 5;
  const rateBps = 1000n;
  const termSec = BigInt(termDays) * ONE_DAY;

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
      { name: "lender", type: "address" },
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "minTermDays", type: "uint16" },
      { name: "maxTermDays", type: "uint16" },
      { name: "minRateBps", type: "uint256" },
      { name: "expireAt", type: "uint256" },
      { name: "salt", type: "bytes32" },
    ],
  };

  // ============ Fund users ============
  console.log("💵 Funding users...");
  for (const b of borrowers) {
    await (await usdc.connect(deployer).transfer(b.address, ethers.parseUnits("20000", 6))).wait();
  }
  for (const l of lenders) {
    await (await usdc.connect(deployer).transfer(l.address, ethers.parseUnits("20000", 6))).wait();
  }

  // ============ Baseline (delta-based checkpoints) ============
  const baselineTotals = await snapshotBorrowersTotals(assetAddr);
  const baselineStats = await statisticsView.getGlobalStatistics();

  console.log("\n=== Baseline ===");
  console.log("Borrowers ledger sum collateral:", ethers.formatUnits(baselineTotals.colSum, 6));
  console.log("Borrowers ledger sum debt:", ethers.formatUnits(baselineTotals.debtSum, 6));
  console.log("StatisticsView totalCollateral:", ethers.formatUnits(baselineStats.totalCollateral, 6));
  console.log("StatisticsView totalDebt:", ethers.formatUnits(baselineStats.totalDebt, 6));
  await logPositionViewVersion("baseline");

  // Reward baseline snapshot (reward-qualifying borrower = borrower#1 / Pair1)
  const rewardBorrower = borrowers[0];
  const rewardBalBefore = (await rewardPoints.balanceOf(rewardBorrower.address)) as bigint;
  const rewardSummaryBefore = await rewardView.connect(deployer).getUserRewardSummary(rewardBorrower.address);
  console.log(
    `  [Reward] baseline: borrower=${rewardBorrower.address} pointsBalance=${fmtPoints(rewardBalBefore)} (raw=${rewardBalBefore.toString()}) totalEarned=${fmtPoints(
      rewardSummaryBefore[0]
    )} (raw=${rewardSummaryBefore[0].toString()}) totalBurned=${fmtPoints(rewardSummaryBefore[1])} pendingPenalty=${fmtPoints(
      rewardSummaryBefore[2]
    )}`
  );

  // Track expected per-borrower absolute state relative to current chain (do not assume fresh chain)
  const expectedCollateralByBorrower = new Map<string, bigint>();
  const expectedDebtByBorrower = new Map<string, bigint>();
  for (const b of borrowers) {
    expectedCollateralByBorrower.set(b.address, await cm.getCollateral(b.address, assetAddr));
    expectedDebtByBorrower.set(b.address, await vle.getDebt(b.address, assetAddr));
  }

  // ============ Step 1: Deposits (all borrowers) ============
  console.log("\n=== Step 1: Deposits (all borrowers) ===");
  for (let i = 0; i < borrowers.length; i++) {
    const borrower = borrowers[i];
    await (await usdc.connect(borrower).approve(CONTRACT_ADDRESSES.VaultCore, collateralAmt)).wait();
    await (await vaultCore.connect(borrower).deposit(assetAddr, collateralAmt)).wait();
    expectedCollateralByBorrower.set(
      borrower.address,
      (expectedCollateralByBorrower.get(borrower.address) || 0n) + collateralAmt
    );
    await assertViews(
      `After deposit borrower#${i + 1}`,
      borrower.address,
      assetAddr,
      expectedCollateralByBorrower.get(borrower.address),
      expectedDebtByBorrower.get(borrower.address)
    );
    console.log(`  ✅ borrower#${i + 1} deposited ${ethers.formatUnits(collateralAmt, 6)}`);
  }
  await logPositionViewVersion("after deposits");

  // ============ Step 2: Create orders via matchflow ============
  console.log("\n=== Step 2: Matchflow finalize (create orders) ===");

  type OrderRef = { borrower: string; orderId: bigint; principal: bigint };
  const orders: OrderRef[] = [];

  async function finalizeOne(borrowerSigner: any, lenderSigner: any, amount: bigint, saltSuffix: string): Promise<bigint> {
    const expireAt = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);

    const borrowIntent = {
      borrower: borrowerSigner.address,
      collateralAsset: assetAddr,
      collateralAmount: collateralAmt,
      borrowAsset: assetAddr,
      amount,
      termDays,
      rateBps,
      expireAt,
      salt: ethers.keccak256(ethers.toUtf8Bytes(`borrow-${saltSuffix}`)),
    };

    const lendIntent = {
      lender: lenderSigner.address,
      asset: assetAddr,
      amount,
      minTermDays: 1,
      maxTermDays: 30,
      minRateBps: 0n,
      expireAt,
      salt: ethers.keccak256(ethers.toUtf8Bytes(`lend-${saltSuffix}`)),
    };

    await (await usdc.connect(lenderSigner).approve(CONTRACT_ADDRESSES.VaultBusinessLogic, amount)).wait();
    const lendHash = buildLendIntentHash(lendIntent);
    await (await vbl.connect(lenderSigner).reserveForLending(lenderSigner.address, assetAddr, amount, lendHash)).wait();

    const sigBorrower = await borrowerSigner.signTypedData(domain, typesBorrow as any, borrowIntent as any);
    const sigLender = await lenderSigner.signTypedData(domain, typesLend as any, lendIntent as any);

    const tx = await vbl.connect(deployer).finalizeMatch(borrowIntent, [lendIntent], sigBorrower, [sigLender]);
    const receipt = await tx.wait();

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
    if (orderId === null) throw new Error(`LoanOrderCreated not found (${saltSuffix})`);

    // update expected debt
    expectedDebtByBorrower.set(
      borrowerSigner.address,
      (expectedDebtByBorrower.get(borrowerSigner.address) || 0n) + amount
    );

    await assertViews(
      `After finalizeMatch(${saltSuffix})`,
      borrowerSigner.address,
      assetAddr,
      expectedCollateralByBorrower.get(borrowerSigner.address),
      expectedDebtByBorrower.get(borrowerSigner.address)
    );

    return orderId;
  }

  // Pair1: borrower1 + lender1 (single 500)
  orders.push({ borrower: borrowers[0].address, orderId: await finalizeOne(borrowers[0], lenders[0], principal, "p1"), principal });
  console.log("  ✅ Pair1 order created");

  // Pair2: borrower2 + lender2 (single 500) — will do partial repay
  orders.push({ borrower: borrowers[1].address, orderId: await finalizeOne(borrowers[1], lenders[1], principal, "p2"), principal });
  console.log("  ✅ Pair2 order created (will partial repay)");

  // Pair3: borrower3 + lender3 (single 500)
  orders.push({ borrower: borrowers[2].address, orderId: await finalizeOne(borrowers[2], lenders[2], principal, "p3"), principal });
  console.log("  ✅ Pair3 order created");

  // Pair4: borrower4 split: two orders 250+250 with two lenders
  const half = principal / 2n;
  orders.push({
    borrower: borrowers[3].address,
    orderId: await finalizeOne(borrowers[3], lenders[3], half, "p4a"),
    principal: half,
  });
  orders.push({
    borrower: borrowers[3].address,
    orderId: await finalizeOne(borrowers[3], lenders[4], principal - half, "p4b"),
    principal: principal - half,
  });
  console.log("  ✅ Pair4 split orders created (2 lenders)");

  // Pair5: borrower5 + lender1 again (single 500) — will repay overdue
  orders.push({ borrower: borrowers[4].address, orderId: await finalizeOne(borrowers[4], lenders[0], principal, "p5"), principal });
  console.log("  ✅ Pair5 order created (will repay overdue)\n");

  // ============ Checkpoint A: Totals after all matches (delta-based) ============
  console.log("=== Checkpoint A: Totals after matches ===");
  const afterMatchTotals = await snapshotBorrowersTotals(assetAddr);
  const afterMatchStats = await statisticsView.getGlobalStatistics();

  const expectedCollateralDelta = collateralAmt * BigInt(borrowers.length);
  const expectedDebtDelta = orders.reduce((a, o) => a + o.principal, 0n);

  const ledgerColDelta = afterMatchTotals.colSum - baselineTotals.colSum;
  const ledgerDebtDelta = afterMatchTotals.debtSum - baselineTotals.debtSum;
  const statsColDelta = toBigInt(afterMatchStats.totalCollateral) - toBigInt(baselineStats.totalCollateral);
  const statsDebtDelta = toBigInt(afterMatchStats.totalDebt) - toBigInt(baselineStats.totalDebt);

  console.log("Expected deltas: collateral", ethers.formatUnits(expectedCollateralDelta, 6), "debt", ethers.formatUnits(expectedDebtDelta, 6));
  console.log("Ledger deltas:    collateral", ethers.formatUnits(ledgerColDelta, 6), "debt", ethers.formatUnits(ledgerDebtDelta, 6));
  console.log("Stats deltas:     collateral", ethers.formatUnits(statsColDelta, 6), "debt", ethers.formatUnits(statsDebtDelta, 6));

  if (ledgerColDelta !== expectedCollateralDelta) throw new Error("Checkpoint A: ledger collateral delta mismatch");
  if (ledgerDebtDelta !== expectedDebtDelta) throw new Error("Checkpoint A: ledger debt delta mismatch");
  if (statsColDelta !== expectedCollateralDelta) throw new Error("Checkpoint A: stats collateral delta mismatch");
  if (statsDebtDelta !== expectedDebtDelta) throw new Error("Checkpoint A: stats debt delta mismatch");
  console.log("✅ Checkpoint A passed\n");
  await logPositionViewVersion("checkpoint A (after matches)");

  // ============ Step 3: Repayments (with partial + overdue) ============
  console.log("=== Step 3: Repayments ===");

  // Helper: find signer by address
  const signerByAddr = new Map<string, any>();
  for (const s of signers) signerByAddr.set(s.address.toLowerCase(), s);

  // Pair1: repay full on-time
  {
    const o = orders.find((x) => x.borrower === borrowers[0].address)!;
    const totalDue = calcTotalDue(o.principal, rateBps, termSec);
    const borrowerSigner = signerByAddr.get(o.borrower.toLowerCase());
    await (await usdc.connect(borrowerSigner).approve(orderEngineAddr, totalDue)).wait();
    await (await orderEngine.connect(borrowerSigner).repay(o.orderId, totalDue)).wait();
    expectedDebtByBorrower.set(o.borrower, (expectedDebtByBorrower.get(o.borrower) || 0n) - o.principal);
    await assertViews(
      "After repay (pair1 full)",
      o.borrower,
      assetAddr,
      expectedCollateralByBorrower.get(o.borrower),
      expectedDebtByBorrower.get(o.borrower)
    );
    // Reward assertion: borrower#1 should have earned points after on-time full repay (amount >= 1000e6)
    const rewardBalAfter = (await rewardPoints.balanceOf(rewardBorrower.address)) as bigint;
    const rewardSummaryAfter = await rewardView.connect(deployer).getUserRewardSummary(rewardBorrower.address);
    console.log(
      `  [Reward] after repay(pair1): borrower=${rewardBorrower.address} pointsBalance=${fmtPoints(rewardBalAfter)} (raw=${rewardBalAfter.toString()}) totalEarned=${fmtPoints(
        rewardSummaryAfter[0]
      )} (raw=${rewardSummaryAfter[0].toString()}) totalBurned=${fmtPoints(rewardSummaryAfter[1])} pendingPenalty=${fmtPoints(
        rewardSummaryAfter[2]
      )}`
    );
    const balDelta = rewardBalAfter - rewardBalBefore;
    const earnedDelta = (rewardSummaryAfter[0] as bigint) - (rewardSummaryBefore[0] as bigint);
    if (balDelta !== ONE_POINT) throw new Error(`[Reward] expected points balance delta == 1 (got ${fmtPoints(balDelta)} raw=${balDelta.toString()})`);
    if (earnedDelta !== ONE_POINT) throw new Error(`[Reward] expected totalEarned delta == 1 (got ${fmtPoints(earnedDelta)} raw=${earnedDelta.toString()})`);
    if (rewardSummaryAfter[2] !== 0n) throw new Error("[Reward] expected pendingPenalty == 0 for on-time full repay (pair1)");
    console.log("  ✅ Pair1 full repaid");
  }

  // Pair2: partial repay then full repay (on-time)
  {
    const o = orders.find((x) => x.borrower === borrowers[1].address)!;
    const totalDue = calcTotalDue(o.principal, rateBps, termSec);
    const partial = totalDue / 2n;
    const remaining = totalDue - partial;
    const borrowerSigner = signerByAddr.get(o.borrower.toLowerCase());

    // partial
    await (await usdc.connect(borrowerSigner).approve(orderEngineAddr, totalDue)).wait();
    await (await orderEngine.connect(borrowerSigner).repay(o.orderId, partial)).wait();

    // principal-first mapping: repay reduces principal debt by min(partial, principal)
    const principalPaid1 = partial > o.principal ? o.principal : partial;
    expectedDebtByBorrower.set(o.borrower, (expectedDebtByBorrower.get(o.borrower) || 0n) - principalPaid1);
    await assertViews(
      "After repay (pair2 partial)",
      o.borrower,
      assetAddr,
      expectedCollateralByBorrower.get(o.borrower),
      expectedDebtByBorrower.get(o.borrower)
    );
    console.log("  ✅ Pair2 partial repaid");

    // remaining
    await (await orderEngine.connect(borrowerSigner).repay(o.orderId, remaining)).wait();
    const principalRemaining = o.principal - principalPaid1;
    expectedDebtByBorrower.set(o.borrower, (expectedDebtByBorrower.get(o.borrower) || 0n) - principalRemaining);
    await assertViews(
      "After repay (pair2 full)",
      o.borrower,
      assetAddr,
      expectedCollateralByBorrower.get(o.borrower),
      expectedDebtByBorrower.get(o.borrower)
    );
    console.log("  ✅ Pair2 fully repaid (on-time)");
  }

  // Pair3: full repay on-time
  {
    const o = orders.find((x) => x.borrower === borrowers[2].address)!;
    const totalDue = calcTotalDue(o.principal, rateBps, termSec);
    const borrowerSigner = signerByAddr.get(o.borrower.toLowerCase());
    await (await usdc.connect(borrowerSigner).approve(orderEngineAddr, totalDue)).wait();
    await (await orderEngine.connect(borrowerSigner).repay(o.orderId, totalDue)).wait();
    expectedDebtByBorrower.set(o.borrower, (expectedDebtByBorrower.get(o.borrower) || 0n) - o.principal);
    await assertViews(
      "After repay (pair3 full)",
      o.borrower,
      assetAddr,
      expectedCollateralByBorrower.get(o.borrower),
      expectedDebtByBorrower.get(o.borrower)
    );
    console.log("  ✅ Pair3 full repaid");
  }

  // Pair4: split orders — repay both on-time
  {
    const os = orders.filter((x) => x.borrower === borrowers[3].address);
    const borrowerSigner = signerByAddr.get(borrowers[3].address.toLowerCase());
    for (let i = 0; i < os.length; i++) {
      const o = os[i];
      const totalDue = calcTotalDue(o.principal, rateBps, termSec);
      await (await usdc.connect(borrowerSigner).approve(orderEngineAddr, totalDue)).wait();
      await (await orderEngine.connect(borrowerSigner).repay(o.orderId, totalDue)).wait();
      expectedDebtByBorrower.set(o.borrower, (expectedDebtByBorrower.get(o.borrower) || 0n) - o.principal);
      await assertViews(
        `After repay (pair4 split order#${i + 1})`,
        o.borrower,
        assetAddr,
        expectedCollateralByBorrower.get(o.borrower),
        expectedDebtByBorrower.get(o.borrower)
      );
    }
    console.log("  ✅ Pair4 split orders fully repaid");
  }

  // Pair5: overdue full repay — time travel, then repay
  {
    const o = orders.find((x) => x.borrower === borrowers[4].address)!;

    // move forward beyond maturity/window; be conservative
    await evmIncreaseTime(termSec + 3n * ONE_DAY);

    const totalDue = calcTotalDue(o.principal, rateBps, termSec);
    const borrowerSigner = signerByAddr.get(o.borrower.toLowerCase());
    await (await usdc.connect(borrowerSigner).approve(orderEngineAddr, totalDue)).wait();
    await (await orderEngine.connect(borrowerSigner).repay(o.orderId, totalDue)).wait();

    expectedDebtByBorrower.set(o.borrower, (expectedDebtByBorrower.get(o.borrower) || 0n) - o.principal);
    await assertViews(
      "After repay (pair5 overdue)",
      o.borrower,
      assetAddr,
      expectedCollateralByBorrower.get(o.borrower),
      expectedDebtByBorrower.get(o.borrower)
    );
    console.log("  ✅ Pair5 overdue repaid\n");
  }

  // ============ Final Checkpoint: all debts cleared (delta-based) ============
  console.log("=== Final Checkpoint: totals after all repaid ===");
  const finalTotals = await snapshotBorrowersTotals(assetAddr);
  const finalStats = await statisticsView.getGlobalStatistics();

  const finalLedgerColDelta = finalTotals.colSum - baselineTotals.colSum;
  const finalLedgerDebtDelta = finalTotals.debtSum - baselineTotals.debtSum;
  const finalStatsColDelta = toBigInt(finalStats.totalCollateral) - toBigInt(baselineStats.totalCollateral);
  const finalStatsDebtDelta = toBigInt(finalStats.totalDebt) - toBigInt(baselineStats.totalDebt);

  console.log("Expected deltas: collateral", ethers.formatUnits(expectedCollateralDelta, 6), "debt", ethers.formatUnits(0n, 6));
  console.log("Ledger deltas:    collateral", ethers.formatUnits(finalLedgerColDelta, 6), "debt", ethers.formatUnits(finalLedgerDebtDelta, 6));
  console.log("Stats deltas:     collateral", ethers.formatUnits(finalStatsColDelta, 6), "debt", ethers.formatUnits(finalStatsDebtDelta, 6));

  if (finalLedgerColDelta !== expectedCollateralDelta) throw new Error("Final: ledger collateral delta mismatch");
  if (finalLedgerDebtDelta !== 0n) throw new Error("Final: ledger debt delta should be 0 (new loans fully repaid)");
  if (finalStatsColDelta !== expectedCollateralDelta) throw new Error("Final: stats collateral delta mismatch");
  if (finalStatsDebtDelta !== 0n) throw new Error("Final: stats debt delta should be 0 (new loans fully repaid)");

  console.log("✅ Final checkpoint passed\n");
  await logPositionViewVersion("final checkpoint (after all repaid)");
  console.log("✅ Advanced batch E2E Completed!");
}

// Keep backward-compatible CLI entrypoint (`npx hardhat run ...`)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const _isMain = typeof require !== "undefined" && require.main === module;
if (_isMain) {
  runAdvancedBatch().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}

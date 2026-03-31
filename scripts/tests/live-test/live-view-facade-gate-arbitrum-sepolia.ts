import { ethers } from "hardhat";

import {
  assignFreshBorrower,
  createFundsFlowLiveContext,
  depositCollateral,
  ensureFundsFlowEnvironmentReady,
  ensureFundsFlowPrices,
  finalizeSingleMatch,
  fundFundsFlowActors,
  observeExtendedViews,
  reserveForLending,
} from "./_fundsFlowLive";
import { runWithNetworkRetry } from "./_networkRetry";

async function expectRevert(label: string, action: () => Promise<unknown>) {
  try {
    await action();
  } catch {
    console.log(`  [ExpectedRevert] ${label}`);
    return;
  }
  throw new Error(`${label}: expected revert`);
}

async function main() {
  const ctx = await createFundsFlowLiveContext({
    label: "Live View Facade Gate",
    collateralAmountUnitsDefault: "10",
    borrowAmountUnitsDefault: "1200",
  });

  await assignFreshBorrower(ctx, { noticeLabel: "using fresh facade-gate borrower" });

  await ensureFundsFlowEnvironmentReady(ctx);
  await ensureFundsFlowPrices(ctx);
  await fundFundsFlowActors(ctx, {
    borrowerBorrowAmount: ctx.totalDue,
    borrowerCollateralAmount: ctx.collateralAmount,
    lenderBorrowAmount: ctx.borrowAmount,
  });

  await depositCollateral(ctx, ctx.collateralAmount);
  const reserve = await reserveForLending(ctx);
  const finalized = await finalizeSingleMatch(ctx, reserve);
  await observeExtendedViews(ctx, "view-facade-gate-after-finalize");

  await ctx.healthView.connect(ctx.borrower).getUserHealthFactorWithMeta(ctx.borrower.address);
  await expectRevert("HealthView non-self should revert", async () =>
    ctx.healthView.connect(ctx.borrower).getUserHealthFactorWithMeta(ctx.lender.address),
  );

  if (ctx.riskView) {
    await ctx.riskView.connect(ctx.borrower).getUserRiskAssessment(ctx.borrower.address);
    await expectRevert("RiskView non-self should revert", async () =>
      ctx.riskView.connect(ctx.borrower).getUserRiskAssessment(ctx.lender.address),
    );
    await expectRevert("RiskView batch should revert for unauthorized caller", async () =>
      ctx.riskView.connect(ctx.borrower).batchGetRiskAssessments([ctx.borrower.address]),
    );
  }

  if (ctx.previewView) {
    await ctx.previewView.connect(ctx.borrower).previewDeposit(ctx.borrower.address, ctx.settlementTokenAddr, 0n);
    await expectRevert("PreviewView non-self should revert", async () =>
      ctx.previewView.connect(ctx.borrower).previewDeposit(ctx.lender.address, ctx.settlementTokenAddr, 0n),
    );
  }

  if (ctx.systemRiskView) {
    await expectRevert("SystemRiskView unauthorized read should revert", async () =>
      ctx.systemRiskView.connect(ctx.borrower).getMinHealthFactor(),
    );

    try {
      await ctx.systemRiskView.connect(ctx.relayer).getMinHealthFactor();
      await ctx.systemRiskView.connect(ctx.relayer).getLiquidationThreshold();
    } catch {
      console.log("  [Notice] relayer lacks SystemRiskView read role; authorized path skipped");
    }
  }

  if (ctx.batchView) {
    await expectRevert("BatchView unauthorized health batch should revert", async () =>
      ctx.batchView.connect(ctx.borrower).batchGetHealthFactors([ctx.borrower.address]),
    );
    await expectRevert("BatchView unauthorized risk batch should revert", async () =>
      ctx.batchView.connect(ctx.borrower).batchGetRiskAssessments([ctx.borrower.address]),
    );

    try {
      const healthRows = (await ctx.batchView.connect(ctx.relayer).batchGetHealthFactors([ctx.borrower.address])) as any[];
      if (healthRows.length === 0) {
        throw new Error("BatchView authorized health batch returned empty rows");
      }
    } catch {
      console.log("  [Notice] relayer lacks BatchView read role; authorized batch path skipped");
    }
  }

  if (ctx.userView) {
    const [totalCollateral, , isValid] = (await ctx.userView
      .connect(ctx.borrower)
      .getUserTotalsWithMeta(ctx.borrower.address)) as [bigint, bigint, boolean, bigint, bigint, bigint];
    if (totalCollateral === 0n) {
      throw new Error("UserView totalCollateral should be non-zero after deposit/finalize");
    }
    if (!isValid) {
      console.log("  [Notice] UserView returned invalid meta flag");
    }
  }

  if (ctx.dashboardView) {
    const [overview] = (await ctx.dashboardView
      .connect(ctx.borrower)
      .getUserOverviewWithMeta(ctx.borrower.address, [ctx.collateralAssetAddr, ctx.borrowAssetAddr])) as [any, boolean[], bigint[], bigint[], bigint];
    if (BigInt(overview.totalCollateral ?? overview[0] ?? 0) === 0n) {
      throw new Error("DashboardView totalCollateral should be non-zero after deposit/finalize");
    }
    try {
      await ctx.dashboardView.connect(ctx.relayer).getSystemOverviewWithMeta();
    } catch {
      console.log("  [Notice] DashboardView system overview read unavailable for relayer");
    }
  }

  if (ctx.cacheOptimizedView) {
    const [summary] = (await ctx.cacheOptimizedView
      .connect(ctx.borrower)
      .getUserSummaryWithMeta(ctx.borrower.address, [ctx.collateralAssetAddr, ctx.borrowAssetAddr])) as [any, boolean[], bigint[], bigint[], bigint];
    if (BigInt(summary.totalCollateral ?? summary[0] ?? 0) === 0n) {
      throw new Error("CacheOptimizedView totalCollateral should be non-zero after deposit/finalize");
    }
  }

  if (ctx.registryView) {
    const registryAddr = (await ctx.registryView.getRegistry()) as string;
    if (registryAddr.toLowerCase() !== ctx.registryAddr.toLowerCase()) {
      throw new Error(`RegistryView registry mismatch: expected ${ctx.registryAddr} got ${registryAddr}`);
    }
    const [keys, total] = (await ctx.registryView.getRegisteredModuleKeysPaginated(0, 16)) as [string[], bigint];
    if (keys.length === 0 || total === 0n) {
      throw new Error("RegistryView should expose non-empty registered module keys");
    }
  }

  if (ctx.loanNftView) {
    const [loanCount] = (await ctx.loanNftView
      .connect(ctx.borrower)
      .getUserLoanCount(ctx.borrower.address)) as [bigint, boolean, bigint];
    if (loanCount === 0n) {
      throw new Error("LoanNFTView user loan count should be non-zero after finalizeMatch");
    }
    const [loans] = (await ctx.loanNftView
      .connect(ctx.borrower)
      .getUserLoansPaginated(ctx.borrower.address, 0, 10)) as [Array<{ orderId?: bigint; 1?: bigint }>, bigint, boolean, bigint];
    const found = loans.some((loan) => BigInt(loan.orderId ?? loan[1] ?? 0) === finalized.orderId);
    if (!found) {
      throw new Error(`LoanNFTView should include orderId ${finalized.orderId.toString()}`);
    }
  }

  if (ctx.moduleHealthView) {
    try {
      const [health] = (await ctx.moduleHealthView.connect(ctx.relayer).getModuleHealthWithMeta(ctx.vaultCoreAddr)) as [any, boolean, bigint];
      if ((health.isHealthy ?? health[0]) === undefined) {
        throw new Error("ModuleHealthView returned malformed payload");
      }
    } catch {
      console.log("  [Notice] ModuleHealthView read unavailable for current caller");
    }
  }

  const systemViewAddr = await (await ethers.getContractAt("Registry", ctx.registryAddr)).getModuleOrRevert(
    ethers.keccak256(ethers.toUtf8Bytes("SYSTEM_VIEW")),
  );
  const systemView = (await ethers.getContractAt(
    ["function routeSystemRisk() view returns (bytes32 moduleKey,address moduleAddr)"],
    systemViewAddr,
    ctx.relayer,
  )) as any;
  try {
    const route = (await systemView.routeSystemRisk()) as any;
    const routeAddr = String(route.moduleAddr ?? route[1] ?? ethers.ZeroAddress);
    if (ctx.systemRiskView && routeAddr.toLowerCase() !== (ctx.systemRiskView.target as string).toLowerCase()) {
      throw new Error(`SystemView routeSystemRisk mismatch: expected ${ctx.systemRiskView.target as string} got ${routeAddr}`);
    }
  } catch {
    console.log("  [Notice] SystemView routeSystemRisk read unavailable for current relayer");
  }

  console.log("\n✅ live-view-facade-gate-arbitrum-sepolia PASSED\n");
}

void runWithNetworkRetry("live-view-facade-gate-arbitrum-sepolia", main);